# API-MAP — TOTVS iPaaS (observado em chamadas reais)

Documento de mapeamento colaborativo (Requirement 16). Base: `https://api-ipaas.totvs.app`.
Autenticacao: `Authorization: Bearer <jwt.token>` (cookie `jwt.token`).

## Endpoints confirmados (observados via DevTools no front)

### GET /ipaas/api/v4/messages  (listagem do Monitor)
Query real: `page`, `pageSize` (NAO `limit`), `sourceTypes` (repetivel: ORIGINAL, SPLITTED),
`status` (repetivel: PROCESSING, DONE, ERROR, REPROCESSED), `initialDate`, `finalDate` (ISO Z).

Resposta: envelope `{ items: [...], hasNext: boolean, total: number }`.
Campos de cada item:
- `id` (identificador da mensagem — usar como messageId)
- `integrationId`, `diagramId`, `diagramName`, `diagramVersion`
- `projectId`, `projectName`, `projectType`
- `initialComponent`, `finalComponent`
- `createdDate`, `updatedDate` (ISO com offset, ex.: 2026-10-06T20:42:05.483+0000)
- `executionTime` (ms)
- `status` (ERROR | DONE | PROCESSING | REPROCESSED)
- `sourceType` (ORIGINAL | SPLITTED), `reprocess`, `reprocessable`
Observacao: a LISTAGEM NAO traz o stack/erro; o texto do erro vem no DETALHE (campo `message`).

### GET /ipaas/api/v4/messages/{id}  (detalhe de uma mensagem)
Campos: status, executionTime, initialComponent, finalComponent, e `message` (quando ERROR,
o `message` e o proprio stack trace; quando DONE, e o payload enviado). `messageId` nao vem; o id e `id`.

### GET /ipaas/api/v4/messages/status  (contagem por status) — CORPO CONFIRMADO (DevTools 2026-10-07)
Query: `initialDate`, `finalDate` (ISO Z), `status` (repetivel). Aceita tambem `id` (vazio no front).
NAO envia `sourceTypes` na chamada do front. CONFIRMADO (DevTools 2026-10-07, segunda sessao) que a
contagem JA INCLUI ORIGINAL + SPLITTED: no mesmo periodo/status, /v4/messages/status deu total=91843,
batendo com /v4/messages?sourceTypes=ORIGINAL&sourceTypes=SPLITTED (total=91875) e NAO com
/v4/messages?sourceTypes=ORIGINAL (total=82387). A diferenca ~82k vs ~91k sao as mensagens filhas.
Para isolar SO as originais, use /v4/messages com sourceTypes=ORIGINAL e leia o `total` do envelope
(o /status nao e usado com filtro de origem pelo front; nao foi confirmado se o /status respeita
sourceTypes, entao o baseline so-ORIGINAL do panorama_saude usa /v4/messages, que comprovadamente respeita).
Corpo real:
```json
{"messages":[{"status":"PROCESSING","size":2},{"status":"DONE","size":86995},{"status":"ERROR","size":1276}],"total":88273}
```
ATENCAO: o formato e `{ messages: [{status, size}], total }` — NAO e um mapa `{DONE: n, ERROR: n}`.
Status ausentes (ex.: REPROCESSED com zero) simplesmente nao aparecem no array.

### GET /ipaas/api/v3/metrics/commons  (agregado da conta) — CORPO CONFIRMADO (DevTools 2026-10-07)
Query: `refDate` (YYYY-MM-DD), `forceUpdate`. Resumo barato de UMA chamada, agregado da conta inteira.
Inclui `totalMessages`, `totalMessagesSuccess`, `totalMessagesError` (contagem global, aparentemente
incluindo filhas), alem de `planName`, `projects`, `diagrams`, `messagesPerMinute`, `avgExecutionTime`,
`percentUsage`, `maxMessages`.
```json
{"planName":"ENTERPRISE","projects":12,"diagrams":246,"totalMessages":797597,"maxMessages":10000000,"totalMessagesSuccess":781504,"totalMessagesError":16398,"percentUsage":7.97597,"messagesPerMinute":41,"avgExecutionTime":4,...}
```

