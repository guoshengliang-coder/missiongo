import { describe, expect, it } from "vitest";

import { ATTACHMENT_KINDS, createWorkItemKey, WORK_ITEM_TYPES } from "./work-item.js";

describe("createWorkItemKey", () => {
  it("creates a stable product-scoped work item key", () => {
    expect(createWorkItemKey("HG", 128)).toBe("HG-128");
  });

  it("supports every confirmed work item type", () => {
    expect(WORK_ITEM_TYPES).toEqual(["bug", "requirement", "idea", "task", "note"]);
  });

  it("classifies the supported attachment kinds", () => {
    expect(ATTACHMENT_KINDS).toEqual(["image", "video", "log", "document"]);
  });

  it("rejects unsafe or ambiguous product prefixes", () => {
    expect(() => createWorkItemKey("hermes", 1)).toThrow(/Product prefix/);
    expect(() => createWorkItemKey("H", 1)).toThrow(/Product prefix/);
  });

  it("rejects non-positive sequences", () => {
    expect(() => createWorkItemKey("HG", 0)).toThrow(/positive safe integer/);
  });
});
