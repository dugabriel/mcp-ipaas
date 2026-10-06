import type { SessionCookie } from "../model/types.js";

/**
 * Seam fino sobre o navegador aberto durante o login: expoe apenas o que o fluxo
 * precisa (ler cookies e storage, encerrar). Permite testar sem um navegador real.
 */
export interface BrowserSession {
  cookies(): Promise<SessionCookie[]>;
  storage(): Promise<Record<string, string>>;
  close(): Promise<void>;
}
