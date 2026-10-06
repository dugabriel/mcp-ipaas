import type { BrowserSession } from "./browser-session.js";
import type { SessionCookie } from "../model/types.js";
import { extractToken } from "./token-extractor.js";

/**
 * Login em andamento: o navegador segue aberto apos o redirecionamento pos-login,
 * aguardando o usuario selecionar a empresa. O token observado reflete sempre a
 * empresa atual. Tem um prazo de abandono (deadline); apos ele, o login expira.
 */
export class PendingLogin {
  private closed = false;

  constructor(
    private readonly browser: BrowserSession,
    private readonly deadline: number,
    private readonly now: () => number = Date.now,
  ) {}

  async currentToken(): Promise<string | undefined> {
    const [cookies, storage] = await Promise.all([this.browser.cookies(), this.browser.storage()]);
    return extractToken(cookies, storage);
  }

  async currentCookies(): Promise<SessionCookie[]> {
    return this.browser.cookies();
  }

  expired(): boolean {
    return this.closed || this.now() >= this.deadline;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }
}
