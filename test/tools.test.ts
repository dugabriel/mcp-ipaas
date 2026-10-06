import { describe, it, expect, vi } from "vitest";
import { registerIpaasTools, type ToolDeps } from "../src/tools/ipaas-tools.js";
import { SessionStore } from "../src/session/session-store.js";
import { loadConfig } from "../src/config/config.js";
import type { IpaasSession, ApiResponse } from "../src/model/types.js";

type Handler = (args: any) => Promise<{ content: Array<{ text: string }> }>;

class FakeMcpServer {
  handlers = new Map<string, Handler>();
  registerTool(name: string, _def: unknown, handler: Handler) {
    this.handlers.set(name, handler);
  }
}

const config = loadConfig({});

function setup(overrides: Partial<ToolDeps> = {}) {
  const sessionStore = overrides.sessionStore ?? new SessionStore();
  const apiClient = overrides.apiClient ?? ({} as any);
  const authService = overrides.authService ?? ({} as any);
  const server = new FakeMcpServer();
  const loginState = registerIpaasTools(server as any, { config, sessionStore, apiClient, authService });
  const call = async (name: string, args: any = {}) => {
    const out = await server.handlers.get(name)!(args);
    return out.content[0]!.text;
  };
  return { server, sessionStore, loginState, call };
}

const activeSession = (): IpaasSession => ({ token: "token-secret", cookies: [], capturedAt: Date.now(), ttlMs: 48 * 3600_000 });
const resp = (status: number, body: string): ApiResponse => ({ status, body });

describe("status_sessao", () => {
  it("reports ATIVA when the session validates against the API, without token", async () => {
    const sessionStore = new SessionStore();
    sessionStore.set(activeSession());
    const authService = { validate: vi.fn(async () => true) } as any;
    const { call } = setup({ sessionStore, authService });
    const out = await call("status_sessao");
    expect(out).toContain("ATIVA");
    expect(out).toContain("estimatedRemainingTime");
    expect(out).not.toContain("token-secret");
    expect(authService.validate).toHaveBeenCalledOnce();
  });
  it("reports EXPIRADA and clears when the server rejects the session (expired early)", async () => {
    const sessionStore = new SessionStore();
    sessionStore.set(activeSession());
    const authService = { validate: vi.fn(async () => false) } as any;
    const { call } = setup({ sessionStore, authService });
    const out = await call("status_sessao");
    expect(out).toContain("EXPIRADA");
    expect(sessionStore.current()).toBeUndefined();
  });
  it("reports AUSENTE with relogin guidance when no session", async () => {
    const authService = { validate: vi.fn() } as any;
    const { call } = setup({ authService });
    const out = await call("status_sessao");
    expect(out).toContain("AUSENTE");
    expect(authService.validate).not.toHaveBeenCalled();
  });
});

describe("analisar_mensagem_erro", () => {
  it("extracts traceability fields from JSON", async () => {
    const { call } = setup();
    const out = await call("analisar_mensagem_erro", { payloadLog: '{"status":"ERROR","messageId":"abc-123","errorStack":"NPE"}' });
    expect(out).toContain("traceabilityFields");
    expect(out).toContain("abc-123");
  });
  it("treats non-JSON as TEXT", async () => {
    const { call } = setup();
    expect(await call("analisar_mensagem_erro", { payloadLog: "conexao recusada" })).toContain("TEXT");
  });
  it("guides on empty payload, never throws", async () => {
    const { call } = setup();
    expect(await call("analisar_mensagem_erro", { payloadLog: "   " })).toContain("EMPTY_PAYLOAD");
  });
});

