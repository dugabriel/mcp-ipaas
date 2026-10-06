import { existsSync, readdirSync } from "node:fs";

/**
 * Garante, apenas no Linux, que as variaveis de ambiente graficas necessarias para
 * abrir o Chromium visivel estejam definidas. Em Windows e macOS e um no-op: o
 * navegador abre na tela nativa sem precisar de DISPLAY.
 *
 * Objetivo: a mesma configuracao de MCP (`npx -y ipaas-mcp-server`, sem bloco env)
 * funcionar nos tres sistemas, sem o usuario descobrir/colar DISPLAY ou XAUTHORITY.
 *
 * Em desktop Linux (X11/Wayland) sem DISPLAY definido, assume `:0` e tenta localizar
 * o XAUTHORITY do Xwayland/X em XDG_RUNTIME_DIR. Em Linux headless real (sem display),
 * nao ha o que fazer: o login manual depende de uma tela — a camada de login reporta isso.
 */
export function ensureGraphicalEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "linux") return;

  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    env.DISPLAY = ":0";
  }

  const runtimeDir = env.XDG_RUNTIME_DIR ?? defaultRuntimeDir();
  if (runtimeDir && !env.XDG_RUNTIME_DIR && existsSync(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }

  if (!env.XAUTHORITY && runtimeDir) {
    const xauth = findXauthority(runtimeDir);
    if (xauth) env.XAUTHORITY = xauth;
  }
}

function defaultRuntimeDir(): string | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid !== undefined ? `/run/user/${uid}` : undefined;
}

/** Procura um arquivo de autoridade X no runtime dir (ex.: .mutter-Xwaylandauth.XXXXXX ou .Xauthority). */
function findXauthority(runtimeDir: string): string | undefined {
  try {
    const entries = readdirSync(runtimeDir);
    const match = entries.find(
      (name) => name.includes("Xwaylandauth") || name === ".Xauthority" || name.endsWith("Xauthority"),
    );
    return match ? `${runtimeDir}/${match}` : undefined;
  } catch {
    return undefined;
  }
}
