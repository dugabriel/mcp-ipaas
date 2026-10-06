import { describe, it, expect } from "vitest";
import { maskToken } from "../src/util/token-masker.js";

describe("maskToken", () => {
  it("hides the middle of a long token", () => {
    const masked = maskToken("abcdef0123456789xyz9");
    expect(masked).not.toContain("abcdef0123456789xyz9");
    expect(masked).toContain("\u2026");
  });
  it("null/empty become neutral marker", () => {
    expect(maskToken(null)).toBe("****");
    expect(maskToken("")).toBe("****");
  });
  it("short token is fully masked", () => {
    expect(maskToken("abcd")).toBe("****");
    expect(maskToken("abcdefgh")).toBe("****");
  });
});
