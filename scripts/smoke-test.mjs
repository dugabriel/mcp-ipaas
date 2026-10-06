// Teste manual do MCP server via STDIO: envia initialize + tools/list e mostra as respostas.
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });

let out = "";
child.stdout.on("data", (d) => (out += d.toString()));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

setTimeout(() => {
  const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
  console.error(`\n=== respostas JSON-RPC recebidas: ${lines.length} (esperado >=2) ===`);
  for (const l of lines) {
    try {
      const msg = JSON.parse(l);
      if (msg.result?.serverInfo) console.error("initialize OK:", msg.result.serverInfo.name);
      if (msg.result?.tools) console.error("tools:", msg.result.tools.map((t) => t.name).join(", "));
    } catch {}
  }
  child.kill();
  process.exit(0);
}, 2000);
