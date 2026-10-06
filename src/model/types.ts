/** Cookie minimo trocado com o iPaaS (compativel com o formato do Playwright). */
export interface SessionCookie {
  name: string;
  value: string;
}

export type SessionState = "ATIVA" | "EXPIRADA" | "AUSENTE";

/** Sessao capturada apos o login manual; vive apenas em memoria. */
export interface IpaasSession {
  token: string;
  cookies: SessionCookie[];
  capturedAt: number; // epoch ms
  ttlMs: number;
}

export function isExpired(session: IpaasSession, now: number = Date.now()): boolean {
  return now > session.capturedAt + session.ttlMs;
}

/** Resposta HTTP crua do iPaaS. */
export interface ApiResponse {
  status: number;
  body: string;
}

export function isOk(response: ApiResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

export function isUnauthorized(response: ApiResponse): boolean {
  return response.status === 401;
}

/** Parametros de consulta ao Monitor; qualquer campo pode ser omitido. */
export interface MessageQuery {
  /** Um ou mais status (ERROR, DONE, PROCESSING, REPROCESSED). */
  statuses?: string[];
  initialDate?: Date;
  finalDate?: Date;
  limit?: number;
  /** Filtra por uma ou mais integracoes/fluxos (integrationIds). */
  integrationIds?: string[];
  /** Filtra por um ou mais projetos (projectIds). */
  projectIds?: string[];
  /** Tipos de origem: ORIGINAL e/ou SPLITTED (padrao: ORIGINAL). */
  sourceTypes?: string[];
}
