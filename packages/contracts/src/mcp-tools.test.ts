import { describe, expect, it } from "vitest";

import { findMcpTool, MCP_TOOL_DEFINITIONS } from "./mcp-tools.js";

describe("MCP tool catalog", () => {
  it("contains unique tool names", () => {
    const names = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not expose arbitrary SQL or generic update tools", () => {
    const names = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names.some((name) => name.includes("sql"))).toBe(false);
    expect(names).not.toContain("update_item");
    expect(names).not.toContain("delete_item");
    expect(names).not.toContain("complete_item");
  });

  it("publishes only the seven stage-one read tools", () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(7);
    expect(MCP_TOOL_DEFINITIONS.every((tool) => tool.access === "read")).toBe(true);
    expect(findMcpTool("get_item_context")?.access).toBe("read");
    expect(findMcpTool("claim_item")).toBeUndefined();
  });
});
