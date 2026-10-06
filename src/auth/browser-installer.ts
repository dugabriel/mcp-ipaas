import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { ensureGraphicalEnv } from "./display-env.js";

const require = createRequire(import.meta.url);

let installAttempted = false;

/** Indica se o erro de launch e por falta do executavel do Chromium. */
function isMissingBrowser(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|please run the following command|npx playwright install/i.test(msg);
}

/**
 * Lanca o Chromium; se o executavel nao estiver instalado, baixa-o automaticamente
 * (uma unica vez por processo) e tenta de novo. A instalacao escreve no stderr e e
 * tolerante: se falhar, o erro original de launch e propagado para a camada de login.
 */
export async function launchChromiumWithAutoInstall(options: LaunchOptions): Promise<Browser> {
  // Em Linux, garante DISPLAY/XAUTHORITY antes de abrir o navegador (no-op em Win/Mac).
  ensureGraphicalEnv();
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (!isMissingBrowser(err) || installAttempted) throw err;
    installAttempted = true;
    console.error("[ipaas-mcp] Chromium nao encontrado; baixando via Playwright (primeira execucao)...");
    const result = spawnSync(process.execPath, [resolvePlaywrightCli(), "install", "chromium"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.status !== 0) {
      console.error(
        "[ipaas-mcp] Falha ao instalar o Chromium automaticamente. Rode manualmente: npx playwright install chromium",
      );
      throw err;
    }
    return chromium.launch(options);
  }
}

/** Resolve o entrypoint da CLI do Playwright de forma compativel com ESM. */
function resolvePlaywrightCli(): string {
  try {
    return require.resolve("playwright/cli");
  } catch {
    return require.resolve("playwright-core/cli");
  }
}