### GET /ipaas/api/v3/metrics/diagrams-transactions  — CORPO CONFIRMADO (DevTools 2026-10-07)
Query: `initialDate`, `endDate` (YYYY-MM-DD), `forceUpdate`. Total de mensagens POR DIAGRAMA/FLUXO no periodo.
Corpo: `{ totalMessages: number, diagramsTransactions: [{ totalMessages, integrationId, diagramName, projectName }] }`.
Nao traz quebra por status (so volume total por fluxo); util para achar os fluxos de maior volume.
```json
{"totalMessages":9993053,"diagramsTransactions":[{"totalMessages":9022,"integrationId":"01b6...","diagramName":"CPARINTEG-PaginationEconomicGroups","projectName":"Coletora-Plataformas-AR"}, ...]}
```

### GET /ipaas/api/v3/integrations  (listagem de fluxos)
Query: `page`, `pageSize`, `lastVersion=true`, `fieldsReturn=id,diagramId,name,status`.

### GET /ipaas/api/v3/integrations?diagramId={diagramId}&fieldsReturn=...,flow,...  (ESTRUTURA do diagrama) — CONFIRMADO (DevTools 2026-10-07)
Query observada: `diagramId`, `fieldsReturn=id,diagramId,flow,dynamicIcons,icons,name,active,description,sketchVersion,publishVersion,status,templateVersion,createdDate,userId,userName`, `pageSize=9999`, `expand=project`.
Envelope `{ items: [...], hasNext }`. Cada item e um diagrama/integracao e o campo `flow` traz o MAPEAMENTO
COMPLETO da diagramacao (a "planta" do fluxo). Estrutura do `flow`:
- `start`: id do no inicial.
- `activities`: mapa { nodeId -> no }. Cada no: `id`, `type` (WEBHOOK, REST, JOLT, CONDITION, GENERATOR,
  DIAGRAM_CALLER, MAIL, GLOBAL_ERROR, ...), `label` (legivel), `name`, `componentId`/`serviceId`,
  `connections: { next:[ids], previous:[ids], finalConnections:[{connectionId, connectionPath(SVG)}] }`,
  `positions` (coords no builder) e `configurations` (DETALHES SENSIVEIS: urls REST, specs Jolt, headers,
  accountId, condicoes, e no MAIL ha e-mails de pessoas).
- `functions`: mapa de funcoes intermediarias (ex.: FUNCTION_AGGREGATE) com `connections`.
- `globalErrorFlow`: subfluxo de tratamento de erro do diagrama ({ start, activities }), quando existe.
Metadados do item: `name`, `description`, `publishVersion`, `sketchVersion`, `status` (PUBLISHED/...),
`active`, `icons` (nos de inicio/aplicacoes), `project` (via expand), `userName`.
USO para tool `avaliar_diagrama`: reconstruir a topologia (percorrer `start` -> `connections.next`),
listar componentes por tipo/label, detectar presenca de `globalErrorFlow` (tratamento de erro),
nos orfaos (sem next/previous), Diagram Callers (dependencias entre diagramas), status/versao.
ATENCAO SEGURANCA: extrair SO a topologia (type/label/connections/flags). NAO expor `configurations`
cru (contem urls, specs, headers, accountId e e-mails de pessoas no MAIL) — mesmo cuidado dos steps.

### GET /ipaas/api/v4/messages/filters  (filtros disponiveis do Monitor) — confirmado
Sem query. Retorna integracoes e projetos que alimentam integrationIds/projectIds em /v4/messages.
Estrutura: { integrationsFilters: { publishedIntegrations[], archivedIntegrations[] (id,name,projectId,reprocessable) },
  projectsFilter: { activateProjects[], deactivateProjects[], activatePackages[], deactivatePackages[] (id,name) } }.
Tool `listar_filtros_disponiveis` normaliza em integrations (id,name,projectId,archived) e projects (id,name,active),
com busca por nome (`search`) e teto por tipo (`limit`).

