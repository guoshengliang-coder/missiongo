import { describe, expect, it } from "vitest";

import * as managed from "./index.js";

describe("managed run scope", () => {
  it("accepts a frozen scope without normalizing or accepting empty, duplicate or extra fields", () => {
    expect(managed).toHaveProperty("isManagedRunScope");
    const scope = { productId: "product-a", repositoryRef: "repo-a", itemKeys: ["AND-1"], contractRevision: 1 };
    expect(managed.isManagedRunScope(scope)).toBe(true);
    for (const change of [
      { itemKeys: [] }, { itemKeys: ["AND-1", "AND-1"] }, { itemKeys: ["and-1"] },
      { itemKeys: ["AND-1\n"] }, { repositoryRef: "repo-a\n" },
      { contractRevision: 0 }, { contractRevision: 1.5 }, { repositoryRef: " " }, { allowedActions: ["deploy"] },
    ]) {
      expect(managed.isManagedRunScope({ ...scope, ...change })).toBe(false);
    }
    expect(managed.isManagedRunScope(null)).toBe(false);
  });
});
