import { describe, expect, it } from "vitest";

import { deviceStartsOpen, hasRepoDrafts, repoCoverage } from "./node-summary";

const product = (id: string, archivedAt?: string) => ({ id, ...(archivedAt ? { archivedAt } : {}) });
const mapping = (productId: string, repoPath = `/repos/${productId}`) => ({ productId, productKey: productId.toUpperCase(), repoPath });

describe("how many products a device can take work for", () => {
  it("counts saved mappings against the live products", () => {
    const node = { repos: [mapping("a"), mapping("b")] };
    expect(repoCoverage(node, [product("a"), product("b"), product("c")])).toEqual({ configured: 2, total: 3 });
  });

  it("leaves archived products out of both sides", () => {
    const node = { repos: [mapping("a"), mapping("old")] };
    expect(repoCoverage(node, [product("a"), product("old", "2026-09-01T00:00:00Z")])).toEqual({ configured: 1, total: 1 });
  });

  it("ignores a mapping for a product this account cannot see", () => {
    const node = { repos: [mapping("a"), mapping("someone-elses")] };
    expect(repoCoverage(node, [product("a"), product("b")])).toEqual({ configured: 1, total: 2 });
  });

  it("does not count a blank path as a checkout", () => {
    expect(repoCoverage({ repos: [mapping("a", "  ")] }, [product("a")])).toEqual({ configured: 0, total: 1 });
  });

  it("is zero of zero with no products", () => {
    expect(repoCoverage({ repos: [] }, [])).toEqual({ configured: 0, total: 0 });
  });
});

describe("whether a card holds unsaved repository paths", () => {
  it("is false with no drafts", () => {
    expect(hasRepoDrafts({}, { a: "/repos/a" })).toBe(false);
  });

  it("is false when a draft matches what is saved, give or take spaces", () => {
    expect(hasRepoDrafts({ a: " /repos/a " }, { a: "/repos/a" })).toBe(false);
    expect(hasRepoDrafts({ b: "" }, {})).toBe(false);
  });

  it("is true for a changed, new or cleared path", () => {
    expect(hasRepoDrafts({ a: "/elsewhere" }, { a: "/repos/a" })).toBe(true);
    expect(hasRepoDrafts({ b: "/repos/b" }, {})).toBe(true);
    expect(hasRepoDrafts({ a: "" }, { a: "/repos/a" })).toBe(true);
  });
});

describe("which cards start open", () => {
  it("opens the only device and none of several", () => {
    expect(deviceStartsOpen(1)).toBe(true);
    expect(deviceStartsOpen(2)).toBe(false);
    expect(deviceStartsOpen(0)).toBe(false);
  });
});
