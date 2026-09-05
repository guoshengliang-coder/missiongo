import { describe, expect, it } from "vitest";

import { trustProxySetting } from "./config.js";

describe("trustProxySetting", () => {
  it("defaults to trusting no proxy", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("   ")).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
  });

  it("supports trusting every peer explicitly", () => {
    expect(trustProxySetting("true")).toBe(true);
  });

  it("passes through address, CIDR, and named ranges", () => {
    expect(trustProxySetting("loopback,uniquelocal")).toBe("loopback,uniquelocal");
    expect(trustProxySetting(" 10.0.0.0/8 ")).toBe("10.0.0.0/8");
  });

  it("rejects numeric hop counts that Fastify would silently ignore", () => {
    // Fastify maps a numeric trustProxy to "trust nothing", so accepting `2`
    // here would quietly disable every X-Forwarded-* header instead of
    // trusting two hops.
    expect(() => trustProxySetting("2")).toThrowError(/numeric hop counts/);
  });
});
