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

  it("publishes the seven read tools and commenting, and nothing from the processing tier", () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(8);
    expect(MCP_TOOL_DEFINITIONS.filter((tool) => tool.access === "write").map((tool) => tool.name))
      .toEqual(["append_comment"]);
    expect(findMcpTool("get_item_context")?.access).toBe("read");
    // Claiming, leases and status transitions are a separate decision and are
    // not published yet.
    expect(findMcpTool("claim_item")).toBeUndefined();
    expect(findMcpTool("submit_resolution")).toBeUndefined();
  });
});
