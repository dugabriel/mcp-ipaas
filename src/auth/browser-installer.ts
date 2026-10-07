import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
 * Le a flag IPAAS_USE_SYSTEM_BROWSER (aceita "true"/"1", case-insensitive). Quando ligada,
 * o launch tenta os navegadores ja instalados no sistema (Chrome, depois Edge) antes de
 * cair no Chromium do Playwright.
 */
function useSystemBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.IPAAS_USE_SYSTEM_BROWSER?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Lanca o Chromium; se o executavel nao estiver instalado, baixa-o automaticamente
 * (uma unica vez por processo) e tenta de novo. A instalacao escreve no stderr e e
 * tolerante: se falhar, o erro original de launch e propagado para a camada de login.
 */
export async function launchChromiumWithAutoInstall(options: LaunchOptions): Promise<Browser> {
  // Em Linux, garante DISPLAY/XAUTHORITY antes de abrir o navegador (no-op em Win/Mac).
  ensureGraphicalEnv();
  // Com IPAAS_USE_SYSTEM_BROWSER ligada, tenta Chrome -> Edge do sistema antes do Chromium.
  if (useSystemBrowser()) {
    for (const channel of ["chrome", "msedge"]) {
      try {
        console.error(`[ipaas-mcp] IPAAS_USE_SYSTEM_BROWSER ativo; tentando o navegador do sistema (channel: ${channel})...`);
        return await chromium.launch({ ...options, channel });
      } catch (err) {
        if (!isMissingBrowser(err)) throw err;
        console.error(`[ipaas-mcp] Navegador do sistema "${channel}" nao encontrado; tentando a proxima opcao...`);
      }
    }
    console.error("[ipaas-mcp] Nenhum navegador do sistema encontrado; caindo no Chromium do Playwright.");
  }
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

/**
 * Resolve o entrypoint da CLI do Playwright (o arquivo cli.js na raiz do pacote).
 * O subpath "./cli" NAO esta no mapa de "exports" do playwright/playwright-core nas
 * versoes atuais, entao resolve-se via package.json (sempre exportado) + join("cli.js").
 */
function resolvePlaywrightCli(): string {
  for (const pkg of ["playwright", "playwright-core"]) {
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`);
      return join(dirname(pkgJson), "cli.js");
    } catch {
      // tenta o proximo pacote
    }
  }
  throw new Error("Nao foi possivel localizar a CLI do Playwright (playwright/playwright-core)");
}
