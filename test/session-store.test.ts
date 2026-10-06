import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/session/session-store.js";
import type { IpaasSession } from "../src/model/types.js";

const session = (capturedAt: number, ttlMs: number): IpaasSession => ({
  token: "tok",
  cookies: [],
  capturedAt,
  ttlMs,
});

describe("SessionStore", () => {
  it("is AUSENTE when empty", () => {
    expect(new SessionStore().state()).toBe("AUSENTE");
  });
  it("is ATIVA within ttl", () => {
    const s = new SessionStore();
    s.set(session(Date.now(), 3600_000));
    expect(s.state()).toBe("ATIVA");
  });
  it("is EXPIRADA after ttl", () => {
    const s = new SessionStore();
    s.set(session(Date.now() - 7200_000, 3600_000));
    expect(s.state()).toBe("EXPIRADA");
  });
  it("clear returns to AUSENTE", () => {
    const s = new SessionStore();
    s.set(session(Date.now(), 3600_000));
    s.clear();
    expect(s.state()).toBe("AUSENTE");
    expect(s.current()).toBeUndefined();
  });
  it("expired never returns to ATIVA without a new set", () => {
    const s = new SessionStore();
    s.set(session(Date.now() - 7200_000, 3600_000));
    for (let i = 0; i < 50; i++) {
      s.current();
      expect(s.state()).not.toBe("ATIVA");
    }
    s.set(session(Date.now(), 3600_000));
    expect(s.state()).toBe("ATIVA");
  });
});