describe("iniciar_login_ipaas / confirmar_empresa", () => {
  it("opens browser and guides to confirmar_empresa", async () => {
    const authService = { beginLogin: vi.fn(async () => ({ expired: () => false })) } as any;
    const { call } = setup({ authService });
    const out = await call("iniciar_login_ipaas");
    expect(out).toContain("PENDING_LOGIN");
    expect(out).toContain("confirmar_empresa");
    expect(authService.beginLogin).toHaveBeenCalledOnce();
  });

  it("without pending login, confirmar_empresa guides to start login", async () => {
    const { call, sessionStore } = setup();
    const out = await call("confirmar_empresa");
    expect(out).toContain("NO_PENDING_LOGIN");
    expect(sessionStore.current()).toBeUndefined();
  });

  it("confirm success stores session and returns ATIVA without token", async () => {
    const pending = { expired: () => false } as any;
    const captured = activeSession();
    const authService = {
      beginLogin: vi.fn(async () => pending),
      confirm: vi.fn(async () => captured),
      validate: vi.fn(async () => true),
    } as any;
    const sessionStore = new SessionStore();
    const { call } = setup({ authService, sessionStore });
    await call("iniciar_login_ipaas");
    const out = await call("confirmar_empresa");
    expect(sessionStore.current()).toBe(captured);
    expect(out).toContain("ATIVA");
    expect(out).not.toContain("token-secret");
  });

  it("invalid session is not stored", async () => {
    const pending = { expired: () => false } as any;
    const authService = {
      beginLogin: vi.fn(async () => pending),
      confirm: vi.fn(async () => activeSession()),
      validate: vi.fn(async () => false),
    } as any;
    const sessionStore = new SessionStore();
    const { call } = setup({ authService, sessionStore });
    await call("iniciar_login_ipaas");
    const out = await call("confirmar_empresa");
    expect(out).toContain("INVALID_SESSION");
    expect(sessionStore.current()).toBeUndefined();
  });
});

