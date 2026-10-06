# ipaas-mcp-server

Servidor **MCP (Model Context Protocol)** em **Node.js/TypeScript**, transporte **STDIO**, para
**automatizar e monitorar o TOTVS iPaaS** a partir de um host de LLM (Kiro, Claude Desktop, Cursor, etc.).

O login é **manual** (SSO/MFA): o servidor abre uma janela visível do Chromium (via Playwright), o
usuário autentica e **seleciona a empresa**, e então o servidor **captura a sessão** e expõe as
capacidades do iPaaS como **tools MCP**. O token e os cookies ficam **apenas em memória** e são
**mascarados** em qualquer log.

- Front: `https://ipaas.totvs.app` · API: `https://api-ipaas.totvs.app`
- Autenticação: cookie `jwt.token` enviado como `Authorization: Bearer <token>`

## Instalação rápida (via npx)

Adicione o servidor na configuração MCP do seu host. Exemplo (formato `mcpServers`):

```json
{
  "mcpServers": {
    "ipaas": {
      "command": "npx",
      "args": ["-y", "ipaas-mcp-server"]
    }
  }
}
```

A **mesma configuração funciona em Windows, macOS e Linux**, sem ajustes.

> **Login gráfico:** o login abre uma janela do Chromium. No **Windows/macOS** funciona direto.
> No **Linux (desktop X11/Wayland)**, o servidor **detecta automaticamente** o display
> (`DISPLAY`/`XAUTHORITY`); não é preciso configurar nada. Se o seu ambiente usar um display
> fora do padrão, você ainda pode forçar via `env` (`"DISPLAY": ":1"`, etc.). Em **Linux headless**
> (sem interface gráfica, ex.: servidor/SSH/container), o login manual não é possível — rode o
> servidor numa máquina com desktop.

No **Kiro**, a config fica em `.kiro/settings/mcp.json` (workspace) ou `~/.kiro/settings/mcp.json` (usuário).

### Chromium (Playwright)

O login precisa do Chromium do Playwright. O servidor **baixa automaticamente** na primeira vez que o
login é acionado (uma única vez). Se preferir pré-instalar ou se o download automático falhar:

```bash
npx playwright install chromium
```

## Uso a partir do código-fonte

```bash
git clone https://github.com/dugabriel/mcp-ipaas.git
cd mcp-ipaas
npm install
npm run build
npm start          # roda dist/index.js em STDIO
npm test           # suíte de testes (vitest)
npm run smoke      # teste manual do protocolo (initialize + tools/list)
```

Config apontando para o build local:

```json
{
  "mcpServers": {
    "ipaas": {
      "command": "node",
      "args": ["/caminho/para/mcp-ipaas/dist/index.js"],
      "env": { "DISPLAY": ":0" }
    }
  }
}
```

## Fluxo de login multiempresa

O token muda a cada troca de empresa, então o login é em dois passos:

1. **`iniciar_login_ipaas`** — abre o navegador. O usuário faz login (SSO/MFA) e **seleciona a empresa**.
2. **`confirmar_empresa`** — captura o token da empresa selecionada, **valida** a sessão, armazena em
   memória e fecha o navegador.
3. **`status_sessao`** — valida a sessão contra a API e informa `ATIVA`/`EXPIRADA`/`AUSENTE`.

## Tools disponíveis

| Tool | Descrição |
| --- | --- |
| `iniciar_login_ipaas` | Abre o navegador para login manual; orienta a selecionar a empresa e chamar `confirmar_empresa`. |
| `confirmar_empresa` | Captura e valida a sessão após a seleção da empresa; fecha o navegador. |
| `status_sessao` | Valida a sessão contra a API e retorna o estado (sem expor o token). |
| `analisar_mensagem_erro` | Estrutura um log/payload de erro; destaca status, errorStack, message, messageId. Não exige sessão. |
| `listar_fluxos` | Lista integrações (id, diagramId, nome, status). Suporta `pageSize` (padrão 200). |
| `listar_mensagens` | Amostra de mensagens do Monitor por período, status, `integrationIds`, `projectIds` e `sourceTypes`. Teto de 100/chamada; pagina por janela de tempo (`nextWindow`). |
| `detalhar_mensagem` | Detalhe de uma mensagem por id (status, tempos, componentes, erro). Distingue DONE de ERROR. |
| `detalhar_steps` | Steps de execução de uma mensagem; destaca o componente e o erro, sem expor headers sensíveis. |
| `resumir_erros` | Agrega os erros do período por componente/fluxo, com contagem ordenada. |
| `listar_mensagens_filhas` | Mensagens filhas (SPLITTED) de uma mensagem original (`originMessageId`). |
| `resumo_por_status` | Contagem de mensagens por status num período (barato, sem baixar as mensagens). |

> **Teto de amostragem:** leituras de coleção do Monitor têm teto rígido de **100 por chamada**;
> para amostras maiores, pagine por janela de tempo (campo `nextWindow` na resposta).

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `IPAAS_FRONT_URL` | `https://ipaas.totvs.app` | URL do front usada no login. |
| `IPAAS_API_BASE_URL` | `https://api-ipaas.totvs.app` | URL base da API. |
| `IPAAS_LOGIN_TIMEOUT_MS` | `120000` | Tempo máximo de espera pelo login (ms). |
| `IPAAS_SESSION_TTL_MS` | `172800000` | TTL estimado da sessão (48h, ms). |
| `IPAAS_MONITOR_DEFAULT_LIMIT` | `20` | Amostra padrão quando `limit` não é informado. |
| `IPAAS_MONITOR_MAX_LIMIT` | `100` | Teto rígido de registros por chamada. |
| `IPAAS_MONITOR_DEFAULT_WINDOW_MS` | `86400000` | Janela padrão (24h, ms) quando as datas são omitidas. |
| `IPAAS_DEV_TOOLS` | — | `1` ativa tools de desenvolvimento para mapear novas APIs (`_debug_get`). |

## Segurança

- Token e cookies ficam **somente em memória**; nunca são gravados em disco.
- O token **nunca é exposto** nas respostas das tools; é **mascarado** nos logs.
- Em STDIO, o **stdout é exclusivo do protocolo JSON-RPC**; todo log vai para stderr.

## Desenvolvimento e mapeamento de APIs

Veja [`API-MAP.md`](./API-MAP.md) para os endpoints do iPaaS já observados e a política de mapeamento
colaborativo (uma API só vira tool depois de observada em chamada real e documentada).

## Licença

MIT
