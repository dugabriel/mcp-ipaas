import type { IpaasConfig } from "../config/config.js";
import type { ApiResponse, MessageQuery } from "../model/types.js";
import type { SessionStore } from "../session/session-store.js";
import { isOk, isUnauthorized } from "../model/types.js";
import { tryParseJson, arrayItems, DIAGRAM_FIELDS_RETURN } from "../tools/tool-helpers.js";

/** Assinatura do fetch, injetavel para teste sem rede. */
export type FetchLike = typeof fetch;

const MESSAGES_PATH = "/ipaas/api/v4/messages";
const MESSAGES_STATUS_PATH = "/ipaas/api/v4/messages/status";
const MESSAGES_FILTERS_PATH = "/ipaas/api/v4/messages/filters";
const METRICS_COMMONS_PATH = "/ipaas/api/v3/metrics/commons";
const METRICS_DIAGRAMS_TRANSACTIONS_PATH = "/ipaas/api/v3/metrics/diagrams-transactions";
const INTEGRATIONS_PATH = "/ipaas/api/v3/integrations";
const ALL_STATUSES = ["DONE", "ERROR", "PROCESSING", "REPROCESSED"];

/** Resultado agregado de uma varredura paginada de mensagens. */
export interface ScanResult {
  items: any[];
  pagesFetched: number;
  /** true quando percorreu ate hasNext=false; false quando parou pelo teto de paginas. */
  scanComplete: boolean;
  total: number | null;
  /** Ultima resposta HTTP crua, para a tool tratar 401/400/erros. */
  lastResponse: ApiResponse;
}

/**
 * Cliente HTTP autenticado para a API do TOTVS iPaaS.
 * Monta cada requisicao com o Bearer e os cookies da sessao corrente. Uma resposta
 * 401 invalida a sessao em memoria, de modo que a proxima chamada ja a encontre ausente.
 */
