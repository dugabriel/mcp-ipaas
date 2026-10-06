#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.js";
import { SessionStore } from "./session/session-store.js";
import { IpaasApiClient } from "./api/ipaas-api-client.js";
import { IpaasAuthService } from "./auth/ipaas-auth-service.js";
import { registerIpaasTools, type LoginState } from "./tools/ipaas-tools.js";
import { registerDevTools } from "./tools/dev-tools.js";

/**
 * MCP Server (STDIO) para automatizar o TOTVS iPaaS.
 *
 * O stdout e exclusivo do canal JSON-RPC; todo log vai para stderr. O processo e
 * mantido vivo pelo transporte STDIO ate o cliente desconectar.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const sessionStore = new SessionStore();
  const apiClient = new IpaasApiClient(config, sessionStore);
  const authService = new IpaasAuthService(config);

  const server = new McpServer({ name: "ipaas-mcp-server", version: "0.1.0" });
  const deps = { config, sessionStore, apiClient, authService };
  const loginState = registerIpaasTools(server, deps);
  if (process.env.IPAAS_DEV_TOOLS === "1") {
    registerDevTools(server, deps);
    console.error("[DEV] tools de desenvolvimento ativas (_debug_get)");
  }

  registerShutdown(loginState, sessionStore);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ipaas-mcp-server pronto (STDIO)");
}

/** Libera o navegador pendente e descarta a sessao em memoria no encerramento. */
function registerShutdown(loginState: LoginState, sessionStore: SessionStore): void {
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    try {
      await loginState.pending?.close();
    } catch (err) {
      console.error("Falha ao encerrar o navegador pendente no shutdown:", err);
    }
    sessionStore.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await cleanup();
      process.exit(0);
    });
  }
  process.stdin.on("close", () => {
    void cleanup();
  });
}

main().catch((err) => {
  console.error("Falha ao iniciar o servidor MCP:", err);
  process.exit(1);
});
