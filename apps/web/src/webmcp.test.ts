import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "./types";
import { registerMissionGoWebMcp, type ModelContextLike, type WebMcpTool } from "./webmcp";

const item: WorkItem = {
  id: "item-1",
  key: "HG-1",
  productId: "product-1",
  affectedComponentIds: [],
  type: "idea",
  priority: "normal",
  status: "inbox",
  title: "Capture faster",
  description: "",
  diagnosticSummary: { logCount: 0, contextEntryCount: 0 },
  attachments: [],
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

function setup() {
  const tools = new Map<string, WebMcpTool>();
  const context: ModelContextLike = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  const createItem = vi.fn(async () => item);
  const openItem = vi.fn(() => item);
  const cleanup = registerMissionGoWebMcp(context, {
    product: { id: "product-1", name: "Hermes Go" },
    visibleItems: [item],
    activeFilters: { status: "all", type: "all", search: "" },
    createItem,
    openItem,
  });
  return { tools, createItem, openItem, cleanup };
}

describe("MissionGo WebMCP", () => {
  it("registers a focused read, navigation, and create surface", () => {
    const { tools, cleanup } = setup();
    expect([...tools.keys()]).toEqual(["list_visible_work_items", "open_work_item", "create_work_item"]);
    expect(tools.get("list_visible_work_items")?.annotations.readOnlyHint).toBe(true);
    expect(tools.get("create_work_item")?.annotations.readOnlyHint).toBe(false);
    cleanup?.();
  });

  it("reads the visible state and opens an item", async () => {
    const { tools, openItem } = setup();
    expect(await tools.get("list_visible_work_items")!.execute({})).toMatchObject({
      product: { name: "Hermes Go" },
      items: [{ key: "HG-1" }],
    });
    expect(await tools.get("open_work_item")!.execute({ itemKey: "hg-1" })).toMatchObject({
      opened: "HG-1",
      item: { key: "HG-1", attachments: [] },
    });
    expect(openItem).toHaveBeenCalledWith("HG-1");
  });

  it("creates a work item and rejects invalid input", async () => {
    const { tools, createItem } = setup();
    await expect(
      tools.get("create_work_item")!.execute({ title: "New idea", type: "idea", priority: "normal", platform: "android" }),
    ).resolves.toMatchObject({ created: "HG-1" });
    expect(createItem).toHaveBeenCalledWith({ title: "New idea", description: "", type: "idea", priority: "normal", platform: "android" });
    await expect(
      tools.get("create_work_item")!.execute({ title: "Bad", type: "unknown", priority: "normal" }),
    ).rejects.toThrow(/type must be one of/);
  });
});
