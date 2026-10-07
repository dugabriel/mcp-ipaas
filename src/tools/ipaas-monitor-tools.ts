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
  parseStatusSummary,
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
        "concluidas (DONE), em que o campo message e o payload enviado, nao um erro. Para entender o " +
        "diagrama/fluxo por tras da mensagem, use avaliar_diagrama (aceita o messageId). Exige sessao ativa. Nunca expoe o token.",
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
        "resposta. Para entender a planta/fluxo do diagrama por tras desses steps, use avaliar_diagrama. " +
        "Exige sessao ativa. Nunca expoe o token.",
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
        "contagem ordenada do mais frequente ao menos frequente. Varre as mensagens ERROR internamente em lotes " +
        "de ate 100 por request (varias paginas, respeitando o teto por chamada), somando as agregacoes; informa " +
        "a janela usada. Use incluirFilhas=true para incluir tambem as mensagens filhas (SPLITTED) de Splitter " +
        "(padrao FALSE, so ORIGINAL). Quando a varredura atinge o teto de paginas, 'scanComplete' vira false e " +
        "'truncated' true, com dica para estreitar a janela. Quando nao ha datas, usa a janela padrao (ultimas 24h). " +
        "Se nao houver erros, indica ambiente limpo. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        initialDate: z.string().optional().describe(`Inicio da janela em ${isoHint}.`),
        finalDate: z.string().optional().describe(`Fim da janela em ${isoHint}.`),
        limit: z.number().int().optional().describe("Tamanho de cada lote na varredura; teto rigido de 100 por request."),
        incluirFilhas: z
          .boolean()
          .optional()
          .describe("Inclui as mensagens filhas (SPLITTED) alem das ORIGINAL. Padrao FALSE."),
      },
    },
    async ({ initialDate, finalDate, limit, incluirFilhas }) => {
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
        // incluirFilhas=true => varre ORIGINAL+SPLITTED; padrao so ORIGINAL (nao envia sourceTypes).
        const sourceTypes = incluirFilhas ? ["ORIGINAL", "SPLITTED"] : undefined;
        // Varredura paginada: cada request <=100; soma as agregacoes de todas as paginas percorridas.
        const scan = await apiClient.scanMessages(
          {
            statuses: ["ERROR"],
            sourceTypes,
            initialDate: parsedInitial,
            finalDate: parsedFinal,
            limit,
          },
          { maxPages: config.monitor.maxPages },
        );
        const response = scan.lastResponse;
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
        const items = scan.items;
        if (items.length === 0) {
          return jsonResponse({
            status: "NO_ERRORS",
            message: "Nenhum erro encontrado na janela: ambiente limpo no periodo.",
            window,
            incluiFilhas: incluirFilhas === true,
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
        const truncated = !scan.scanComplete;
        const result: Record<string, unknown> = {
          sampling: true,
          sampleSize: items.length,
          distinctErrorTypes: errors.length,
          pagesFetched: scan.pagesFetched,
          scanComplete: scan.scanComplete,
          truncated,
          incluiFilhas: incluirFilhas === true,
          total: scan.total,
          window,
          note: scan.scanComplete
            ? "Varredura completa da janela (todas as paginas percorridas, ate 100 por request)."
            : "Varredura interrompida pelo teto de paginas; o resumo cobre apenas as mensagens ja percorridas.",
          errors,
        };
        if (truncated) {
          result.refineHint =
            "A varredura atingiu o teto de paginas antes de esgotar o periodo. Estreite a janela " +
            "(initialDate/finalDate) ou filtre por fluxo para cobrir todos os erros.";
        }
        return jsonResponse(result);
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
        if (!parsed) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        // Corpo real: { messages: [{status, size}], total }; normaliza para objeto por status (ausentes = 0).
        // O endpoint ja conta ORIGINAL+SPLITTED, logo a contagem INCLUI as mensagens filhas.
        const summary = parseStatusSummary(parsed);
        return jsonResponse({
          window: { initialDate: start.toISOString(), finalDate: end.toISOString() },
          incluiFilhas: true,
          note: "A contagem por status considera ORIGINAL+SPLITTED (inclui mensagens filhas de Splitter).",
          summary,
        });
      } catch (err) {
        return errorResponse("Failed to get iPaaS status summary", err);
      }
    },
  );

  server.registerTool(
    "panorama_saude",
    {
      description:
        "Panorama proativo de saude do ambiente TOTVS iPaaS combinando fontes baratas que JA incluem as " +
        "mensagens filhas (SPLITTED): metricas agregadas da conta (/metrics/commons), contagem por status na " +
        "janela (/messages/status, inclui filhas) e os TOP fluxos por volume (/metrics/diagrams-transactions). " +
        "PLAYBOOK: compara os erros COM filhas contra os erros SO ORIGINAL; se os erros com filhas forem bem " +
        "maiores (razao >= 1.5), recomenda aprofundar com resumir_erros incluirFilhas=true ou listar_mensagens " +
        "com SPLITTED. Quando as datas nao sao informadas, usa a janela padrao (ultimas 24h). Fontes opcionais que " +
        "falham nao derrubam o panorama (sao sinalizadas). Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        initialDate: z.string().optional().describe(`Inicio da janela em ${isoHint}.`),
        finalDate: z.string().optional().describe(`Fim da janela em ${isoHint}.`),
        topFlows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Quantidade de fluxos no ranking por volume (padrao 10)."),
      },
    },
    async ({ initialDate, finalDate, topFlows }) => {
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
        const end = parsedFinal ?? new Date();
        const start = parsedInitial ?? new Date(end.getTime() - config.monitor.defaultWindowMs);
        const window = { initialDate: start.toISOString(), finalDate: end.toISOString() };
        const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
        const topN = topFlows && topFlows > 0 ? topFlows : 10;

        // (1) Metricas agregadas da conta (fonte opcional; nao derruba o panorama se falhar).
        let accountMetrics: Record<string, unknown> | null = null;
        const sourcesUnavailable: string[] = [];
        const metricsResp = await apiClient.getAccountMetrics(dateOnly(end));
        if (isUnauthorized(metricsResp)) return sessionExpiredOnServer();
        if (isOk(metricsResp)) {
          const m = tryParseJson(metricsResp.body);
          if (m) {
            accountMetrics = {
              planName: textOrUndefined(m, "planName") ?? null,
              projects: textOrUndefined(m, "projects") ?? null,
              diagrams: textOrUndefined(m, "diagrams") ?? null,
              totalMessages: textOrUndefined(m, "totalMessages") ?? null,
              totalMessagesSuccess: textOrUndefined(m, "totalMessagesSuccess") ?? null,
              totalMessagesError: textOrUndefined(m, "totalMessagesError") ?? null,
              messagesPerMinute: textOrUndefined(m, "messagesPerMinute") ?? null,
              avgExecutionTime: textOrUndefined(m, "avgExecutionTime") ?? null,
            };
          } else {
            sourcesUnavailable.push("metrics/commons");
          }
        } else {
          sourcesUnavailable.push("metrics/commons");
        }

        // (2) Contagem por status na janela (inclui filhas: ORIGINAL+SPLITTED).
        let statusSummary: ReturnType<typeof parseStatusSummary> | null = null;
        const statusResp = await apiClient.getStatusSummary(parsedInitial, parsedFinal);
        if (isUnauthorized(statusResp)) return sessionExpiredOnServer();
        if (isOk(statusResp)) {
          const s = tryParseJson(statusResp.body);
          if (s) statusSummary = parseStatusSummary(s);
          else sourcesUnavailable.push("messages/status");
        } else {
          sourcesUnavailable.push("messages/status");
        }

        // (3) Baseline de erros SO ORIGINAL: 1 request barato, lendo apenas o total do envelope.
        let errosSoOriginal: number | null = null;
        const originalErrResp = await apiClient.getMessages({
          statuses: ["ERROR"],
          sourceTypes: ["ORIGINAL"],
          initialDate: parsedInitial,
          finalDate: parsedFinal,
          limit: 1,
        });
        if (isUnauthorized(originalErrResp)) return sessionExpiredOnServer();
        if (isOk(originalErrResp)) {
          const o = tryParseJson(originalErrResp.body);
          const t = (o as any)?.total;
          if (typeof t === "number") errosSoOriginal = t;
          else sourcesUnavailable.push("messages (ORIGINAL baseline)");
        } else {
          sourcesUnavailable.push("messages (ORIGINAL baseline)");
        }

        // (4) TOP fluxos por volume (fonte opcional).
        let topFlowsList: Array<Record<string, unknown>> | null = null;
        const txResp = await apiClient.getDiagramsTransactions(dateOnly(start), dateOnly(end));
        if (isUnauthorized(txResp)) return sessionExpiredOnServer();
        if (isOk(txResp)) {
          const tx = tryParseJson(txResp.body);
          const list = Array.isArray((tx as any)?.diagramsTransactions)
            ? (tx as any).diagramsTransactions
            : [];
          topFlowsList = list
            .map((d: any) => ({
              integrationId: textOrUndefined(d, "integrationId") ?? null,
              diagramName: textOrUndefined(d, "diagramName") ?? null,
              projectName: textOrUndefined(d, "projectName") ?? null,
              totalMessages: typeof d?.totalMessages === "number" ? d.totalMessages : 0,
            }))
            .sort((a: any, b: any) => (b.totalMessages ?? 0) - (a.totalMessages ?? 0))
            .slice(0, topN);
        } else {
          sourcesUnavailable.push("metrics/diagrams-transactions");
        }

        // PLAYBOOK: erros COM filhas (do status-summary) vs erros SO ORIGINAL (baseline).
        // Criterio explicito: recomendar investigar filhas quando com-filhas > so-original E
        // com-filhas >= so-original * 1.5 (filhas respondem por boa parte do erro no periodo).
        const errosComFilhas = statusSummary ? statusSummary.ERROR : null;
        const RATIO = 1.5;
        let recomendacao: Record<string, unknown> | null = null;
        if (
          errosComFilhas !== null &&
          errosSoOriginal !== null &&
          errosComFilhas > errosSoOriginal &&
          errosComFilhas >= errosSoOriginal * RATIO
        ) {
          recomendacao = {
            motivo:
              "Os erros considerando filhas (SPLITTED) sao bem maiores que os erros so das mensagens originais; " +
              "parte relevante das falhas esta nas filhas.",
            criterio: `errosComFilhas > errosSoOriginal E errosComFilhas >= errosSoOriginal * ${RATIO}`,
            errosComFilhas,
            errosSoOriginal,
            razao: errosSoOriginal > 0 ? Number((errosComFilhas / errosSoOriginal).toFixed(2)) : null,
            nextStep:
              "Chame resumir_erros com incluirFilhas=true (ou listar_mensagens com sourceTypes=['ORIGINAL','SPLITTED']) " +
              "para investigar os erros das mensagens filhas.",
          };
        }

        const result: Record<string, unknown> = {
          window,
          incluiFilhas: true,
          note:
            "O panorama inclui mensagens filhas (SPLITTED) por padrao: /messages/status e /metrics ja contam " +
            "ORIGINAL+SPLITTED. O baseline 'errosSoOriginal' isola apenas as mensagens originais.",
          accountMetrics,
          statusSummary,
          errosComFilhas,
          errosSoOriginal,
          topFlows: topFlowsList,
          playbook: {
            criterio: `errosComFilhas > errosSoOriginal E errosComFilhas >= errosSoOriginal * ${RATIO}`,
            recomendado: recomendacao !== null,
          },
        };
        if (recomendacao) result.recomendacao = recomendacao;
        if (sourcesUnavailable.length > 0) result.sourcesUnavailable = sourcesUnavailable;
        return jsonResponse(result);
      } catch (err) {
        return errorResponse("Failed to build iPaaS health panorama", err);
      }
    },
  );

  server.registerTool(
    "avaliar_diagrama",
    {
      description:
        "Reconstroi a PLANTA (topologia/estrutura) de um diagrama do TOTVS iPaaS para entender o FLUXO: " +
        "componentes por tipo/label, o caminho a partir do gatilho, e sinais de Splitter, Global Error e " +
        "Diagram Caller (dependencias entre diagramas). NAO e sobre saude/erros/contagem de mensagens; e a " +
        "companheira de detalhar_steps: a planta (esta tool) + o caminho real da execucao (detalhar_steps) " +
        "mostram por onde a mensagem passou. Aceita UM identificador (precedencia: diagramId > integrationId > " +
        "messageId): diagramId (versao exata salva), integrationId (versao atual do fluxo) ou messageId (resolve " +
        "o diagrama a partir do detalhe da mensagem). SEGURANCA: expoe SO a topologia; nunca URLs, specs, headers, " +
        "credenciais ou e-mails de configuracao. Exige sessao ativa. Nunca expoe o token.",
      inputSchema: {
        diagramId: z
          .string()
          .optional()
          .describe("Id do diagrama (versao exata salva; muda a cada save). Tem precedencia sobre os demais."),
        integrationId: z
          .string()
          .optional()
          .describe("Id da integracao/fluxo (estavel; resolve a versao atual com lastVersion)."),
        messageId: z
          .string()
          .optional()
          .describe("Id de uma mensagem do Monitor; o diagrama e resolvido a partir do detalhe dela."),
      },
    },
    async ({ diagramId, integrationId, messageId }) => {
      try {
        if (sessionStore.state() !== "ATIVA") return missingSession();
        const blank = (v: string | undefined) => !v || v.trim() === "";
        if (blank(diagramId) && blank(integrationId) && blank(messageId)) {
          return jsonResponse({
            status: "INVALID_INPUT",
            message:
              "Informe diagramId, integrationId ou messageId para avaliar o diagrama. Use listar_fluxos para " +
              "localizar um fluxo pelo nome, ou pegue o messageId em listar_mensagens.",
            nextStep: "listar_fluxos",
          });
        }

        // Precedencia: diagramId > integrationId > messageId. So resolve por messageId quando os
        // dois mais especificos nao vierem.
        let resolvedDiagramId = blank(diagramId) ? undefined : diagramId!.trim();
        let resolvedIntegrationId = blank(integrationId) ? undefined : integrationId!.trim();
        const viaMessageId = !resolvedDiagramId && !resolvedIntegrationId && !blank(messageId);
        // createdDate resolvido pelo detalhe da mensagem; detalhar_steps exige esse campo.
        let resolvedCreatedDate: string | undefined;

        if (viaMessageId) {
          const detailResp = await apiClient.get(MESSAGE_DETAIL_PATH + encodeURIComponent(messageId!.trim()));
          if (isUnauthorized(detailResp)) return sessionExpiredOnServer();
          if (!isOk(detailResp)) {
            return requestFailed(detailResp, "Nao foi possivel obter o detalhe da mensagem para resolver o diagrama.");
          }
          const detailRoot = tryParseJson(detailResp.body);
          const detail = Array.isArray(detailRoot) && detailRoot.length > 0 ? detailRoot[0] : detailRoot;
          resolvedDiagramId = (textOrUndefined(detail, "diagramId") as string | undefined) ?? undefined;
          resolvedIntegrationId = (textOrUndefined(detail, "integrationId") as string | undefined) ?? undefined;
          resolvedCreatedDate = (textOrUndefined(detail, "createdDate") as string | undefined) ?? undefined;
          if (!resolvedDiagramId && !resolvedIntegrationId) {
            return jsonResponse({
              status: "DIAGRAM_NOT_RESOLVED",
              message:
                "A mensagem informada nao traz diagramId nem integrationId para localizar o diagrama. " +
                "Informe diagramId ou integrationId diretamente.",
              nextStep: "listar_fluxos",
            });
          }
        }

        const response = await apiClient.getDiagramFlow({
          diagramId: resolvedDiagramId,
          integrationId: resolvedIntegrationId,
        });
        if (isUnauthorized(response)) return sessionExpiredOnServer();
        if (!isOk(response)) return requestFailed(response, "Nao foi possivel obter a estrutura do diagrama no iPaaS.");
        const root = tryParseJson(response.body);
        if (!root) {
          return jsonResponse({
            format: "TEXT",
            message: "Resposta do iPaaS nao e JSON valido; segue o texto tratado.",
            text: (response.body ?? "").trim(),
          });
        }
        const item = pickDiagramItem(root);
        if (!item || !item.flow) {
          return jsonResponse({
            status: "DIAGRAM_NOT_FOUND",
            message:
              "Nenhum diagrama com `flow` foi encontrado para o identificador informado. Confira o " +
              "diagramId/integrationId (o diagramId muda a cada save; prefira integrationId para a versao atual).",
            nextStep: "listar_fluxos",
          });
        }

        const summary = summarizeFlow(item);
        const result: Record<string, unknown> = {
          ...summary,
          focus:
            "Esta visao e a PLANTA do fluxo (topologia). Para o caminho REAL de uma execucao, use detalhar_steps.",
          nextStep: "detalhar_steps",
          hint:
            "Com integrationId + createdDate + messageId, chame detalhar_steps para ver por onde a mensagem passou.",
        };
        // Quando resolvido por messageId, devolve os ids ja prontos para detalhar_steps.
        // createdDate vem do detalhe da mensagem (detalhar_steps exige os tres); se ausente, null.
        if (viaMessageId) {
          result.detalharStepsArgs = {
            integrationId: resolvedIntegrationId ?? (summary.integrationId as string | null) ?? null,
            createdDate: resolvedCreatedDate ?? null,
            messageId: messageId!.trim(),
          };
        }
        return jsonResponse(result);
      } catch (err) {
        return errorResponse("Failed to evaluate the iPaaS diagram flow", err);
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

// ---------------------------------------------------------------------------
// avaliar_diagrama — extracao de TOPOLOGIA (planta) do campo `flow` do diagrama.
// SEGURANCA: estas funcoes leem SOMENTE id/type/label/name/connections e, para o
// Splitter, `configurations.subFlow` (apenas a topologia do subfluxo). Nunca emitem
// `configurations` cru, `positions`, `connectionPath` nem `finalConnections`.
// ---------------------------------------------------------------------------

// Ids reservados do playbook: nunca contam como orfaos (sao gatilhos/inicio de subfluxos).
const RESERVED_NODE_IDS = new Set([
  "webhook-sync-trigger",
  "webhook-hook-trigger",
  "id-global-error",
  "global-error-start",
]);

/** Nos de condicao tem id no formato "origem#destino" (CONDITION/OTHERWISE). */
function isConditionNodeId(id: unknown): boolean {
  return typeof id === "string" && id.includes("#");
}

/** Do envelope { items: [...] } devolve o primeiro item; aceita tambem o item cru. */
function pickDiagramItem(root: any): any | undefined {
  const items = arrayItems(root);
  if (items.length > 0) return items[0];
  // Se nao houver envelope mas o proprio root ja parecer um diagrama (tem flow), usa-o.
  return root && typeof root === "object" && root.flow ? root : undefined;
}

/** label = label || name || null (sem jamais tocar em configurations). */
function nodeLabel(node: any): string | null {
  const label = textOrUndefined(node, "label");
  if (typeof label === "string" && label.trim() !== "") return label;
  const name = textOrUndefined(node, "name");
  if (typeof name === "string" && name.trim() !== "") return name;
  return null;
}

/** Lista plana de componentes { id, type, label, scope } a partir de um mapa de activities. */
function collectComponents(activities: Record<string, any>, scope: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [id, node] of Object.entries(activities)) {
    out.push({
      id,
      type: (textOrUndefined(node, "type") as string | undefined) ?? null,
      label: nodeLabel(node),
      scope,
    });
  }
  return out;
}

/**
 * Travessia a partir de `start` seguindo connections.next, resolvendo os nos intermediarios
 * "origem#destino" (CONDITION/OTHERWISE) em arestas legiveis. Protege contra ciclos com um Set.
 * Produz `path` (sequencia "<type>: <label||id>") e `edges` ({from,to,via,label}).
 */
function traverseFlow(
  activities: Record<string, any>,
  start: string | undefined,
): { path: string[]; edges: Array<Record<string, unknown>> } {
  const path: string[] = [];
  const edges: Array<Record<string, unknown>> = [];
  if (!start || !activities[start]) return { path, edges };

  const visited = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = activities[current];
    if (!node) continue;

    // Nos de condicao sao resolvidos como arestas, nao entram no path como passo.
    if (!isConditionNodeId(current)) {
      const type = (textOrUndefined(node, "type") as string | undefined) ?? "UNKNOWN";
      const label = nodeLabel(node) ?? current;
      path.push(`${type}: ${label}`);
    }

    const next = node?.connections?.next;
    const nextIds: string[] = Array.isArray(next) ? next.filter((v: unknown) => typeof v === "string") : [];
    for (const nextId of nextIds) {
      if (isConditionNodeId(nextId)) {
        // Aresta via no de condicao: origem#destino. So o label do no de condicao, NUNCA conditions.
        const condNode = activities[nextId];
        const [from, to] = nextId.split("#");
        edges.push({
          from: from ?? current,
          to: to ?? null,
          via: (textOrUndefined(condNode, "type") as string | undefined) ?? "CONDITION",
          label: condNode ? nodeLabel(condNode) : null,
        });
        if (to && !visited.has(to)) queue.push(to);
        if (!visited.has(nextId)) queue.push(nextId);
      } else {
        if (!visited.has(nextId)) queue.push(nextId);
      }
    }
  }
  return { path, edges };
}

/**
 * Orquestra a extracao da topologia e devolve o objeto base da resposta (sem focus/nextStep/hint,
 * que o handler adiciona). SO topologia — nunca configurations cru/positions/finalConnections.
 */
function summarizeFlow(item: any): Record<string, unknown> {
  const flow = item?.flow ?? {};
  const activities: Record<string, any> =
    flow.activities && typeof flow.activities === "object" ? flow.activities : {};
  const start = typeof flow.start === "string" ? flow.start : undefined;
  const functions = flow.functions && typeof flow.functions === "object" ? flow.functions : {};
  const globalErrorFlow = flow.globalErrorFlow;

  // trigger = type do no inicial.
  const trigger = start ? ((textOrUndefined(activities[start], "type") as string | undefined) ?? null) : null;

  // Componentes do fluxo principal.
  const components = collectComponents(activities, "main");

  // Subfluxo de cada Splitter (configurations.subFlow) — SO a topologia.
  for (const [id, node] of Object.entries(activities)) {
    if ((textOrUndefined(node, "type") as string | undefined) === "SPLIT") {
      const subFlow = node?.configurations?.subFlow;
      const subActivities =
        subFlow?.activities && typeof subFlow.activities === "object" ? subFlow.activities : null;
      if (subActivities) {
        components.push(...collectComponents(subActivities, `splitter:${id}`));
      }
    }
  }

  // Subfluxo global de erro.
  if (globalErrorFlow && typeof globalErrorFlow === "object" && globalErrorFlow.activities) {
    const geActivities =
      typeof globalErrorFlow.activities === "object" ? globalErrorFlow.activities : {};
    components.push(...collectComponents(geActivities, "globalError"));
  }

  // Contagem por type SOBRE o fluxo principal (activities).
  const typeCounts: Record<string, number> = {};
  for (const node of Object.values(activities)) {
    const type = textOrUndefined(node, "type") as string | undefined;
    if (type) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }

  // Sinais de topologia.
  const hasSplitter = Object.values(activities).some(
    (n) => (textOrUndefined(n, "type") as string | undefined) === "SPLIT",
  );
  const hasGlobalError = !!(
    globalErrorFlow &&
    typeof globalErrorFlow === "object" &&
    (globalErrorFlow.start || globalErrorFlow.activities)
  );
  const diagramCallers = Object.values(activities)
    .filter((n) => (textOrUndefined(n, "type") as string | undefined) === "DIAGRAM_CALLER")
    .map((n) => nodeLabel(n))
    .filter((l): l is string => typeof l === "string");

  // Orfaos: sem next e sem previous, exceto start, ids reservados e nos de condicao origem#destino.
  const orphanNodes: string[] = [];
  for (const [id, node] of Object.entries(activities)) {
    if (id === start || RESERVED_NODE_IDS.has(id) || isConditionNodeId(id)) continue;
    const next = node?.connections?.next;
    const previous = node?.connections?.previous;
    const hasNext = Array.isArray(next) && next.length > 0;
    const hasPrevious = Array.isArray(previous) && previous.length > 0;
    if (!hasNext && !hasPrevious) orphanNodes.push(id);
  }

  const { path, edges } = traverseFlow(activities, start);

  return {
    diagramId: (textOrUndefined(item, "diagramId") as string | undefined) ?? null,
    integrationId: (textOrUndefined(item, "id") as string | undefined) ?? null,
    metadata: {
      name: (textOrUndefined(item, "name") as string | undefined) ?? null,
      description: (textOrUndefined(item, "description") as string | undefined) ?? null,
      status: (textOrUndefined(item, "status") as string | undefined) ?? null,
      active: typeof item?.active === "boolean" ? item.active : null,
      publishVersion: textOrUndefined(item, "publishVersion") ?? null,
      trigger,
    },
    components,
    path,
    edges,
    typeCounts,
    nodeCount: Object.keys(activities).length,
    functionCount: Object.keys(functions).length,
    hasSplitter,
    hasGlobalError,
    hasDiagramCaller: diagramCallers.length > 0,
    diagramCallers,
    orphanNodes,
  };
}
