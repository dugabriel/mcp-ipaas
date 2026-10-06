import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isUnauthorized } from "../model/types.js";
import { jsonResponse, missingSession, errorResponse } from "../util/tool-response.js";
import { sessionExpiredOnServer } from "./tool-helpers.js";
import type { ToolDeps } from "./ipaas-tools.js";

const MAX_BODY = 20000;

/**
 * Tools de DESENVOLVIMENTO para mapeamento colaborativo de APIs (Requirement 16).
 *
 * <p>So sao registradas quando IPAAS_DEV_TOOLS=1. Permitem observar endpoints reais do iPaaS
 * ainda nao mapeados, antes de promove-los a tools definitivas. Nao devem ficar ativas em
 * uso normal. Nunca expoem o token (ele vai no header, nunca no corpo retornado).
 */
export function registerDevTools(server: McpServer, deps: ToolDeps): void {
  const { sessionStore, apiClient } = deps;

  server.registerTool(
    "_debug_get",
    {
      description:
        "[DEV] Faz um GET autenticado em um caminho arbitrario da API do iPaaS usando a sessao ativa, " +
        "para mapear endpoints ainda nao suportados. Retorna status e um trecho do corpo. Exige sessao ativa. " +
        "Ferramenta de desenvolvimento; nao use em operacao normal.",
      inputSchema: {
        path: z
          .string()
          .describe("Caminho da API iniciando com /, ex.: /ipaas/api/v3/integrations/{id}."),
      },
    },
    async ({ path }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        if (!path || !path.startsWith("/")) {
          return jsonResponse({
            status: "INVALID_PATH",
            message: "Informe um caminho que comece com '/', ex.: /ipaas/api/v3/integrations.",
          });
        }
        const response = await apiClient.get(path);
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        const body = response.body ?? "";
        const truncated = body.length > MAX_BODY;
        return jsonResponse({
          httpStatus: response.status,
          bodyTruncated: truncated,
          body: truncated ? body.slice(0, MAX_BODY) + "\n...[truncado]" : body,
        });
      } catch (err) {
        return errorResponse("Failed to perform debug GET", err);
      }
    },
  );
}
