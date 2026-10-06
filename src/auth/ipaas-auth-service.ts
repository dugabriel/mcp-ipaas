import { type Page } from "playwright";
import { launchChromiumWithAutoInstall } from "./browser-installer.js";
import type { IpaasConfig } from "../config/config.js";
import type { IpaasSession } from "../model/types.js";
import type { BrowserSession } from "./browser-session.js";
import type { FetchLike } from "../api/ipaas-api-client.js";
import { LoginFailedError } from "./login-failed-error.js";
import { PendingLogin } from "./pending-login.js";

const VALIDATE_PATH = "/ipaas/api/v2/auth-models?page=1&pageSize=1";

const STORAGE_DUMP = `() => {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
  return { ...dump(window.localStorage), ...dump(window.sessionStorage) };
}`;

/** Abre o navegador e deixa a pagina pronta no front; isolavel em teste. */
export type BrowserLauncher = (frontUrl: string) => Promise<BrowserSession & { page: Page | null }>;

/**
 * Conduz o login manual (SSO/MFA) no TOTVS iPaaS via Playwright, em duas etapas:
 * beginLogin abre o navegador e observa o token; confirm captura a sessao depois que
 * o usuario seleciona a empresa correta (o jwt.token muda a cada troca de empresa).
 */
export class IpaasAuthService {
  constructor(
    private readonly config: IpaasConfig,
    private readonly launcher: BrowserLauncher = defaultLauncher,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async beginLogin(timeoutMs: number = this.config.loginTimeoutMs): Promise<PendingLogin> {
    const browser = await this.launcher(this.config.frontUrl);
    try {
      if (browser.page) {
        const glob = this.config.frontUrl.replace(/\/$/, "") + "/**";
        await browser.page.waitForURL(glob, { timeout: timeoutMs });
      }
    } catch (err) {
      await browser.close();
      throw new LoginFailedError(
        `Login nao concluido dentro de ${timeoutMs}ms; navegador encerrado`,
        { cause: err },
      );
    }
    return new PendingLogin(browser, this.now() + this.config.loginTimeoutMs, this.now);
  }

  async confirm(pending: PendingLogin): Promise<IpaasSession> {
    if (pending.expired()) {
      await pending.close();
      throw new LoginFailedError(
        "Login abandonado: tempo de confirmacao esgotado; reinicie com iniciar_login_ipaas",
      );
    }
    const token = await pending.currentToken();
    if (!token) {
      await pending.close();
      throw new LoginFailedError(
        "Nenhum token disponivel; conclua o login e selecione a empresa antes de confirmar",
      );
    }
    const cookies = await pending.currentCookies();
    await pending.close();
    return { token, cookies, capturedAt: this.now(), ttlMs: this.config.sessionTtlMs };
  }

  async validate(session: IpaasSession): Promise<boolean> {
    const base = this.config.apiBaseUrl.replace(/\/$/, "");
    const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    try {
      const response = await this.fetchFn(base + VALIDATE_PATH, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.token}`,
          accept: "application/json",
          Cookie: cookieHeader,
        },
      });
      return response.status === 200;
    } catch (err) {
      console.error("Falha ao validar a sessao do iPaaS:", err);
      return false;
    }
  }
}

const defaultLauncher: BrowserLauncher = async (frontUrl) => {
  const browser = await launchChromiumWithAutoInstall({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontUrl);
  return {
    page,
    async cookies() {
      return (await context.cookies()).map((c) => ({ name: c.name, value: c.value }));
    },
    async storage() {
      const result = await page.evaluate(STORAGE_DUMP);
      return (result ?? {}) as Record<string, string>;
    },
    async close() {
      await browser.close();
    },
  };
};
