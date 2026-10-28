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