export class IpaasApiClient {
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: IpaasConfig,
    private readonly sessionStore: SessionStore,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
  }

  async get(path: string): Promise<ApiResponse> {
    const session = this.sessionStore.current();
    if (!session) {
      throw new Error("No active session to call the iPaaS API");
    }
    const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const response = await this.fetchFn(this.apiBaseUrl + path, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
        accept: "application/json",
        Cookie: cookieHeader,
      },
    });
    const body = await response.text();
    if (response.status === 401) {
      this.sessionStore.clear();
    }
    return { status: response.status, body };
  }

  async getMessages(query: MessageQuery): Promise<ApiResponse> {
    return this.get(MESSAGES_PATH + "?" + this.buildMessagesQuery(query));
  }

  /** Lista as mensagens filhas (SPLITTED) derivadas de uma mensagem original. */
  async getSplittedMessages(originMessageId: string, query: MessageQuery): Promise<ApiResponse> {
    const params = new URLSearchParams(this.buildMessagesQuery(query));
    params.delete("sourceTypes");
    params.append("sourceTypes", "SPLITTED");
    params.set("originMessageId", originMessageId);
    return this.get(MESSAGES_PATH + "?" + params.toString());
  }

  /** Contagem de mensagens por status num periodo (resumo barato, sem baixar as mensagens). */
  async getStatusSummary(initialDate: Date | undefined, finalDate: Date | undefined): Promise<ApiResponse> {
    const end = finalDate ?? new Date();
    const start = initialDate ?? new Date(end.getTime() - this.config.monitor.defaultWindowMs);
    const params = new URLSearchParams();
    params.set("initialDate", start.toISOString());
    params.set("finalDate", end.toISOString());
    for (const st of ALL_STATUSES) params.append("status", st);
    return this.get(MESSAGES_STATUS_PATH + "?" + params.toString());
  }

  /** Lista os filtros disponiveis do Monitor (integracoes e projetos para filtrar mensagens). */
  async getMessageFilters(): Promise<ApiResponse> {
    return this.get(MESSAGES_FILTERS_PATH);
  }

  /** Metricas agregadas da conta num dia de referencia (plano, totais globais de sucesso/erro). */
  async getAccountMetrics(refDate: string): Promise<ApiResponse> {
    const params = new URLSearchParams();
    params.set("refDate", refDate);
    params.set("forceUpdate", "false");
    return this.get(METRICS_COMMONS_PATH + "?" + params.toString());
  }

  /**
   * Estrutura (planta/topologia) de um diagrama via /v3/integrations trazendo o campo `flow`.
   * Resolve por `diagramId` (versao exata salva) OU por `integrationId` (versao atual, lastVersion=true).
   * Reusa get() (Bearer + Cookie + 401 clear). Pede pageSize=1 e so os campos necessarios.
   */
  async getDiagramFlow(params: { diagramId?: string; integrationId?: string }): Promise<ApiResponse> {
    const search = new URLSearchParams();
    search.set("fieldsReturn", DIAGRAM_FIELDS_RETURN);
    search.set("pageSize", "1");
    // Precedencia: diagramId (versao exata) sobre integrationId (versao atual).
    if (params.diagramId && params.diagramId.trim() !== "") {
      search.set("diagramId", params.diagramId.trim());
    } else if (params.integrationId && params.integrationId.trim() !== "") {
      search.set("id", params.integrationId.trim());
      search.set("lastVersion", "true");
    }
    return this.get(INTEGRATIONS_PATH + "?" + search.toString());
  }

  /** Volume de transacoes por diagrama/fluxo num intervalo (para ranquear os TOP fluxos). */
  async getDiagramsTransactions(initialDate: string, endDate: string): Promise<ApiResponse> {
    const params = new URLSearchParams();
    params.set("initialDate", initialDate);
    params.set("endDate", endDate);
    params.set("forceUpdate", "false");
    return this.get(METRICS_DIAGRAMS_TRANSACTIONS_PATH + "?" + params.toString());
  }

  /**
   * Varredura paginada de mensagens respeitando o teto de 100 por request. Itera page=1..N
   * (pageSize = clampLimit) acumulando os itens ate hasNext=false (scanComplete=true) ou ate
   * atingir maxPages com hasNext ainda true (scanComplete=false, guarda-corpo). Interrompe e
   * devolve lastResponse em qualquer resposta nao-OK (incl. 401) para a tool tratar.
   */
  async scanMessages(query: MessageQuery, opts?: { maxPages?: number }): Promise<ScanResult> {
    const maxPages = opts?.maxPages ?? this.config.monitor.maxPages;
    const items: any[] = [];
    let pagesFetched = 0;
    let total: number | null = null;
    let scanComplete = false;
    let lastResponse: ApiResponse = { status: 200, body: "" };
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.get(MESSAGES_PATH + "?" + this.buildMessagesQuery(query, page));
      lastResponse = response;
      if (isUnauthorized(response) || !isOk(response)) {
        // Deixa a tool decidir (sessao expirada, 400 de filtros, etc.).
        return { items, pagesFetched, scanComplete: false, total, lastResponse };
      }
      pagesFetched++;
      const root = tryParseJson(response.body);
      const pageItems = root ? arrayItems(root) : [];
      items.push(...pageItems);
      if (typeof (root as any)?.total === "number") total = (root as any).total;
      const hasNext = (root as any)?.hasNext === true;
      if (!hasNext || pageItems.length === 0) {
        scanComplete = true;
        break;
      }
    }
    return { items, pagesFetched, scanComplete, total, lastResponse };
  }

  private buildMessagesQuery(query: MessageQuery, page = 1): string {
    const params = new URLSearchParams();
    // sourceTypes repetivel; padrao ORIGINAL quando nao informado.
    const sourceTypes = query.sourceTypes && query.sourceTypes.length > 0 ? query.sourceTypes : ["ORIGINAL"];
    for (const st of sourceTypes) params.append("sourceTypes", st);
    for (const st of query.statuses ?? []) {
      if (st && st.trim() !== "") params.append("status", st.trim());
    }
    for (const id of query.integrationIds ?? []) {
      if (id && id.trim() !== "") params.append("integrationIds", id.trim());
    }
    for (const id of query.projectIds ?? []) {
      if (id && id.trim() !== "") params.append("projectIds", id.trim());
    }
    const finalDate = query.finalDate ?? new Date();
    const initialDate =
      query.initialDate ?? new Date(finalDate.getTime() - this.config.monitor.defaultWindowMs);
    params.set("initialDate", initialDate.toISOString());
    params.set("finalDate", finalDate.toISOString());
    // A API /v4/messages pagina com page/pageSize (nao `limit`); pageSize sofre o clamp rigido.
    params.set("page", String(page));
    params.set("pageSize", String(this.clampLimit(query.limit)));
    return params.toString();
  }

  /** Teto rigido: nunca busca mais que maxLimit nem menos que 1 registro. */
  private clampLimit(requested: number | undefined): number {
    const base = requested ?? this.config.monitor.defaultLimit;
    return Math.max(1, Math.min(base, this.config.monitor.maxLimit));
  }
}
