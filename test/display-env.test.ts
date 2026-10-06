import { describe, it, expect } from "vitest";
import { ensureGraphicalEnv } from "../src/auth/display-env.js";

describe("ensureGraphicalEnv", () => {
  it("sets DISPLAY to :0 on Linux when none is defined", () => {
    if (process.platform !== "linux") return; // no-op fora do Linux
    const env: NodeJS.ProcessEnv = {};
    ensureGraphicalEnv(env);
    expect(env.DISPLAY).toBe(":0");
  });

  it("does not override an existing DISPLAY", () => {
    if (process.platform !== "linux") return;
    const env: NodeJS.ProcessEnv = { DISPLAY: ":1" };
    ensureGraphicalEnv(env);
    expect(env.DISPLAY).toBe(":1");
  });

  it("does not set DISPLAY when WAYLAND_DISPLAY is present", () => {
    if (process.platform !== "linux") return;
    const env: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: "wayland-0" };
    ensureGraphicalEnv(env);
    expect(env.DISPLAY).toBeUndefined();
  });

  it("is a no-op on non-Linux platforms (does not touch DISPLAY)", () => {
    if (process.platform === "linux") return;
    const env: NodeJS.ProcessEnv = {};
    ensureGraphicalEnv(env);
    expect(env.DISPLAY).toBeUndefined();
  });
});
