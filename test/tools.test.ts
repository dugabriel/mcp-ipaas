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
    const apiClient = {
      scanMessages: vi.fn(async () => ({ items: [], pagesFetched: 1, scanComplete: true, total: 0, lastResponse: resp(200, "[]") })),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", {});
    expect(out).toContain("NO_ERRORS");
    expect(out).toContain("ambiente limpo");
  });

  it("resumir_erros aggregates and orders by frequency", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    // Modelo real: a listagem traz finalComponent (nao o texto do erro); agrupamos por componente.
    const items = [
      { id: "1", status: "ERROR", finalComponent: "Usar stored Token" },
      { id: "2", status: "ERROR", finalComponent: "Usar stored Token" },
      { id: "3", status: "ERROR", finalComponent: "Usar stored Token" },
      { id: "4", status: "ERROR", finalComponent: "Lista pendentes" },
      { id: "5", status: "ERROR", finalComponent: "Lista pendentes" },
      { id: "6", status: "ERROR", diagramName: "Flow X" },
    ];
    const apiClient = {
      scanMessages: vi.fn(async () => ({ items, pagesFetched: 1, scanComplete: true, total: 6, lastResponse: resp(200, "{}") })),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", {});
    const parsed = JSON.parse(out);
    expect(parsed.sampling).toBe(true);
    expect(parsed.distinctErrorTypes).toBe(3);
    expect(parsed.scanComplete).toBe(true);
    expect(parsed.truncated).toBe(false);
    expect(parsed.errors[0].type).toBe("finalComponent: Usar stored Token");
    expect(parsed.errors[0].count).toBe(3);
    expect(out).not.toContain("UNKNOWN_ERROR");
  });

  it("resumir_erros without incluirFilhas does not forward sourceTypes", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    let captured: any;
    const apiClient = {
      scanMessages: vi.fn(async (q: any) => { captured = q; return { items: [{ id: "1", status: "ERROR", finalComponent: "X" }], pagesFetched: 1, scanComplete: true, total: 1, lastResponse: resp(200, "{}") }; }),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    await call("resumir_erros", {});
    expect(captured.sourceTypes).toBeUndefined();
    expect(captured.statuses).toEqual(["ERROR"]);
  });

  it("resumir_erros incluirFilhas=true forwards ORIGINAL+SPLITTED", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    let captured: any;
    const apiClient = {
      scanMessages: vi.fn(async (q: any) => { captured = q; return { items: [{ id: "1", status: "ERROR", finalComponent: "X" }], pagesFetched: 1, scanComplete: true, total: 1, lastResponse: resp(200, "{}") }; }),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", { incluirFilhas: true });
    expect(captured.sourceTypes).toEqual(["ORIGINAL", "SPLITTED"]);
    expect(JSON.parse(out).incluiFilhas).toBe(true);
  });

  it("resumir_erros flags truncated/scanComplete when the scan hits the page cap", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = {
      scanMessages: vi.fn(async () => ({ items: [{ id: "1", status: "ERROR", finalComponent: "X" }], pagesFetched: 50, scanComplete: false, total: 9999, lastResponse: resp(200, "{}") })),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    const out = await call("resumir_erros", {});
    const parsed = JSON.parse(out);
    expect(parsed.scanComplete).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.refineHint).toBeDefined();
    expect(parsed.pagesFetched).toBe(50);
  });

  it("resumir_erros 401 from the scan -> SESSION_EXPIRED", async () => {
    const sessionStore = new SessionStore(); sessionStore.set(activeSession());
    const apiClient = {
      scanMessages: vi.fn(async () => ({ items: [], pagesFetched: 0, scanComplete: false, total: null, lastResponse: resp(401, "no") })),
    } as any;
    const { call } = setup({ apiClient, sessionStore });
    expect(await call("resumir_erros", {})).toContain("SESSION_EXPIRED");
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

  it("resumo_por_status parses the real { messages:[{status,size}], total } shape", async () => {
    // Corpo real do endpoint: array de {status, size} + total; status ausentes = 0.
    const body = JSON.stringify({
      messages: [
        { status: "DONE", size: 10 },
        { status: "ERROR", size: 3 },
        { status: "PROCESSING", size: 1 },
      ],
      total: 14,
    });
    const { call } = setup2({ getStatusSummary: async () => ({ status: 200, body }) });
    const out = await call("resumo_por_status", {});
    const parsed = JSON.parse(out);
    expect(parsed.window).toBeDefined();
    expect(parsed.summary.ERROR).toBe(3);
    expect(parsed.summary.DONE).toBe(10);
    expect(parsed.summary.PROCESSING).toBe(1);
    expect(parsed.summary.REPROCESSED).toBe(0);
    expect(parsed.summary.total).toBe(14);
    expect(parsed.incluiFilhas).toBe(true);
  });

  it("listar_filtros_disponiveis normalizes integrations and projects", async () => {
    const body = JSON.stringify({
      integrationsFilters: {
        publishedIntegrations: [
          { id: "int-pub-1", name: "Pedido de Venda", projectId: "proj-1", reprocessable: true },
          { id: "int-pub-2", name: "Nota Fiscal", projectId: "proj-1", reprocessable: false },
        ],
        archivedIntegrations: [
          { id: "int-arc-1", name: "Pedido Legado", projectId: "proj-2", reprocessable: false },
        ],
      },
      projectsFilter: {
        activateProjects: [
          { id: "proj-1", name: "Vendas" },
          { id: "proj-2", name: "Fiscal" },
        ],
        deactivateProjects: [{ id: "proj-3", name: "Compras Antigo" }],
      },
    });
    const { call } = setup2({ getMessageFilters: async () => ({ status: 200, body }) });
    const out = await call("listar_filtros_disponiveis", {});
    const parsed = JSON.parse(out);
    expect(parsed.integrations.total).toBe(3);
    expect(parsed.projects.total).toBe(3);
    const archived = parsed.integrations.items.find((i) => i.id === "int-arc-1");
    expect(archived.archived).toBe(true);
    const published = parsed.integrations.items.find((i) => i.id === "int-pub-1");
    expect(published.archived).toBe(false);
    expect(published.projectId).toBe("proj-1");
    const inactive = parsed.projects.items.find((p) => p.id === "proj-3");
    expect(inactive.active).toBe(false);
    expect(out).not.toContain("token-secret");
  });

  it("listar_filtros_disponiveis filters by name (case-insensitive) across types", async () => {
    const body = JSON.stringify({
      integrationsFilters: {
        publishedIntegrations: [
          { id: "int-pub-1", name: "Pedido de Venda", projectId: "proj-1", reprocessable: true },
          { id: "int-pub-2", name: "Nota Fiscal", projectId: "proj-1", reprocessable: false },
        ],
        archivedIntegrations: [
          { id: "int-arc-1", name: "Pedido Legado", projectId: "proj-2", reprocessable: false },
        ],
      },
      projectsFilter: {
        activateProjects: [
          { id: "proj-1", name: "Vendas" },
          { id: "proj-2", name: "Fiscal" },
        ],
        deactivateProjects: [{ id: "proj-3", name: "Compras Antigo" }],
      },
    });
    const { call } = setup2({ getMessageFilters: async () => ({ status: 200, body }) });
    const out = await call("listar_filtros_disponiveis", { search: "pedido" });
    const parsed = JSON.parse(out);
    expect(parsed.search).toBe("pedido");
    expect(parsed.integrations.total).toBe(2);
    expect(parsed.integrations.items.map((i) => i.id).sort()).toEqual(["int-arc-1", "int-pub-1"]);
    expect(parsed.projects.total).toBe(0);
  });

  it("listar_filtros_disponiveis respects the per-type cap and flags truncation", async () => {
    const body = JSON.stringify({
      integrationsFilters: {
        publishedIntegrations: [
          { id: "int-pub-1", name: "Pedido de Venda", projectId: "proj-1", reprocessable: true },
          { id: "int-pub-2", name: "Nota Fiscal", projectId: "proj-1", reprocessable: false },
        ],
        archivedIntegrations: [
          { id: "int-arc-1", name: "Pedido Legado", projectId: "proj-2", reprocessable: false },
        ],
      },
      projectsFilter: {
        activateProjects: [
          { id: "proj-1", name: "Vendas" },
          { id: "proj-2", name: "Fiscal" },
        ],
        deactivateProjects: [{ id: "proj-3", name: "Compras Antigo" }],
      },
    });
    const { call } = setup2({ getMessageFilters: async () => ({ status: 200, body }) });
    const out = await call("listar_filtros_disponiveis", { limit: 1 });
    const parsed = JSON.parse(out);
    expect(parsed.integrations.count).toBe(1);
    expect(parsed.integrations.total).toBe(3);
    expect(parsed.truncated).toBe(true);
    expect(parsed.refineHint).toBeDefined();
  });

  it("listar_filtros_disponiveis 401 -> SESSION_EXPIRED", async () => {
    const { call } = setup2({ getMessageFilters: async () => ({ status: 401, body: "no" }) });
    expect(await call("listar_filtros_disponiveis", {})).toContain("SESSION_EXPIRED");
  });

  it("listar_filtros_disponiveis without session -> missingSession", async () => {
    const sessionStore = new SessionStore();
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient: { getMessageFilters: async () => { throw new Error("should not call"); } } as any, authService: {} as any });
    const out = (await server.handlers.get("listar_filtros_disponiveis")!({})).content[0]!.text;
    expect(out).toContain("iniciar_login_ipaas");
  });

  it("resumo_por_status without session -> missingSession", async () => {
    const sessionStore = new SessionStore();
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient: { getStatusSummary: async () => { throw new Error("should not call"); } } as any, authService: {} as any });
    const out = (await server.handlers.get("resumo_por_status")!({})).content[0]!.text;
    expect(out).toContain("iniciar_login_ipaas");
  });

  // Mock das 4 fontes do panorama; getMessages devolve o total de erros SO ORIGINAL (baseline).
  function panoramaApi(opts: { statusError: number; originalError: number }) {
    return {
      getAccountMetrics: async () => ({
        status: 200,
        body: JSON.stringify({ planName: "ENTERPRISE", projects: 12, diagrams: 246, totalMessages: 797597, totalMessagesSuccess: 781504, totalMessagesError: 16398, messagesPerMinute: 41, avgExecutionTime: 4 }),
      }),
      getStatusSummary: async () => ({
        status: 200,
        body: JSON.stringify({ messages: [{ status: "DONE", size: 1000 }, { status: "ERROR", size: opts.statusError }], total: 1000 + opts.statusError }),
      }),
      getMessages: async () => ({ status: 200, body: JSON.stringify({ items: [], hasNext: true, total: opts.originalError }) }),
      getDiagramsTransactions: async () => ({
        status: 200,
        body: JSON.stringify({
          totalMessages: 300,
          diagramsTransactions: [
            { totalMessages: 50, integrationId: "i1", diagramName: "Flow A", projectName: "P1" },
            { totalMessages: 200, integrationId: "i2", diagramName: "Flow B", projectName: "P1" },
            { totalMessages: 10, integrationId: "i3", diagramName: "Flow C", projectName: "P2" },
          ],
        }),
      }),
    };
  }

  it("panorama_saude recommends investigating children when erros-com-filhas >> so-original", async () => {
    // 120 erros com filhas vs 10 so originais => razao 12 (>1.5) => recomendacao presente.
    const { call } = setup2(panoramaApi({ statusError: 120, originalError: 10 }));
    const out = await call("panorama_saude", {});
    const parsed = JSON.parse(out);
    expect(parsed.incluiFilhas).toBe(true);
    expect(parsed.errosComFilhas).toBe(120);
    expect(parsed.errosSoOriginal).toBe(10);
    expect(parsed.playbook.recomendado).toBe(true);
    expect(parsed.recomendacao).toBeDefined();
    expect(parsed.recomendacao.razao).toBe(12);
    expect(parsed.recomendacao.nextStep).toContain("incluirFilhas");
    // topFlows ordenado desc por volume e cortado.
    expect(parsed.topFlows[0].diagramName).toBe("Flow B");
    expect(parsed.topFlows[0].totalMessages).toBe(200);
    expect(out).not.toContain("token-secret");
  });

  it("panorama_saude: no recommendation when errors are balanced", async () => {
    // 12 com filhas vs 10 so originais => razao 1.2 (<1.5) => sem recomendacao.
    const { call } = setup2(panoramaApi({ statusError: 12, originalError: 10 }));
    const out = await call("panorama_saude", {});
    const parsed = JSON.parse(out);
    expect(parsed.playbook.recomendado).toBe(false);
    expect(parsed.recomendacao).toBeUndefined();
  });

  it("panorama_saude respects topFlows cap", async () => {
    const { call } = setup2(panoramaApi({ statusError: 120, originalError: 10 }));
    const out = await call("panorama_saude", { topFlows: 1 });
    const parsed = JSON.parse(out);
    expect(parsed.topFlows).toHaveLength(1);
    expect(parsed.topFlows[0].diagramName).toBe("Flow B");
  });

  it("panorama_saude without session -> missingSession", async () => {
    const sessionStore = new SessionStore();
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient: { getAccountMetrics: async () => { throw new Error("should not call"); } } as any, authService: {} as any });
    const out = (await server.handlers.get("panorama_saude")!({})).content[0]!.text;
    expect(out).toContain("iniciar_login_ipaas");
  });

  it("panorama_saude signals unavailable optional sources without failing", async () => {
    const api = {
      getAccountMetrics: async () => ({ status: 500, body: "boom" }),
      getStatusSummary: async () => ({ status: 200, body: JSON.stringify({ messages: [{ status: "ERROR", size: 5 }], total: 5 }) }),
      getMessages: async () => ({ status: 200, body: JSON.stringify({ items: [], hasNext: false, total: 5 }) }),
      getDiagramsTransactions: async () => ({ status: 500, body: "boom" }),
    };
    const { call } = setup2(api);
    const out = await call("panorama_saude", {});
    const parsed = JSON.parse(out);
    expect(parsed.accountMetrics).toBeNull();
    expect(parsed.topFlows).toBeNull();
    expect(parsed.sourcesUnavailable).toContain("metrics/commons");
    expect(parsed.sourcesUnavailable).toContain("metrics/diagrams-transactions");
  });

  // --- avaliar_diagrama -----------------------------------------------------
  // Fixtures minimas reproduzindo as 3 topologias reais. Empacotadas no envelope { items, hasNext }.

  // 1) Ingest Production - Datalake Sentinela: WEBHOOK -> 1 REST. nodeCount 2.
  function flowSimples() {
    return {
      items: [
        {
          id: "int-ingest",
          diagramId: "diag-ingest",
          name: "Ingest Production - Datalake Sentinela",
          status: "PUBLISHED",
          active: true,
          publishVersion: 3,
          description: "Ingestao datalake",
          flow: {
            start: "webhook-hook-trigger",
            activities: {
              "webhook-hook-trigger": { id: "webhook-hook-trigger", type: "WEBHOOK", label: "Webhook", connections: { next: ["rest-1"], previous: [] } },
              "rest-1": { id: "rest-1", type: "REST", label: "POST-Datalake", connections: { next: [], previous: ["webhook-hook-trigger"] }, configurations: { url: "https://interno/datalake", accountId: "acc-secret" } },
            },
            functions: {},
          },
        },
      ],
      hasNext: false,
    };
  }

  // 2) 10-Prospects-PROD: QUARTZ -> REST -> condicoes -> JAVASCRIPT -> REST -> SPLIT; com GLOBAL_ERROR.
  // nodeCount 10, functionCount 6. typeCounts {REST:4,CONDITION:2,SPLIT:1,GLOBAL_ERROR:1,JAVASCRIPT:1,QUARTZ:1}.
  function flowComplexo() {
    const rest = (id: string, next: string[], prev: string[]) => ({ id, type: "REST", label: id, connections: { next, previous: prev } });
    return {
      items: [
        {
          id: "int-prospects",
          diagramId: "diag-prospects",
          name: "10-Prospects-PROD",
          status: "PUBLISHED",
          active: true,
          publishVersion: 219,
          description: "Prospects",
          flow: {
            start: "quartz-1",
            activities: {
              "quartz-1": { id: "quartz-1", type: "QUARTZ", label: "Timer", connections: { next: ["rest-a"], previous: [] } },
              "rest-a": rest("rest-a", ["rest-a#js-1", "rest-a#rest-b"], ["quartz-1"]),
              // dois nos de condicao origem#destino (type CONDITION)
              "rest-a#js-1": { id: "rest-a#js-1", type: "CONDITION", label: "tem prospect", connections: { next: ["js-1"], previous: ["rest-a"] }, configurations: { conditions: "SENSIVEL" } },
              "rest-a#rest-b": { id: "rest-a#rest-b", type: "CONDITION", label: "senao", connections: { next: ["rest-b"], previous: ["rest-a"] } },
              "js-1": { id: "js-1", type: "JAVASCRIPT", label: "transforma", connections: { next: ["rest-c"], previous: ["rest-a#js-1"] } },
              "rest-b": rest("rest-b", ["split-1"], ["rest-a#rest-b"]),
              "rest-c": rest("rest-c", ["split-1"], ["js-1"]),
              "split-1": { id: "split-1", type: "SPLIT", label: "divide lote", connections: { next: ["rest-d"], previous: ["rest-b", "rest-c"] }, configurations: { subFlow: { start: "splitter-start1", activities: { "splitter-start1": { id: "splitter-start1", type: "SPLIT_START", label: "inicio split", connections: { next: [], previous: [] } } } } } },
              "rest-d": rest("rest-d", [], ["split-1"]),
              // No GLOBAL_ERROR no fluxo principal (como no diagrama real).
              "id-global-error": { id: "id-global-error", type: "GLOBAL_ERROR", label: "trata erro", connections: { next: [], previous: [] } },
            },
            functions: { f1: {}, f2: {}, f3: {}, f4: {}, f5: {}, f6: {} },
            globalErrorFlow: {
              start: "global-error-start",
              activities: {
                "global-error-start": { id: "global-error-start", type: "GLOBAL_ERROR", label: "trata erro", connections: { next: [], previous: [] } },
              },
            },
          },
        },
      ],
      hasNext: false,
    };
  }

  // 3) COLETORA-BEYONDTRUST-SIEM_EVENTS-CLEANER: WEBHOOK -> DIAGRAM_CALLER + GLOBAL_ERROR. nodeCount 3.
  function flowDependencia() {
    return {
      items: [
        {
          id: "int-cleaner",
          diagramId: "diag-cleaner",
          name: "COLETORA-BEYONDTRUST-SIEM_EVENTS-CLEANER",
          status: "PUBLISHED",
          active: true,
          publishVersion: 7,
          description: "Cleaner",
          flow: {
            start: "webhook-hook-trigger",
            activities: {
              "webhook-hook-trigger": { id: "webhook-hook-trigger", type: "WEBHOOK", label: "Webhook", connections: { next: ["caller-1"], previous: [] } },
              "caller-1": { id: "caller-1", type: "DIAGRAM_CALLER", label: "chama limpeza", connections: { next: [], previous: ["webhook-hook-trigger"] } },
              "id-global-error": { id: "id-global-error", type: "GLOBAL_ERROR", label: "trata erro", connections: { next: [], previous: [] } },
            },
            functions: {},
            globalErrorFlow: { start: "global-error-start", activities: { "global-error-start": { id: "global-error-start", type: "GLOBAL_ERROR", label: "ge", connections: { next: [], previous: [] } } } },
          },
        },
      ],
      hasNext: false,
    };
  }

  it("avaliar_diagrama (topologia simples) por diagramId: WEBHOOK -> REST", async () => {
    let requested: any = null;
    const api = { getDiagramFlow: async (p: any) => { requested = p; return { status: 200, body: JSON.stringify(flowSimples()) }; } };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { diagramId: "diag-ingest" });
    const parsed = JSON.parse(out);
    expect(requested).toEqual({ diagramId: "diag-ingest", integrationId: undefined });
    expect(parsed.nodeCount).toBe(2);
    expect(parsed.typeCounts).toEqual({ REST: 1, WEBHOOK: 1 });
    expect(parsed.hasSplitter).toBe(false);
    expect(parsed.hasGlobalError).toBe(false);
    expect(parsed.hasDiagramCaller).toBe(false);
    expect(parsed.diagramCallers).toEqual([]);
    expect(parsed.metadata.trigger).toBe("WEBHOOK");
    expect(parsed.components).toHaveLength(2);
    expect(parsed.path[0]).toBe("WEBHOOK: Webhook");
    expect(parsed.nextStep).toBe("detalhar_steps");
    expect(out).not.toContain("token-secret");
  });

  it("avaliar_diagrama (topologia complexa) por integrationId: resolve lastVersion e extrai sinais", async () => {
    let requested: any = null;
    const api = { getDiagramFlow: async (p: any) => { requested = p; return { status: 200, body: JSON.stringify(flowComplexo()) }; } };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { integrationId: "int-prospects" });
    const parsed = JSON.parse(out);
    expect(requested).toEqual({ diagramId: undefined, integrationId: "int-prospects" });
    expect(parsed.nodeCount).toBe(10);
    expect(parsed.functionCount).toBe(6);
    expect(parsed.typeCounts).toEqual({ REST: 4, CONDITION: 2, SPLIT: 1, GLOBAL_ERROR: 1, JAVASCRIPT: 1, QUARTZ: 1 });
    expect(parsed.hasSplitter).toBe(true);
    expect(parsed.hasGlobalError).toBe(true);
    expect(parsed.diagramCallers).toEqual([]);
    expect(parsed.metadata.status).toBe("PUBLISHED");
    expect(parsed.metadata.active).toBe(true);
    expect(parsed.metadata.publishVersion).toBe(219);
    expect(parsed.metadata.trigger).toBe("QUARTZ");
    // subFlow do splitter e globalError entram em components com scope marcado.
    expect(parsed.components.some((c: any) => c.scope === "splitter:split-1")).toBe(true);
    expect(parsed.components.some((c: any) => c.scope === "globalError")).toBe(true);
    // arestas via condicao resolvem origem#destino, SEM vazar o conteudo das conditions.
    expect(parsed.edges.length).toBeGreaterThanOrEqual(1);
    expect(out).not.toContain("SENSIVEL");
  });

  it("avaliar_diagrama (topologia com dependencia): DIAGRAM_CALLER + GLOBAL_ERROR", async () => {
    const api = { getDiagramFlow: async () => ({ status: 200, body: JSON.stringify(flowDependencia()) }) };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { diagramId: "diag-cleaner" });
    const parsed = JSON.parse(out);
    expect(parsed.nodeCount).toBe(3);
    expect(parsed.hasDiagramCaller).toBe(true);
    expect(parsed.diagramCallers).toEqual(["chama limpeza"]);
    expect(parsed.hasGlobalError).toBe(true);
    expect(parsed.typeCounts).toEqual({ WEBHOOK: 1, DIAGRAM_CALLER: 1, GLOBAL_ERROR: 1 });
  });

  it("avaliar_diagrama NAO vaza configurations (MAIL/REST/JOLT), positions, nem connectionPath", async () => {
    const envelope = {
      items: [
        {
          id: "int-sec",
          diagramId: "diag-sec",
          name: "Fluxo sensivel",
          status: "PUBLISHED",
          active: true,
          publishVersion: 1,
          flow: {
            start: "webhook-hook-trigger",
            activities: {
              "webhook-hook-trigger": { id: "webhook-hook-trigger", type: "WEBHOOK", label: "Webhook", positions: { x: 10, y: 20 }, connections: { next: ["rest-x"], previous: [] } },
              "rest-x": { id: "rest-x", type: "REST", label: "chama API", connections: { next: ["jolt-x"], previous: ["webhook-hook-trigger"], connectionPath: "M0,0 L10,10", finalConnections: ["z"] }, configurations: { url: "https://secret-host/api", accountId: "ACCT-9999", headers: { Authorization: "Bearer super-secret-token" } } },
              "jolt-x": { id: "jolt-x", type: "JOLT", label: "mapeia", connections: { next: ["mail-x"], previous: ["rest-x"] }, configurations: { spec: "[{\"operation\":\"shift\",\"spec\":{\"a\":\"b\"}}]" } },
              "mail-x": { id: "mail-x", type: "MAIL", label: "notifica", connections: { next: [], previous: ["jolt-x"] }, configurations: { to: "pessoa@empresa.com", subject: "alerta", body: "corpo-sigiloso-do-email" } },
            },
            functions: {},
          },
        },
      ],
      hasNext: false,
    };
    const api = { getDiagramFlow: async () => ({ status: 200, body: JSON.stringify(envelope) }) };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { diagramId: "diag-sec" });
    // Topologia extraida corretamente...
    const parsed = JSON.parse(out);
    expect(parsed.typeCounts).toEqual({ WEBHOOK: 1, REST: 1, JOLT: 1, MAIL: 1 });
    // ...mas NADA sensivel vaza.
    expect(out).not.toContain("configurations");
    expect(out).not.toContain("positions");
    expect(out).not.toContain("connectionPath");
    expect(out).not.toContain("finalConnections");
    expect(out).not.toContain("pessoa@empresa.com");
    expect(out).not.toContain("corpo-sigiloso-do-email");
    expect(out).not.toContain("https://secret-host/api");
    expect(out).not.toContain("ACCT-9999");
    expect(out).not.toContain("super-secret-token");
    expect(out).not.toContain("shift");
  });

  it("avaliar_diagrama por messageId resolve diagrama e inclui detalharStepsArgs", async () => {
    const messageDetail = JSON.stringify({ id: "msg-1", diagramId: "diag-ingest", integrationId: "int-ingest", createdDate: "2024-05-01T12:00:00Z", status: "ERROR" });
    let messageCalled = false;
    let flowCalled = false;
    const api = {
      get: async (path: string) => { messageCalled = true; expect(path).toContain("msg-1"); return { status: 200, body: messageDetail }; },
      getDiagramFlow: async (p: any) => { flowCalled = true; expect(p.diagramId).toBe("diag-ingest"); return { status: 200, body: JSON.stringify(flowSimples()) }; },
    };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { messageId: "msg-1" });
    const parsed = JSON.parse(out);
    expect(messageCalled).toBe(true);
    expect(flowCalled).toBe(true);
    expect(parsed.detalharStepsArgs).toEqual({ integrationId: "int-ingest", createdDate: "2024-05-01T12:00:00Z", messageId: "msg-1" });
    expect(parsed.nodeCount).toBe(2);
  });

  it("avaliar_diagrama com diagramId + messageId NAO chama o detalhe da mensagem (precedencia)", async () => {
    let messageCalled = false;
    const api = {
      get: async () => { messageCalled = true; return { status: 200, body: "{}" }; },
      getDiagramFlow: async () => ({ status: 200, body: JSON.stringify(flowSimples()) }),
    };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", { diagramId: "diag-ingest", messageId: "msg-1" });
    expect(messageCalled).toBe(false);
    expect(JSON.parse(out).nodeCount).toBe(2);
  });

  it("avaliar_diagrama sem nenhum id -> INVALID_INPUT e nao chama a API", async () => {
    let called = false;
    const api = { getDiagramFlow: async () => { called = true; return { status: 200, body: "{}" }; } };
    const { call } = setup2(api);
    const out = await call("avaliar_diagrama", {});
    expect(out).toContain("INVALID_INPUT");
    expect(called).toBe(false);
  });

  it("avaliar_diagrama sem sessao -> missingSession", async () => {
    const sessionStore = new SessionStore();
    const server = new FakeMcpServer();
    registerIpaasTools(server as any, { config, sessionStore, apiClient: { getDiagramFlow: async () => { throw new Error("should not call"); } } as any, authService: {} as any });
    const out = (await server.handlers.get("avaliar_diagrama")!({ diagramId: "d" })).content[0]!.text;
    expect(out).toContain("iniciar_login_ipaas");
  });

  it("avaliar_diagrama 401 -> SESSION_EXPIRED", async () => {
    const { call } = setup2({ getDiagramFlow: async () => ({ status: 401, body: "no" }) });
    expect(await call("avaliar_diagrama", { diagramId: "d" })).toContain("SESSION_EXPIRED");
  });
});
