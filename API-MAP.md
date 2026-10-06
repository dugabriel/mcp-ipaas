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

### GET /ipaas/api/v4/messages/status  (contagem por status)  [A CONFIRMAR corpo]
Query: `initialDate`, `finalDate` (ISO Z), `status` (repetivel). Retorna totais por status (resumo barato).

### GET /ipaas/api/v3/metrics/diagrams-transactions  [A CONFIRMAR corpo]
Query: `initialDate`, `endDate` (YYYY-MM-DD), `forceUpdate`. Metricas de transacoes por diagrama.

### GET /ipaas/api/v3/integrations  (listagem de fluxos)
Query: `page`, `pageSize`, `lastVersion=true`, `fieldsReturn=id,diagramId,name,status`.

### GET /ipaas/api/v3/steps/{integrationId}/{createdDate}/{messageId}  (steps de uma mensagem)
Os tres identificadores vem da LISTAGEM /v4/messages (id, integrationId, createdDate).

### GET /ipaas/api/v2/auth-models?page=1&pageSize=1  (validacao de sessao)
200 = sessao valida.

### PUT /ipaas/api/v3/settings/user-settings/{userId}  (preferencias do usuario) [nao prioritario]

## A mapear
- Corpo de /v4/messages/status e /metrics/diagrams-transactions.
- Endpoints de detalhe de fluxo/diagrama, credenciais/conexoes, agendamentos.

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
- GET /ipaas/api/v4/messages/status (contagem por status) e /v3/metrics/diagrams-transactions (metricas) — corpos a confirmar.

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
