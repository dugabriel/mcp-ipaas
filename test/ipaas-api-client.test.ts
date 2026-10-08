import { describe, it, expect, vi } from "vitest";
import { IpaasApiClient } from "../src/api/ipaas-api-client.js";
import { SessionStore } from "../src/session/session-store.js";
import { loadConfig } from "../src/config/config.js";
import type { MessageQuery } from "../src/model/types.js";

const config = loadConfig({});

function clientWith(fetchFn: any) {
  const store = new SessionStore();
  store.set({ token: "bearer-123", cookies: [{ name: "jwt.token", value: "c" }], capturedAt: Date.now(), ttlMs: 48 * 3600_000 });
  return { client: new IpaasApiClient(config, store, fetchFn), store };
}

describe("IpaasApiClient.get", () => {
  it("sends Bearer + Cookie and returns status/body on 200", async () => {
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer bearer-123");
      expect(init.headers.Cookie).toBe("jwt.token=c");
      return { status: 200, text: async () => '{"ok":true}' } as any;
    });
    const { client } = clientWith(fetchFn);
    const res = await client.get("/x");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it("clears the session on 401", async () => {
    const fetchFn = vi.fn(async () => ({ status: 401, text: async () => "no" }) as any);
    const { client, store } = clientWith(fetchFn);
    const res = await client.get("/x");
    expect(res.status).toBe(401);
    expect(store.current()).toBeUndefined();
  });

  it("keeps session and returns body on 5xx", async () => {
    const fetchFn = vi.fn(async () => ({ status: 503, text: async () => "down" }) as any);
    const { client, store } = clientWith(fetchFn);
    const res = await client.get("/x");
    expect(res.status).toBe(503);
    expect(store.current()).toBeDefined();
  });

  it("throws when no session", async () => {
    const store = new SessionStore();
    const client = new IpaasApiClient(config, store, vi.fn());
    await expect(client.get("/x")).rejects.toThrow();
  });
});

describe("IpaasApiClient.getMessages clamp", () => {
  async function effectiveLimit(requested: number | undefined): Promise<number> {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => {
      captured = url;
      return { status: 200, text: async () => "[]" } as any;
    });
    const { client } = clientWith(fetchFn);
    const q: MessageQuery = { limit: requested };
    await client.getMessages(q);
    const limit = new URL(captured).searchParams.get("pageSize");
    return Number(limit);
  }

  it("clamps any requested limit into [1,100]", async () => {
    for (const req of [10000, -5, 0, 1, 50, 100, 101, undefined, Number.MAX_SAFE_INTEGER]) {
      const eff = await effectiveLimit(req as number | undefined);
      expect(eff).toBeGreaterThanOrEqual(1);
      expect(eff).toBeLessThanOrEqual(100);
    }
  });

  it("defaults to 20 when limit absent", async () => {
    expect(await effectiveLimit(undefined)).toBe(20);
  });

  it("serializes repeatable filters (status/integrationIds/projectIds/sourceTypes)", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getMessages({ statuses: ["ERROR", "DONE"], integrationIds: ["i1", "i2"], projectIds: ["p1"], sourceTypes: ["ORIGINAL", "SPLITTED"] });
    const sp = new URL(captured).searchParams;
    expect(sp.getAll("status")).toEqual(["ERROR", "DONE"]);
    expect(sp.getAll("integrationIds")).toEqual(["i1", "i2"]);
    expect(sp.getAll("projectIds")).toEqual(["p1"]);
    expect(sp.getAll("sourceTypes")).toEqual(["ORIGINAL", "SPLITTED"]);
  });

  it("passes initialDate=00:00Z through without shifting to Brasilia (03:00Z)", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "[]" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getMessages({ initialDate: new Date("2026-10-08T00:00:00Z"), finalDate: new Date("2026-10-09T00:00:00Z") });
    const p = new URL(captured).searchParams;
    expect(p.get("initialDate")).toBe("2026-10-08T00:00:00.000Z");
    expect(p.get("finalDate")).toBe("2026-10-09T00:00:00.000Z");
  });

  it("applies default 24h window when dates absent", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "[]" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getMessages({});
    const p = new URL(captured).searchParams;
    const initial = new Date(p.get("initialDate")!).getTime();
    const final = new Date(p.get("finalDate")!).getTime();
    expect(final - initial).toBe(24 * 3600_000);
    expect(p.get("sourceTypes")).toBe("ORIGINAL");
  });
});

