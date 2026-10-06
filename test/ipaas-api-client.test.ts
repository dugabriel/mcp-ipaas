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
