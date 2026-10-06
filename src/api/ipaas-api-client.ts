import type { IpaasConfig } from "../config/config.js";
import type { ApiResponse, MessageQuery } from "../model/types.js";
import type { SessionStore } from "../session/session-store.js";

/** Assinatura do fetch, injetavel para teste sem rede. */
export type FetchLike = typeof fetch;

const MESSAGES_PATH = "/ipaas/api/v4/messages";
const MESSAGES_STATUS_PATH = "/ipaas/api/v4/messages/status";
const ALL_STATUSES = ["DONE", "ERROR", "PROCESSING", "REPROCESSED"];

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

  private buildMessagesQuery(query: MessageQuery): string {
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
    params.set("page", "1");
    params.set("pageSize", String(this.clampLimit(query.limit)));
    return params.toString();
  }

  /** Teto rigido: nunca busca mais que maxLimit nem menos que 1 registro. */
  private clampLimit(requested: number | undefined): number {
    const base = requested ?? this.config.monitor.defaultLimit;
    return Math.max(1, Math.min(base, this.config.monitor.maxLimit));
  }
}
