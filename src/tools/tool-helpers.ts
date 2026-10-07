import type { ApiResponse, IpaasSession } from "../model/types.js";
import { jsonResponse, type ToolTextResult } from "../util/tool-response.js";

/** Monta o path de listagem de fluxos (integracoes) com pageSize parametrizavel. */
export function integrationsPath(pageSize: number, page = 1): string {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    lastVersion: "true",
    fieldsReturn: "id,diagramId,name,status",
  });
  return "/ipaas/api/v3/integrations?" + params.toString();
}
export const MESSAGE_DETAIL_PATH = "/ipaas/api/v4/messages/";
export const STEPS_PATH = "/ipaas/api/v3/steps/";
export const TRACEABILITY_FIELDS = ["status", "errorStack", "message", "messageId"] as const;

export function tryParseJson(body: string | null | undefined): any | undefined {
  if (!body) return undefined;
  try {
    const node = JSON.parse(body);
    return typeof node === "object" && node !== null ? node : undefined;
  } catch {
    return undefined;
  }
}

export function textOrUndefined(node: any, field: string): unknown {
  const value = node?.[field];
  return value === undefined || value === null ? undefined : value;
}

export function arrayItems(root: any): any[] {
  if (Array.isArray(root)) return root;
  for (const wrapper of ["items", "content", "data"]) {
    if (Array.isArray(root?.[wrapper])) return root[wrapper];
  }
  return [];
}

export function summarizeBody(body: string | null | undefined): string {
  if (!body || body.trim() === "") return "Sem corpo na resposta.";
  const trimmed = body.trim();
  return trimmed.length <= 500 ? trimmed : trimmed.slice(0, 500) + "...";
}

export function remainingMs(session: IpaasSession, now: number): number {
  return Math.max(0, session.capturedAt + session.ttlMs - now);
}

export function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

export function sessionExpiredOnServer(): ToolTextResult {
  return jsonResponse({
    status: "SESSION_EXPIRED",
    message:
      "A sessao com o TOTVS iPaaS expirou (401) e foi descartada. Chame a tool `iniciar_login_ipaas` para refazer o login.",
    nextStep: "iniciar_login_ipaas",
  });
}

export function requestFailed(response: ApiResponse, message: string): ToolTextResult {
  return jsonResponse({
    status: "REQUEST_FAILED",
    httpStatus: response.status,
    message,
    detail: summarizeBody(response.body),
  });
}

// Exige ISO-8601 (ex.: 2024-01-01T00:00:00Z), rejeitando formatos ambiguos como 01/01/2024.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (!ISO_8601.test(trimmed)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return date;
}

// Nomes candidatos de campo de data/hora numa mensagem do Monitor (heuristica).
const TIMESTAMP_FIELDS = [
  "createdDate",
  "created",
  "startDate",
  "startedAt",
  "executionDate",
  "date",
  "timestamp",
  "receivedDate",
];

/**
 * Tenta extrair o instante (epoch ms) de uma mensagem do Monitor, para paginar por janela de tempo.
 * Procura campos candidatos de data e aceita valores ISO-8601 ou epoch (ms/segundos). Retorna
 * undefined quando nenhum campo de data confiavel e encontrado.
 */
export function extractItemTimestamp(item: any): number | undefined {
  if (!item || typeof item !== "object") return undefined;
  for (const field of TIMESTAMP_FIELDS) {
    const value = item[field];
    if (typeof value === "string" && value.trim() !== "") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      // Heuristica: valores < 1e12 provavelmente estao em segundos.
      return value < 1e12 ? value * 1000 : value;
    }
  }
  return undefined;
}

/** Uma integracao normalizada vinda de /v4/messages/filters, pronta para filtrar mensagens. */
export interface FilterIntegration {
  id: string | null;
  name: string | null;
  projectId: string | null;
  archived: boolean;
}

/** Um projeto normalizado vindo de /v4/messages/filters. */
export interface FilterProject {
  id: string | null;
  name: string | null;
  active: boolean;
}

function mapIntegrations(list: any, archived: boolean): FilterIntegration[] {
  return arrayItems(Array.isArray(list) ? list : list ?? []).map((item) => ({
    id: (textOrUndefined(item, "id") as string | undefined) ?? null,
    name: (textOrUndefined(item, "name") as string | undefined) ?? null,
    projectId: (textOrUndefined(item, "projectId") as string | undefined) ?? null,
    archived,
  }));
}

function mapProjects(list: any, active: boolean): FilterProject[] {
  return arrayItems(Array.isArray(list) ? list : list ?? []).map((item) => ({
    id: (textOrUndefined(item, "id") as string | undefined) ?? null,
    name: (textOrUndefined(item, "name") as string | undefined) ?? null,
    active,
  }));
}

/** Normaliza o envelope de /v4/messages/filters em listas planas de integracoes e projetos. */
export function normalizeMessageFilters(root: any): {
  integrations: FilterIntegration[];
  projects: FilterProject[];
} {
  const integrationsFilters = root?.integrationsFilters ?? {};
  const projectsFilter = root?.projectsFilter ?? {};
  const integrations = [
    ...mapIntegrations(integrationsFilters.publishedIntegrations, false),
    ...mapIntegrations(integrationsFilters.archivedIntegrations, true),
  ];
  const projects = [
    ...mapProjects(projectsFilter.activateProjects, true),
    ...mapProjects(projectsFilter.deactivateProjects, false),
  ];
  return { integrations, projects };
}

/** Contagem normalizada por status a partir do resumo de /v4/messages/status. */
export interface StatusSummary {
  DONE: number;
  ERROR: number;
  PROCESSING: number;
  REPROCESSED: number;
  total: number;
}

/**
 * Normaliza o corpo real de /v4/messages/status — `{ messages: [{status, size}], total }` — num
 * objeto por status com ausentes = 0. Status que nao aparecem no array vem zerados. Robusto a
 * corpos inesperados (retorna tudo zerado). O endpoint ja conta ORIGINAL+SPLITTED (inclui filhas).
 */
export function parseStatusSummary(root: any): StatusSummary {
  const summary: StatusSummary = { DONE: 0, ERROR: 0, PROCESSING: 0, REPROCESSED: 0, total: 0 };
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  for (const entry of messages) {
    const status = textOrUndefined(entry, "status");
    const size = entry?.size;
    if (typeof status === "string" && status in summary && typeof size === "number") {
      (summary as any)[status] += size;
    }
  }
  if (typeof root?.total === "number") {
    summary.total = root.total;
  } else {
    summary.total = summary.DONE + summary.ERROR + summary.PROCESSING + summary.REPROCESSED;
  }
  return summary;
}

/** Filtra por nome (case-insensitive); vazio/indefinido devolve a lista inteira. */
export function filterByName<T extends { name: string | null }>(items: T[], search: string | undefined): T[] {
  if (!search || search.trim() === "") return items;
  const needle = search.trim().toLowerCase();
  return items.filter((item) => (item.name ?? "").toLowerCase().includes(needle));
}
