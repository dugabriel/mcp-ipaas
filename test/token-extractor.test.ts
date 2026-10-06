import { describe, it, expect } from "vitest";
import { extractToken } from "../src/auth/token-extractor.js";

describe("extractToken", () => {
  it("prefers the jwt.token cookie", () => {
    expect(extractToken([{ name: "jwt.token", value: "cookie-tok" }], { authToken: "store" })).toBe("cookie-tok");
  });
  it("falls back to storage when no jwt cookie", () => {
    expect(extractToken([{ name: "other", value: "x" }], { "app.authToken": "store-tok" })).toBe("store-tok");
  });
  it("recognizes a Bearer storage key", () => {
    expect(extractToken([], { sessionBearer: "bearer-tok" })).toBe("bearer-tok");
  });
  it("ignores storage keys without a hint", () => {
    expect(extractToken([], { whatever: "v" })).toBeUndefined();
  });
  it("blank jwt cookie falls back to storage", () => {
    expect(extractToken([{ name: "jwt.token", value: "  " }], { authToken: "store-tok" })).toBe("store-tok");
  });
  it("returns undefined when nothing usable", () => {
    expect(extractToken([], {})).toBeUndefined();
    expect(extractToken(null, null)).toBeUndefined();
  });
});
