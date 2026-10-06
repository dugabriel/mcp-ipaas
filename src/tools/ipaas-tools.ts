import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IpaasConfig } from "../config/config.js";
import type { SessionStore } from "../session/session-store.js";
import type { IpaasApiClient } from "../api/ipaas-api-client.js";
import type { IpaasAuthService } from "../auth/ipaas-auth-service.js";
import type { PendingLogin } from "../auth/pending-login.js";
import type { IpaasSession } from "../model/types.js";
import { LoginFailedError } from "../auth/login-failed-error.js";
import { jsonResponse, errorResponse } from "../util/tool-response.js";
import { remainingMs, formatRemaining } from "./tool-helpers.js";
import { registerMonitorTools } from "./ipaas-monitor-tools.js";

export interface ToolDeps {
  config: IpaasConfig;
  sessionStore: SessionStore;
  apiClient: IpaasApiClient;
  authService: IpaasAuthService;
}

/** Estado compartilhado entre iniciar_login_ipaas e confirmar_empresa. */
export interface LoginState {
  pending: PendingLogin | undefined;
}

export function registerIpaasTools(server: McpServer, deps: ToolDeps): LoginState {
  const { config, sessionStore, authService } = deps;
  const loginState: LoginState = { pending: undefined };
  const now = () => Date.now();

  server.registerTool(
    "iniciar_login_ipaas",
    {
      description:
        "Abre uma janela visivel do navegador para o login manual (SSO/MFA) no TOTVS iPaaS. " +
        "O usuario deve logar e selecionar a empresa desejada; em seguida, chamar a tool " +
        "confirmar_empresa para capturar a sessao. Nao captura o token automaticamente e nunca o expoe.",
      inputSchema: {},
    },
    async () => {
      try {
        if (sessionStore.state() === "ATIVA") {
          return jsonResponse({
            status: "ACTIVE_SESSION",
            message:
              "Ja existe uma sessao ativa com o TOTVS iPaaS. Para renovar, inicie um novo login apenas se desejar; a sessao atual permanece valida.",
            note: "O navegador nao foi reaberto automaticamente.",
          });
        }
        if (loginState.pending && !loginState.pending.expired()) {
          return jsonResponse({
            status: "PENDING_LOGIN",
            message:
              "Ja existe um login em andamento com o navegador aberto. Conclua o login, selecione a empresa e chame `confirmar_empresa`.",
            nextStep: "confirmar_empresa",
          });
        }
        loginState.pending = await authService.beginLogin(config.loginTimeoutMs);
        return jsonResponse({
          status: "PENDING_LOGIN",
          message:
            "Navegador aberto. Faca login no TOTVS iPaaS, selecione a empresa desejada e, em seguida, chame a tool `confirmar_empresa` para capturar a sessao.",
          nextStep: "confirmar_empresa",
          note: "A sessao so sera capturada apos confirmar_empresa; o token nunca e exposto.",
        });
      } catch (err) {
        return errorResponse("Failed to start iPaaS login", err);
      }
    },
  );

  server.registerTool(
    "confirmar_empresa",
    {
      description:
        "Confirma que o usuario ja selecionou a empresa correta na janela aberta por iniciar_login_ipaas " +
        "e captura a sessao do TOTVS iPaaS. Valida a sessao, armazena-a em memoria, fecha o navegador e " +
        "retorna o estado, o instante de captura e o tempo de vida. Nunca expoe o token.",
      inputSchema: {},
    },
    async () => {
      try {
        const pending = loginState.pending;
        if (!pending || pending.expired()) {
          loginState.pending = undefined;
          return jsonResponse({
            status: "NO_PENDING_LOGIN",
            message:
              "Nenhum login em andamento. Chame a tool `iniciar_login_ipaas` para abrir o navegador, fazer login e selecionar a empresa antes de confirmar.",
            nextStep: "iniciar_login_ipaas",
          });
        }
        let session: IpaasSession;
        try {
          session = await authService.confirm(pending);
        } catch (err) {
          loginState.pending = undefined;
          if (err instanceof LoginFailedError) {
            return jsonResponse({
              status: "INCOMPLETE_LOGIN",
              message:
                "Nao foi possivel capturar a sessao: conclua o login e selecione a empresa, ou reinicie com `iniciar_login_ipaas`.",
              detail: err.message,
              nextStep: "iniciar_login_ipaas",
            });
          }
          throw err;
        }
        if (!(await authService.validate(session))) {
          loginState.pending = undefined;
          return jsonResponse({
            status: "INVALID_SESSION",
            message:
              "A sessao capturada nao foi validada pelo iPaaS e nao foi armazenada. Reinicie o login com `iniciar_login_ipaas`.",
            nextStep: "iniciar_login_ipaas",
          });
        }
        sessionStore.set(session);
        loginState.pending = undefined;
        const remaining = remainingMs(session, now());
        return jsonResponse({
          state: "ATIVA",
          message: "Empresa confirmada e sessao capturada. O navegador foi encerrado.",
          capturedAt: new Date(session.capturedAt).toISOString(),
          remainingTime: formatRemaining(remaining),
          remainingTimeSeconds: Math.floor(remaining / 1000),
        });
      } catch (err) {
        loginState.pending = undefined;
        return errorResponse("Failed to confirm the company and capture the session", err);
      }
    },
  );

  server.registerTool(
    "status_sessao",
    {
      description:
        "Retorna o estado da sessao com o TOTVS iPaaS (ATIVA, EXPIRADA ou AUSENTE). Valida a sessao com uma " +
        "chamada leve a API (nao se baseia apenas no tempo), pois a sessao pode expirar no servidor antes do " +
        "prazo estimado. Nunca expoe o token.",
      inputSchema: {},
    },
    async () => {
      try {
        const session = sessionStore.current();
        if (!session) {
          return inactiveResponse("AUSENTE");
        }
        // Valida de verdade contra a API: a sessao pode cair no servidor antes do TTL estimado.
        const valid = await authService.validate(session);
        if (!valid) {
          sessionStore.clear();
          return inactiveResponse("EXPIRADA");
        }
        const remaining = remainingMs(session, now());
        return jsonResponse({
          state: "ATIVA",
          capturedAt: new Date(session.capturedAt).toISOString(),
          estimatedRemainingTime: formatRemaining(remaining),
          estimatedRemainingTimeSeconds: Math.floor(remaining / 1000),
          note: "Tempo restante e uma estimativa; a sessao foi validada agora contra a API do iPaaS.",
        });
      } catch (err) {
        return errorResponse("Failed to query the session state", err);
      }
    },
  );

  function inactiveResponse(state: "EXPIRADA" | "AUSENTE") {
    return jsonResponse({
      state,
      message:
        "Nenhuma sessao utilizavel. Chame a tool `iniciar_login_ipaas` para abrir o navegador e capturar uma nova sessao.",
      nextStep: "iniciar_login_ipaas",
    });
  }

  registerMonitorTools(server, deps);
  return loginState;
}
