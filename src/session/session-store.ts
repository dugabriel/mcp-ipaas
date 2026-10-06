import type { IpaasSession, SessionState } from "../model/types.js";
import { isExpired } from "../model/types.js";

/**
 * Guarda a sessao corrente do iPaaS exclusivamente em memoria.
 * Token e cookies nunca sao persistidos em disco.
 */
export class SessionStore {
  private session: IpaasSession | undefined;

  current(): IpaasSession | undefined {
    return this.session;
  }

  set(session: IpaasSession): void {
    this.session = session;
  }

  clear(): void {
    this.session = undefined;
  }

  state(now: number = Date.now()): SessionState {
    if (!this.session) return "AUSENTE";
    return isExpired(this.session, now) ? "EXPIRADA" : "ATIVA";
  }
}
