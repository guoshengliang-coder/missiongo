import { describe, expect, it } from "vitest";
import { settingsRoute, settingsUrl, settingsExitUrl } from "./settings-state";

describe("settings URLs", () => {
  it("restores personal, administrator and product deep links", () => {
    expect(settingsRoute(new URL("https://example.test/settings/connections"))).toEqual({ section: "connections" });
    expect(settingsRoute(new URL("https://example.test/settings/admin/ai"))).toEqual({ section: "ai" });
    expect(settingsRoute(new URL("https://example.test/settings/products/a%20b/access"))).toEqual({ section: "access", productId: "a b" });
    expect(settingsRoute(new URL("https://example.test/"))).toBeNull();
  });
  it("uses the directory for unknown or malformed routes", () => {
    expect(settingsRoute(new URL("https://example.test/settings/missing"))).toEqual({ section: "index" });
    expect(settingsRoute(new URL("https://example.test/settings/products/%E0%A4%A/product"))).toEqual({ section: "index" });
  });
  it("preserves the original workspace location across entry and exit", () => {
    const original = new URL("https://example.test/?product=workspace&status=ready&console=agent#position");
    const url = settingsUrl({ section: "product", productId: "another/id" }, original);
    expect(url).toBe("/settings/products/another%2Fid/product?product=workspace&status=ready&console=agent#position");
    expect(settingsExitUrl(new URL(url, original))).toBe("/?product=workspace&status=ready&console=agent#position");
  });
});

describe("settings V2 hierarchy", () => {
  it("round-trips module, device and account details without changing workspace context", () => {
    for (const route of [
      { section: "agent" as const }, { section: "products" as const },
      { section: "overview" as const, productId: "a/b" },
      { section: "components" as const, productId: "a/b", componentId: "c d" },
      { section: "devices" as const, nodeId: "node/one" },
      { section: "accounts" as const, accountId: "a/b", filterProductId: "product a" },
      { section: "access" as const, productId: "owned" },
    ]) {
      const base = new URL("https://example.test/?product=workspace#position");
      const next = new URL(settingsUrl(route, base), base);
      expect(settingsRoute(next)).toEqual(route);
      expect(settingsExitUrl(next)).toBe("/?product=workspace#position");
    }
  });
  it("opens models and legacy links under the same configuration", () => {
    expect(settingsRoute(new URL("https://example.test/settings/admin/models"))).toEqual({ section: "ai" });
    expect(settingsRoute(new URL("https://example.test/settings/agent/connections"))).toEqual({ section: "connections" });
    expect(settingsUrl({ section: "connections" }, new URL("https://example.test/"))).toBe("/settings/agent/connections");
    expect(settingsUrl({ section: "ai" }, new URL("https://example.test/"))).toBe("/settings/admin/models");
  });
});