describe("monitor tools require session and handle 401", () => {
  it("listar_fluxos without session -> missingSession", async () => {
    const apiClient = { get: vi.fn() } as any;
    const { call } = setup({ apiClient });
    expect(await call("listar_fluxos")).toContain("iniciar_login_ipaas");
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("listar_fluxos active -> formatted list", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = { get: vi.fn(async () => resp(200, '[{"id":"1","name":"A","status":"ACTIVE"}]')) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("listar_fluxos");
    expect(out).toContain('"count": 1');
    expect(out).toContain("A");
    expect(out).not.toContain("token-secret");
  });

  it("listar_fluxos uses pageSize (default 200, overridable)", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    let requested = "";
    const apiClient = { get: vi.fn(async (pth: string) => { requested = pth; return resp(200, "[]"); }) } as any;
    const { call } = setup({ apiClient, sessionStore });
    await call("listar_fluxos", {});
    expect(requested).toContain("pageSize=200");
    await call("listar_fluxos", { pageSize: 500 });
    expect(requested).toContain("pageSize=500");
  });

  it("listar_fluxos 401 -> SESSION_EXPIRED", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = { get: vi.fn(async () => resp(401, "no")) } as any;
    const { call } = setup({ apiClient, sessionStore });
    expect(await call("listar_fluxos")).toContain("SESSION_EXPIRED");
  });

  it("listar_mensagens maps the real id field and surfaces integrationId/createdDate", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    // Envelope real { items, hasNext, total }; cada item usa `id` (nao messageId).
    const body = JSON.stringify({
      items: [
        { id: "id-0", status: "ERROR", executionTime: 10, createdDate: "2026-10-06T12:00:00Z", integrationId: "int-0", diagramName: "Flow A", finalComponent: "Mapper" },
      ],
      hasNext: true,
      total: 150,
    });
    const apiClient = { getMessages: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("listar_mensagens", { limit: 1 });
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(150);
    expect(parsed.truncated).toBe(true);
    expect(parsed.refineHint).toBeDefined();
    expect(parsed.messages[0].messageId).toBe("id-0");
    expect(parsed.messages[0].integrationId).toBe("int-0");
    expect(parsed.messages[0].createdDate).toBe("2026-10-06T12:00:00Z");
    expect(parsed.nextWindow).toBeDefined();
  });

  it("listar_mensagens nextWindow uses the oldest message timestamp of the page", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const body = JSON.stringify({
      items: [
        { id: "a", status: "ERROR", createdDate: "2026-10-06T12:00:00Z" },
        { id: "b", status: "ERROR", createdDate: "2026-10-06T10:00:00Z" },
      ],
      hasNext: true,
      total: 50,
    });
    const apiClient = { getMessages: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("listar_mensagens", { limit: 2 });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextWindow.finalDate).toBe("2026-10-06T10:00:00.000Z");
  });

  it("listar_mensagens forwards status/integrationIds/projectIds/sourceTypes to the API", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    let received: any;
    const apiClient = { getMessages: vi.fn(async (q: any) => { received = q; return resp(200, JSON.stringify({ items: [], hasNext: false, total: 0 })); }) } as any;
    const { call } = setup({ apiClient, sessionStore });
    await call("listar_mensagens", {
      status: ["ERROR", "DONE"],
      integrationIds: ["int-1"],
      projectIds: ["proj-1"],
      sourceTypes: ["ORIGINAL", "SPLITTED"],
    });
    expect(received.statuses).toEqual(["ERROR", "DONE"]);
    expect(received.integrationIds).toEqual(["int-1"]);
    expect(received.projectIds).toEqual(["proj-1"]);
    expect(received.sourceTypes).toEqual(["ORIGINAL", "SPLITTED"]);
  });

  it("listar_mensagens not truncated when hasNext is false", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const body = JSON.stringify({ items: [{ id: "id-1", status: "ERROR", executionTime: 10 }], hasNext: false, total: 1 });
    const apiClient = { getMessages: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("listar_mensagens", {});
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.messages[0].messageId).toBe("id-1");
  });

  it("listar_mensagens invalid date -> INVALID_FILTERS without calling api", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = { getMessages: vi.fn() } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("listar_mensagens", { initialDate: "01/01/2024" });
    expect(out).toContain("INVALID_FILTERS");
    expect(apiClient.getMessages).not.toHaveBeenCalled();
  });

  it("detalhar_mensagem DONE -> payload-not-error note", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = { get: vi.fn(async () => resp(200, '{"messageId":"a","status":"DONE","message":"{}"}')) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("detalhar_mensagem", { messageId: "a" });
    expect(out).toContain('"outcome": "DONE"');
    expect(out).toContain("payload");
  });

  it("detalhar_mensagem ERROR uses message as errorStack and maps id", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const stack = "svc failed to respond\n at Foo.bar(Foo.java:1)";
    const body = JSON.stringify({ id: "02acebe7", status: "ERROR", executionTime: 6775, initialComponent: "Webhook", finalComponent: "Usar stored Token", message: stack });
    const apiClient = { get: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("detalhar_mensagem", { messageId: "02acebe7" });
    const parsed = JSON.parse(out);
    expect(parsed.messageId).toBe("02acebe7");
    expect(parsed.outcome).toBe("ERROR");
    expect(parsed.errorStack).toContain("failed to respond");
    expect(parsed.errorSummary).toBe("svc failed to respond");
    expect(parsed.finalComponent).toBe("Usar stored Token");
  });

  it("detalhar_steps with null componentDTO -> incomplete flagged", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const body = JSON.stringify({ items: [
      { status: "DONE", activityLabel: "HTTP", componentDTO: { id: "c1", name: "HTTP", iconId: "x" } },
      { status: "ERROR", componentDTO: null, outMessage: "boom" },
    ], hasNext: false });
    const apiClient = { get: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("detalhar_steps", { integrationId: "1", createdDate: "2024-01-01", messageId: "a" });
    const parsed = JSON.parse(out);
    expect(parsed.incompleteCount).toBe(1);
    expect(parsed.steps[0].component.name).toBe("HTTP");
  });

  it("resumir_erros empty -> clean environment", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = { getMessages: vi.fn(async () => resp(200, "[]")) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", {});
    expect(out).toContain("NO_ERRORS");
    expect(out).toContain("ambiente limpo");
  });

  it("resumir_erros aggregates and orders by frequency", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    // Modelo real: a listagem traz finalComponent (nao o texto do erro); agrupamos por componente.
    const body = JSON.stringify({
      items: [
        { id: "1", status: "ERROR", finalComponent: "Usar stored Token" },
        { id: "2", status: "ERROR", finalComponent: "Usar stored Token" },
        { id: "3", status: "ERROR", finalComponent: "Usar stored Token" },
        { id: "4", status: "ERROR", finalComponent: "Lista pendentes" },
        { id: "5", status: "ERROR", finalComponent: "Lista pendentes" },
        { id: "6", status: "ERROR", diagramName: "Flow X" },
      ],
      hasNext: false,
      total: 6,
    });
    const apiClient = { getMessages: vi.fn(async () => resp(200, body)) } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", {});
    const parsed = JSON.parse(out);
    expect(parsed.sampling).toBe(true);
    expect(parsed.distinctErrorTypes).toBe(3);
    expect(parsed.errors[0].type).toBe("finalComponent: Usar stored Token");
    expect(parsed.errors[0].count).toBe(3);
    expect(out).not.toContain("UNKNOWN_ERROR");
  });
});