describe("IpaasApiClient.scanMessages", () => {
  it("paginates until hasNext=false and accumulates all items", async () => {
    // 230 registros com pageSize 100 => paginas de 100,100,30; hasNext true,true,false.
    const pages = [
      { items: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })), hasNext: true, total: 230 },
      { items: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` })), hasNext: true, total: 230 },
      { items: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` })), hasNext: false, total: 230 },
    ];
    const pageSizes: string[] = [];
    const pageParams: string[] = [];
    let idx = 0;
    const fetchFn = vi.fn(async (url: string) => {
      const sp = new URL(url).searchParams;
      pageSizes.push(sp.get("pageSize")!);
      pageParams.push(sp.get("page")!);
      return { status: 200, text: async () => JSON.stringify(pages[idx++]) } as any;
    });
    const { client } = clientWith(fetchFn);
    const scan = await client.scanMessages({ statuses: ["ERROR"], limit: 100 });
    expect(scan.items).toHaveLength(230);
    expect(scan.pagesFetched).toBe(3);
    expect(scan.scanComplete).toBe(true);
    expect(scan.total).toBe(230);
    expect(pageSizes).toEqual(["100", "100", "100"]);
    expect(pageParams).toEqual(["1", "2", "3"]);
    expect(pageSizes.every((s) => Number(s) <= 100)).toBe(true);
  });

  it("respects maxPages and marks scanComplete=false", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ items: [{ id: "x" }], hasNext: true, total: 9999 }) }) as any);
    const { client } = clientWith(fetchFn);
    const scan = await client.scanMessages({ statuses: ["ERROR"], limit: 100 }, { maxPages: 2 });
    expect(scan.pagesFetched).toBe(2);
    expect(scan.scanComplete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stops and returns lastResponse on a non-OK response (e.g. 401)", async () => {
    const fetchFn = vi.fn(async () => ({ status: 401, text: async () => "no" }) as any);
    const { client } = clientWith(fetchFn);
    const scan = await client.scanMessages({ statuses: ["ERROR"] });
    expect(scan.lastResponse.status).toBe(401);
    expect(scan.pagesFetched).toBe(0);
    expect(scan.scanComplete).toBe(false);
  });
});

describe("IpaasApiClient metrics endpoints", () => {
  it("getAccountMetrics builds refDate + forceUpdate on /v3/metrics/commons", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getAccountMetrics("2024-05-10");
    const u = new URL(captured);
    expect(u.pathname).toBe("/ipaas/api/v3/metrics/commons");
    expect(u.searchParams.get("refDate")).toBe("2024-05-10");
    expect(u.searchParams.get("forceUpdate")).toBe("false");
  });

  it("getDiagramsTransactions builds initialDate/endDate on /v3/metrics/diagrams-transactions", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getDiagramsTransactions("2024-05-01", "2024-05-10");
    const u = new URL(captured);
    expect(u.pathname).toBe("/ipaas/api/v3/metrics/diagrams-transactions");
    expect(u.searchParams.get("initialDate")).toBe("2024-05-01");
    expect(u.searchParams.get("endDate")).toBe("2024-05-10");
    expect(u.searchParams.get("forceUpdate")).toBe("false");
  });
});

describe("IpaasApiClient.getDiagramFlow", () => {
  it("builds diagramId + fieldsReturn + pageSize and NO lastVersion when diagramId given", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getDiagramFlow({ diagramId: "diag-1" });
    const u = new URL(captured);
    expect(u.pathname).toBe("/ipaas/api/v3/integrations");
    expect(u.searchParams.get("diagramId")).toBe("diag-1");
    expect(u.searchParams.get("fieldsReturn")).toBe("id,diagramId,flow,name,active,description,publishVersion,status");
    expect(u.searchParams.get("pageSize")).toBe("1");
    expect(u.searchParams.get("lastVersion")).toBeNull();
    expect(u.searchParams.get("id")).toBeNull();
  });

  it("builds id + lastVersion=true (and no diagramId) when integrationId given", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getDiagramFlow({ integrationId: "int-1" });
    const u = new URL(captured);
    expect(u.pathname).toBe("/ipaas/api/v3/integrations");
    expect(u.searchParams.get("id")).toBe("int-1");
    expect(u.searchParams.get("lastVersion")).toBe("true");
    expect(u.searchParams.get("diagramId")).toBeNull();
    expect(u.searchParams.get("pageSize")).toBe("1");
  });

  it("prefers diagramId over integrationId when both given", async () => {
    let captured = "";
    const fetchFn = vi.fn(async (url: string) => { captured = url; return { status: 200, text: async () => "{}" } as any; });
    const { client } = clientWith(fetchFn);
    await client.getDiagramFlow({ diagramId: "diag-1", integrationId: "int-1" });
    const u = new URL(captured);
    expect(u.searchParams.get("diagramId")).toBe("diag-1");
    expect(u.searchParams.get("id")).toBeNull();
    expect(u.searchParams.get("lastVersion")).toBeNull();
  });
});
