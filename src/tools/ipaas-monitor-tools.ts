import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isOk, isUnauthorized, type MessageQuery } from "../model/types.js";
import { jsonResponse, missingSession, errorResponse } from "../util/tool-response.js";
import type { ToolDeps } from "./ipaas-tools.js";
import {
  integrationsPath,
  MESSAGE_DETAIL_PATH,
  STEPS_PATH,
  TRACEABILITY_FIELDS,
  tryParseJson,
  textOrUndefined,
  arrayItems,
  summarizeBody,
  sessionExpiredOnServer,
  requestFailed,
  parseIsoDate,
  extractItemTimestamp,
  normalizeMessageFilters,
  filterByName,
} from "./tool-helpers.js";

const isoHint = "ISO-8601 com sufixo Z, ex.: 2024-01-01T00:00:00Z";

export function registerMonitorTools(server: McpServer, deps: ToolDeps): void {
  const { config, sessionStore, apiClient } = deps;

  server.registerTool(
    "analisar_mensagem_erro",
    {
      description:
        "Analisa um log ou payload de erro do TOTVS iPaaS e retorna uma versao estruturada. Quando o " +
        "conteudo e JSON, extrai e destaca campos de rastreabilidade (status, errorStack, message, messageId). " +
        "Quando nao e JSON, retorna o texto tratado. Nao exige sessao ativa.",
      inputSchema: { payloadLog: z.string().describe("Log ou payload de erro a analisar (JSON ou texto).") },
    },
    async ({ payloadLog }) => {
      try {
        if (!payloadLog || payloadLog.trim() === "") {
          return jsonResponse({
            status: "EMPTY_PAYLOAD",
            message:
              "Nenhum conteudo informado. Envie o log ou payload de erro (JSON ou texto). Em JSON, campos como status, errorStack, message e messageId sao destacados.",
            example: '{"status":"ERROR","messageId":"abc-123","errorStack":"..."}',
          });
        }
        const parsed = tryParseJson(payloadLog);
        if (!parsed) {
          return jsonResponse({
            format: "TEXT",
            message: "O conteudo nao e JSON valido; segue o texto tratado para analise.",
            text: payloadLog.trim(),
          });
        }
        const highlights: Record<string, unknown> = {};
        for (const field of TRACEABILITY_FIELDS) {
          const value = textOrUndefined(parsed, field);
          if (value !== undefined) highlights[field] = value;
        }
        return jsonResponse({
          format: "JSON",
          traceabilityFields:
            Object.keys(highlights).length === 0 ? "Nenhum campo conhecido encontrado" : highlights,
          payload: parsed,
        });
      } catch (err) {
        return errorResponse("Failed to analyze the error message", err);
      }
    },
  );

  server.registerTool(
    "listar_fluxos",
    {
      description:
        "Lista os fluxos (integracoes) do TOTVS iPaaS da sessao ativa, com id, diagramId, nome e status de " +
        "cada um. Por padrao retorna ate 200; use pageSize para ajustar. Exige sessao ativa; se nao houver, " +
        "orienta chamar iniciar_login_ipaas. Nunca expoe o token.",
      inputSchema: {
        pageSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Quantidade maxima de fluxos a retornar (padrao 200)."),
      },
    },
    async ({ pageSize }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        const effectivePageSize = pageSize && pageSize > 0 ? pageSize : 200;
        const response = await apiClient.get(integrationsPath(effectivePageSize));
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel listar os fluxos do iPaaS.");
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        const flows = arrayItems(root).map((flow) => ({
          id: textOrUndefined(flow, "id") ?? null,
          diagramId: textOrUndefined(flow, "diagramId") ?? null,
          name: textOrUndefined(flow, "name") ?? null,
          status: textOrUndefined(flow, "status") ?? null,
        }));
        return jsonResponse({ count: flows.length, flows });
      } catch (err) {
        return errorResponse("Failed to list iPaaS flows", err);
      }
    },
  );

  server.registerTool(
    "listar_filtros_disponiveis",
    {
      description:
        "Lista os filtros disponiveis do Monitor do TOTVS iPaaS: integracoes e projetos que podem ser usados " +
        "como filtro em listar_mensagens (integrationIds, projectIds). Use para descobrir o id de uma integracao " +
        "ou projeto pelo nome e, a partir dele, aprofundar a investigacao de um fluxo/diagrama. Parametro opcional " +
        "'search' filtra integracoes e projetos por nome (case-insensitive). Teto de resultados por tipo para nao " +
        "estourar o contexto; quando truncado, refine com 'search'. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Texto para filtrar integracoes e projetos por nome (case-insensitive)."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Teto de resultados por tipo (integracoes e projetos). Padrao 50."),
      },
    },
    async ({ search, limit }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        const response = await apiClient.getMessageFilters();
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) {
          return requestFailed(response, "Nao foi possivel listar os filtros disponiveis do Monitor do iPaaS.");
        }
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        const { integrations, projects } = normalizeMessageFilters(root);
        const matchedIntegrations = filterByName(integrations, search);
        const matchedProjects = filterByName(projects, search);
        const cap = limit && limit > 0 ? limit : 50;
        const integrationsPage = matchedIntegrations.slice(0, cap);
        const projectsPage = matchedProjects.slice(0, cap);
        const truncated = matchedIntegrations.length > cap || matchedProjects.length > cap;
        const result: Record<string, unknown> = {
          search: search?.trim() ?? null,
          integrations: {
            count: integrationsPage.length,
            total: matchedIntegrations.length,
            items: integrationsPage,
          },
          projects: {
            count: projectsPage.length,
            total: matchedProjects.length,
            items: projectsPage,
          },
          truncated,
        };
        if (truncated) {
          result.refineHint =
            `Mais de ${cap} resultados em algum tipo. Use 'search' para filtrar por nome ` +
            "ou aumente 'limit'. Com o id em maos, chame listar_mensagens com integrationIds/projectIds.";
        }
        return jsonResponse(result);
      } catch (err) {
        return errorResponse("Failed to list iPaaS monitor filters", err);
      }
    },
  );

  server.registerTool(
    "listar_mensagens",
    {
      description:
        "Lista uma amostra de mensagens de execucao do Monitor do TOTVS iPaaS por periodo, status e filtros. " +
        "Exige sessao ativa. Filtros: status (um ou varios: ERROR, DONE, PROCESSING, REPROCESSED), " +
        "integrationIds (filtra por fluxo/integracao), projectIds (filtra por projeto) e sourceTypes " +
        "(ORIGINAL e/ou SPLITTED; padrao ORIGINAL). Quando as datas nao sao informadas, usa a janela padrao " +
        "(ultimas 24h). Teto rigido de 100 por chamada; quando 'truncated' for true, a resposta traz 'nextWindow' " +
        "(chame de novo com esse finalDate e o mesmo initialDate) para paginar. Nunca expoe o token.",
      inputSchema: {
        status: z
          .array(z.string())
          .optional()
          .describe("Status a filtrar (um ou varios): ERROR, DONE, PROCESSING, REPROCESSED."),
        integrationIds: z
          .array(z.string())
          .optional()
          .describe("Ids de integracao/fluxo para filtrar (obtidos em listar_fluxos)."),
        projectIds: z.array(z.string()).optional().describe("Ids de projeto para filtrar."),
        sourceTypes: z
          .array(z.enum(["ORIGINAL", "SPLITTED"]))
          .optional()
          .describe("Tipos de origem: ORIGINAL e/ou SPLITTED (padrao ORIGINAL)."),
        initialDate: z.string().optional().describe(`Inicio da janela em ${isoHint}.`),
        finalDate: z.string().optional().describe(`Fim da janela em ${isoHint}.`),
        limit: z.number().int().optional().describe("Tamanho da amostra desejado; teto rigido de 100 por chamada."),
      },
    },
    async ({ status, integrationIds, projectIds, sourceTypes, initialDate, finalDate, limit }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        let parsedInitial: Date | undefined;
        let parsedFinal: Date | undefined;
        try {
          parsedInitial = parseIsoDate(initialDate);
          parsedFinal = parseIsoDate(finalDate);
        } catch {
          return jsonResponse({
            status: "INVALID_FILTERS",
            message: `Datas invalidas. Informe initialDate e finalDate em ${isoHint}. Sem datas, a janela padrao (ultimas 24h) e usada.`,
            example: "2024-01-01T00:00:00Z",
          });
        }
        const query: MessageQuery = {
          statuses: status,
          integrationIds,
          projectIds,
          sourceTypes,
          initialDate: parsedInitial,
          finalDate: parsedFinal,
          limit,
        };
        const response = await apiClient.getMessages(query);
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (response.status === 400) {
          return jsonResponse({
            status: "INVALID_FILTERS",
            httpStatus: 400,
            message: `O iPaaS rejeitou os filtros (400). Use datas em ${isoHint} e sourceTypes valido; o status e opcional.`,
            detail: summarizeBody(response.body),
          });
        }
        if (!isOk(response)) {
          return requestFailed(response, "Nao foi possivel listar as mensagens do Monitor do iPaaS.");
        }
        const cap = Math.max(1, Math.min(limit ?? config.monitor.defaultLimit, config.monitor.maxLimit));
        const end = parsedFinal ?? new Date();
        const start = parsedInitial ?? new Date(end.getTime() - config.monitor.defaultWindowMs);
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        // A API devolve um envelope { items, hasNext, total }; items ja vem com o pageSize pedido.
        const items = arrayItems(root);
        const total = typeof (root as any)?.total === "number" ? (root as any).total : undefined;
        const hasNext = (root as any)?.hasNext === true || (total !== undefined && total > items.length);
        const messages = items.map((m) => ({
          messageId: textOrUndefined(m, "id") ?? null,
          status: textOrUndefined(m, "status") ?? null,
          executionTime: textOrUndefined(m, "executionTime") ?? null,
          createdDate: textOrUndefined(m, "createdDate") ?? null,
          diagramName: textOrUndefined(m, "diagramName") ?? null,
          finalComponent: textOrUndefined(m, "finalComponent") ?? null,
          // integrationId + createdDate permitem chamar detalhar_steps diretamente.
          integrationId: textOrUndefined(m, "integrationId") ?? null,
        }));
        const result: Record<string, unknown> = {
          count: messages.length,
          total: total ?? null,
          window: { initialDate: start.toISOString(), finalDate: end.toISOString() },
          truncated: hasNext,
        };
        if (hasNext) {
          // Paginação por janela de tempo: a próxima fatia vai de initialDate ate a mensagem
          // mais antiga desta pagina (as mensagens vem ordenadas por tempo decrescente).
          const timestamps = items
            .map((m) => extractItemTimestamp(m))
            .filter((t): t is number => t !== undefined);
          if (timestamps.length > 0) {
            const oldest = new Date(Math.min(...timestamps));
            result.nextWindow = { initialDate: start.toISOString(), finalDate: oldest.toISOString() };
            result.refineHint =
              `Ha mais mensagens no periodo${total !== undefined ? ` (total=${total})` : ""} do que o teto de ${cap} por chamada. ` +
              `Para a proxima fatia, chame listar_mensagens de novo com finalDate='${oldest.toISOString()}' e o mesmo initialDate, ` +
              `repetindo ate 'truncated' ser false. Para menos chamadas, estreite a janela ou filtre por status.`;
          } else {
            const mid = new Date((start.getTime() + end.getTime()) / 2);
            result.nextWindow = { initialDate: mid.toISOString(), finalDate: end.toISOString() };
            result.refineHint =
              `Ha mais mensagens no periodo do que o teto de ${cap} por chamada. Estreite a janela ` +
              `(ex.: finalDate='${mid.toISOString()}') ou filtre por status para percorrer em fatias.`;
          }
        }
        result.messages = messages;
        return jsonResponse(result);
      } catch (err) {
        return errorResponse("Failed to list iPaaS monitor messages", err);
      }
    },
  );

  server.registerTool(
    "detalhar_mensagem",
    {
      description:
        "Detalha uma mensagem de execucao do Monitor do TOTVS iPaaS pelo seu id, com status, tempo de execucao, " +
        "componentes inicial/final e, quando houver, o errorStack. Distingue execucoes com erro (ERROR) de " +
        "concluidas (DONE), em que o campo message e o payload enviado, nao um erro. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        messageId: z.string().describe("Identificador da mensagem no Monitor do iPaaS, ex.: abc-123."),
      },
    },
    async ({ messageId }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        if (!messageId || messageId.trim() === "") {
          return jsonResponse({
            status: "INVALID_ID",
            message:
              "Informe o messageId da mensagem a detalhar. Use listar_mensagens para localizar o id desejado antes de chamar esta tool.",
            nextStep: "listar_mensagens",
          });
        }
        const response = await apiClient.get(MESSAGE_DETAIL_PATH + encodeURIComponent(messageId.trim()));
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel detalhar a mensagem do Monitor do iPaaS.");
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        const detail = Array.isArray(root) && root.length > 0 ? root[0] : root;
        const status = textOrUndefined(detail, "status");
        // A API carrega o conteudo (stack de erro OU payload) no campo `message`; nao ha errorStack separado.
        const messageField = textOrUndefined(detail, "message");
        const explicitStack = textOrUndefined(detail, "errorStack");
        const failed = status === "ERROR" || explicitStack !== undefined;
        const result: Record<string, unknown> = {
          messageId: textOrUndefined(detail, "id") ?? textOrUndefined(detail, "messageId") ?? null,
          status: status ?? null,
          executionTime: textOrUndefined(detail, "executionTime") ?? null,
          initialComponent: textOrUndefined(detail, "initialComponent") ?? null,
          finalComponent: textOrUndefined(detail, "finalComponent") ?? null,
        };
        if (failed) {
          // Em execucoes com erro, o campo message e o proprio stack trace.
          const stack = (explicitStack ?? messageField) as string | undefined;
          result.errorStack = stack ?? null;
          result.errorSummary = typeof stack === "string" ? stack.split("\n")[0]!.trim() : null;
          result.outcome = "ERROR";
          result.analysis =
            "A mensagem terminou em erro. O campo errorStack traz a pilha; use errorSummary (primeira linha) e finalComponent para localizar a causa.";
        } else {
          result.message = messageField ?? null;
          if (status === "DONE") {
            result.outcome = "DONE";
            result.analysis =
              "Execucao concluida com sucesso. O campo message contem o payload enviado, nao uma mensagem de erro; evite interpreta-lo como falha.";
          }
        }
        return jsonResponse(result);
      } catch (err) {
        return errorResponse("Failed to detail the iPaaS monitor message", err);
      }
    },
  );

  server.registerTool(
    "detalhar_steps",
    {
      description:
        "Detalha os steps de execucao de uma mensagem do Monitor do TOTVS iPaaS, para localizar em qual " +
        "componente a execucao falhou. Requer integrationId, createdDate e messageId. ATENCAO: a tool " +
        "listar_mensagens NAO fornece integrationId nem createdDate; obtenha os tres identificadores na " +
        "tela do Monitor do iPaaS. Steps sem componentDTO sao sinalizados como incompletos sem quebrar a " +
        "resposta. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        integrationId: z.string().describe("Identificador da integracao/fluxo (obtido na tela do Monitor)."),
        createdDate: z.string().describe("Data de criacao da mensagem usada no caminho (obtida na tela do Monitor)."),
        messageId: z.string().describe("Identificador da mensagem no Monitor do iPaaS, ex.: abc-123."),
      },
    },
    async ({ integrationId, createdDate, messageId }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        const blank = (v: string | undefined) => !v || v.trim() === "";
        if (blank(integrationId) || blank(createdDate) || blank(messageId)) {
          return jsonResponse({
            status: "INVALID_ID",
            message:
              "Informe os tres identificadores: integrationId, createdDate e messageId. Use listar_mensagens para localiza-los.",
            nextStep: "listar_mensagens",
          });
        }
        const path =
          STEPS_PATH +
          [integrationId, createdDate, messageId].map((s) => encodeURIComponent(s.trim())).join("/");
        const response = await apiClient.get(path);
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel detalhar os steps da mensagem do iPaaS.");
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        let incompleteCount = 0;
        let errorCount = 0;
        const steps = arrayItems(root).map((step) => {
          const status = textOrUndefined(step, "status") ?? null;
          const isError = String(status).toUpperCase() === "ERROR";
          if (isError) errorCount++;
          // Nos campos de header ha dados sensiveis (ex.: Authorization); NAO os expomos.
          const base: Record<string, unknown> = {
            activityLabel: textOrUndefined(step, "activityLabel") ?? null,
            status,
            resourceType: textOrUndefined(step, "resourceType") ?? null,
            startDate: textOrUndefined(step, "startDate") ?? null,
            endDate: textOrUndefined(step, "endDate") ?? null,
          };
          // Em steps com erro, a falha costuma vir em outMessage (ex.: <am:fault ...>).
          if (isError) {
            const out = textOrUndefined(step, "outMessage");
            base.error = typeof out === "string" && out.trim() !== "" ? truncate(out.trim(), 600) : null;
          }
          const component = step?.componentDTO;
          if (component === null || component === undefined) {
            incompleteCount++;
            base.incomplete = true;
            base.note = "Step sem componentDTO; detalhes do componente indisponiveis.";
          } else {
            base.incomplete = false;
            base.component = {
              id: textOrUndefined(component, "id") ?? null,
              name: textOrUndefined(component, "name") ?? null,
            };
          }
          return base;
        });
        return jsonResponse({ count: steps.length, errorCount, incompleteCount, steps });
      } catch (err) {
        return errorResponse("Failed to detail the iPaaS message steps", err);
      }
    },
  );

  server.registerTool(
    "resumir_erros",
    {
      description:
        "Resume os erros do Monitor do TOTVS iPaaS no periodo, agrupando por tipo/mensagem e retornando a " +
        "contagem ordenada do mais frequente ao menos frequente. Trabalha sobre uma AMOSTRA de mensagens ERROR " +
        "com teto rigido de 100 por chamada; informa a janela usada. Quando nao ha datas, usa a janela padrao " +
        "(ultimas 24h). Se nao houver erros, indica ambiente limpo. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        initialDate: z.string().optional().describe(`Inicio da janela em ${isoHint}.`),
        finalDate: z.string().optional().describe(`Fim da janela em ${isoHint}.`),
        limit: z.number().int().optional().describe("Tamanho da amostra desejado; teto rigido de 100 por chamada."),
      },
    },
    async ({ initialDate, finalDate, limit }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        let parsedInitial: Date | undefined;
        let parsedFinal: Date | undefined;
        try {
          parsedInitial = parseIsoDate(initialDate);
          parsedFinal = parseIsoDate(finalDate);
        } catch {
          return jsonResponse({
            status: "INVALID_FILTERS",
            message: `Datas invalidas. Informe as datas em ${isoHint}.`,
            example: "2024-01-01T00:00:00Z",
          });
        }
        const response = await apiClient.getMessages({
          statuses: ["ERROR"],
          initialDate: parsedInitial,
          finalDate: parsedFinal,
          limit,
        });
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (response.status === 400) {
          return jsonResponse({
            status: "INVALID_FILTERS",
            httpStatus: 400,
            message: `O iPaaS rejeitou os filtros (400). Use datas em ${isoHint}.`,
            detail: summarizeBody(response.body),
          });
        }
        if (!isOk(response)) {
          return requestFailed(response, "Nao foi possivel resumir os erros do Monitor do iPaaS.");
        }
        const end = parsedFinal ?? new Date();
        const start = parsedInitial ?? new Date(end.getTime() - config.monitor.defaultWindowMs);
        const window = { initialDate: start.toISOString(), finalDate: end.toISOString() };
        const cap = Math.max(1, Math.min(limit ?? config.monitor.defaultLimit, config.monitor.maxLimit));
        const root = tryParseJson(response.body);
        const allItems = root ? arrayItems(root) : [];
        const items = allItems.slice(0, cap);
        if (items.length === 0) {
          return jsonResponse({
            status: "NO_ERRORS",
            message: "Nenhum erro encontrado na janela: ambiente limpo no periodo.",
            window,
          });
        }
        const counts = new Map<string, number>();
        for (const item of items) {
          const key = errorGroupKey(item);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const errors = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => ({ type, count }));
        return jsonResponse({
          sampling: true,
          sampleSize: items.length,
          distinctErrorTypes: errors.length,
          window,
          note: "Amostragem limitada (teto de 100 por chamada); nao representa a totalidade dos erros.",
          errors,
        });
      } catch (err) {
        return errorResponse("Failed to summarize iPaaS errors", err);
      }
    },
  );

  server.registerTool(
    "listar_mensagens_filhas",
    {
      description:
        "Lista as mensagens filhas (SPLITTED) derivadas de uma mensagem original que passou por um Splitter. " +
        "Informe o id da mensagem original (originMessageId). Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        originMessageId: z.string().describe("Id da mensagem original (pai) cujas filhas serao listadas."),
        limit: z.number().int().optional().describe("Tamanho da amostra; teto rigido de 100 por chamada."),
      },
    },
    async ({ originMessageId, limit }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        if (!originMessageId || originMessageId.trim() === "") {
          return jsonResponse({
            status: "INVALID_ID",
            message: "Informe o originMessageId (id da mensagem original). Use listar_mensagens para localiza-lo.",
            nextStep: "listar_mensagens",
          });
        }
        const response = await apiClient.getSplittedMessages(originMessageId.trim(), { limit });
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel listar as mensagens filhas no iPaaS.");
        const root = tryParseJson(response.body);
        const items = root ? arrayItems(root) : [];
        const total = typeof (root as any)?.total === "number" ? (root as any).total : null;
        const children = items.map((m) => ({
          messageId: textOrUndefined(m, "id") ?? null,
          status: textOrUndefined(m, "status") ?? null,
          executionTime: textOrUndefined(m, "executionTime") ?? null,
          createdDate: textOrUndefined(m, "createdDate") ?? null,
          integrationId: textOrUndefined(m, "integrationId") ?? null,
          finalComponent: textOrUndefined(m, "finalComponent") ?? null,
        }));
        return jsonResponse({ originMessageId: originMessageId.trim(), count: children.length, total, children });
      } catch (err) {
        return errorResponse("Failed to list iPaaS child messages", err);
      }
    },
  );

  server.registerTool(
    "resumo_por_status",
    {
      description:
        "Retorna a contagem de mensagens por status (DONE, ERROR, PROCESSING, REPROCESSED) num periodo, de forma " +
        "barata (sem baixar as mensagens). Quando as datas nao sao informadas, usa a janela padrao (ultimas 24h). " +
        "Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        initialDate: z.string().optional().describe(`Inicio da janela em ${isoHint}.`),
        finalDate: z.string().optional().describe(`Fim da janela em ${isoHint}.`),
      },
    },
    async ({ initialDate, finalDate }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        let parsedInitial: Date | undefined;
        let parsedFinal: Date | undefined;
        try {
          parsedInitial = parseIsoDate(initialDate);
          parsedFinal = parseIsoDate(finalDate);
        } catch {
          return jsonResponse({
            status: "INVALID_FILTERS",
            message: `Datas invalidas. Informe as datas em ${isoHint}.`,
            example: "2024-01-01T00:00:00Z",
          });
        }
        const response = await apiClient.getStatusSummary(parsedInitial, parsedFinal);
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel obter o resumo por status no iPaaS.");
        const end = parsedFinal ?? new Date();
        const start = parsedInitial ?? new Date(end.getTime() - config.monitor.defaultWindowMs);
        const parsed = tryParseJson(response.body);
        return jsonResponse({
          window: { initialDate: start.toISOString(), finalDate: end.toISOString() },
          summary: parsed ?? (response.body ?? "").trim(),
        });
      } catch (err) {
        return errorResponse("Failed to get iPaaS status summary", err);
      }
    },
  );
}

function errorGroupKey(item: any): string {
  // A LISTAGEM /v4/messages nao traz o texto do erro (so o detalhe traz, no campo `message`).
  // Agrupamos pelo componente onde a execucao parou (finalComponent) — a dimensao mais util
  // disponivel na listagem — com fallbacks para o fluxo e, por ultimo, o texto de erro se existir.
  const component = item?.finalComponent;
  if (typeof component === "string" && component.trim() !== "") {
    return "finalComponent: " + component.trim();
  }
  const diagram = item?.diagramName;
  if (typeof diagram === "string" && diagram.trim() !== "") {
    return "diagram: " + diagram.trim();
  }
  for (const field of ["message", "errorStack"]) {
    const value = item?.[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value.split("\n")[0]!.trim().slice(0, 200);
    }
  }
  return "UNKNOWN_ERROR";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + "...[truncado]";
}