describe("new tools from API mapping", () => {
  const config = loadConfig({});
  function setup2(apiClient: any) {
    const sessionStore = new SessionStore();
    sessionStore.set({ token: "token-secret", cookies: [], capturedAt: Date.now(), ttlMs: 48 * 3600_000 });
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient, authService: {} as any });
    const call = async (name: string, args: any = {}) => (await server.handlers.get(name)!(args)).content[0]!.text;
    return { call, sessionStore };
  }

  it("detalhar_steps surfaces component name, error from outMessage, and never leaks headers", async () => {
    const body = JSON.stringify({
      items: [
        { status: "DONE", activityLabel: "Timer", resourceType: "QUARTZ", componentDTO: { id: "c1", name: "Timer", iconId: "i" }, inHeaders: "Authorization=Bearer secret", outHeaders: "x" },
        { status: "ERROR", activityLabel: "Lista pendentes", resourceType: "REST", componentDTO: null, outMessage: "<am:fault>boom</am:fault>", inHeaders: "Authorization=Bearer secret" },
      ],
      hasNext: false,
    });
    const { call } = setup2({ get: async () => ({ status: 200, body }) });
    const out = await call("detalhar_steps", { integrationId: "i", createdDate: "2026-10-06T20:42:04.647+00:00", messageId: "m" });
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.incompleteCount).toBe(1);
    expect(parsed.steps[0].component.name).toBe("Timer");
    expect(parsed.steps[1].error).toContain("boom");
    expect(out).not.toContain("Authorization");
    expect(out).not.toContain("secret");
  });

  it("listar_mensagens_filhas lists SPLITTED children", async () => {
    const body = JSON.stringify({ items: [{ id: "child-1", status: "DONE", integrationId: "int-1", createdDate: "2026-10-06T20:42:08.621+00:00" }], hasNext: false, total: 1 });
    let requested = "";
    const api = { getSplittedMessages: async (origin: string) => { requested = origin; return { status: 200, body }; } };
    const { call } = setup2(api);
    const out = await call("listar_mensagens_filhas", { originMessageId: "parent-1" });
    const parsed = JSON.parse(out);
    expect(requested).toBe("parent-1");
    expect(parsed.count).toBe(1);
    expect(parsed.children[0].messageId).toBe("child-1");
    expect(parsed.children[0].integrationId).toBe("int-1");
  });

  it("listar_mensagens_filhas without id guides to listar_mensagens", async () => {
    const { call } = setup2({ getSplittedMessages: async () => ({ status: 200, body: "{}" }) });
    const out = await call("listar_mensagens_filhas", { originMessageId: "  " });
    expect(out).toContain("INVALID_ID");
  });

  it("resumo_por_status returns the status summary and window", async () => {
    const body = JSON.stringify({ DONE: 10, ERROR: 3, PROCESSING: 1, REPROCESSED: 0 });
    const { call } = setup2({ getStatusSummary: async () => ({ status: 200, body }) });
    const out = await call("resumo_por_status", {});
    const parsed = JSON.parse(out);
    expect(parsed.window).toBeDefined();
    expect(parsed.summary.ERROR).toBe(3);
  });

  it("resumo_por_status without session -> missingSession", async () => {
    const sessionStore = new SessionStore();
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient: { getStatusSummary: async () => { throw new Error("should not call"); } } as any, authService: {} as any });
    const out = (await server.handlers.get("resumo_por_status")!({})).content[0]!.text;
    expect(out).toContain("iniciar_login_ipaas");
  });
});