### GET /ipaas/api/v3/steps/{integrationId}/{createdDate}/{messageId}  (steps de uma mensagem)
Os tres identificadores vem da LISTAGEM /v4/messages (id, integrationId, createdDate).

### GET /ipaas/api/v2/auth-models?page=1&pageSize=1  (validacao de sessao)
200 = sessao valida.

### PUT /ipaas/api/v3/settings/user-settings/{userId}  (preferencias do usuario) [nao prioritario]

## A mapear
- Endpoints de detalhe de fluxo/diagrama, credenciais/conexoes, agendamentos.
  (Corpos de /v4/messages/status, /v3/metrics/commons e /v3/metrics/diagrams-transactions ja confirmados — ver acima.)

## Descobertas adicionais (navegacao DevTools, telas de detalhe/splitter)

### GET /ipaas/api/v3/steps/{integrationId}/{createdDate}/{messageId}
- `createdDate` no path e o timestamp COMPLETO ISO com offset: ex. 2026-10-06T20:42:05.483+00:00.
- Envelope `{ items, hasNext }`. Cada step: messageId, componentId, `componentDTO` {id,name,iconId,iconUrl},
  activityLabel, inMessage, outMessage, status, startDate, endDate, resourceType (QUARTZ|REST|...), functions, condition.
- No step ERROR, o erro aparece em `outMessage` (ex.: <am:fault ...>).
- ATENCAO SEGURANCA: inHeaders/outHeaders contem `Authorization` e dados sensiveis — NAO expor crus.

### GET /ipaas/api/v4/messages?sourceTypes=SPLITTED&originMessageId={id}&...  (mensagens filhas de um Splitter)
- Lista as mensagens derivadas (SPLITTED) de uma mensagem original, via `originMessageId`.
- Mesmo envelope { items, hasNext, total } do /v4/messages.

### Auth/contexto (connector-auth) — util para multi-empresa
- GET /connector-auth/api/v1/roles/by-user-tenant?userCode=..&tenantCode=..
- GET /connector-auth/api/v1/tenants/{tenantCode}/by-code
- GET /connector-auth/api/v1/access/{tenantCode}/{userCode}

### Outros
- POST /ipaas/api/v3/visualization-audits (auditoria de visualizacao; nao prioritario)
- GET /ipaas/api/v4/messages/status (contagem por status) e /v3/metrics/diagrams-transactions (metricas) — corpos confirmados (ver acima).

## Hierarquia de mensagens splitted (navegacao confirmada)
- UI: /message/{idFilha}?messages={idOriginal}
- Detalhe da filha: GET /v4/messages/{idFilha}
- Steps da filha: GET /v3/steps/{integrationId}/{createdDate_DA_FILHA}/{idFilha}
  -> integrationId e o MESMO do pai; createdDate e messageId sao os da propria filha.
- Filhas de uma filha (splitter aninhado): GET /v4/messages?sourceTypes=SPLITTED&originMessageId={idFilha}
- Conclusao: integrationId + createdDate + id de QUALQUER mensagem (pai ou filha) vem da listagem
  /v4/messages, entao detalhar_steps pode ser alimentado direto da listagem para qualquer mensagem.

## Filtros do Monitor (GET /ipaas/api/v4/messages) — confirmados
Parametros aceitos: page, pageSize, initialDate, finalDate,
- status (repetivel): DONE, ERROR, PROCESSING, REPROCESSED
- sourceTypes (repetivel): ORIGINAL, SPLITTED
- integrationIds (repetivel): filtra por fluxo/integracao
- projectIds (repetivel): filtra por projeto
Fonte dos ids de filtro: GET /ipaas/api/v4/messages/filters ->
  { integrationsFilters: { publishedIntegrations[], archivedIntegrations[] (id,name,projectId,reprocessable) },
    projectsFilter: { activateProjects[], deactivateProjects[], activatePackages[], deactivatePackages[] (id,name) } }
