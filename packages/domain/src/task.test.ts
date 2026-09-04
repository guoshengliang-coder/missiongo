import { describe, expect, it } from "vitest";

import { createTaskKey } from "./task.js";

describe("createTaskKey", () => {
  it("creates a stable product-scoped task key", () => {
    expect(createTaskKey("HG", 128)).toBe("HG-128");
  });

  it("rejects unsafe or ambiguous product prefixes", () => {
    expect(() => createTaskKey("hermes", 1)).toThrow(/Product prefix/);
    expect(() => createTaskKey("H", 1)).toThrow(/Product prefix/);
  });

  it("rejects non-positive sequences", () => {
    expect(() => createTaskKey("HG", 0)).toThrow(/positive safe integer/);
  });
});
