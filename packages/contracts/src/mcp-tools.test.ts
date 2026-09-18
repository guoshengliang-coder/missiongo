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

  it("publishes the release candidate read tool, commenting, the two status changes, and derived items", () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(12);
    expect(MCP_TOOL_DEFINITIONS.filter((tool) => tool.access === "write").map((tool) => tool.name))
      .toEqual(["append_comment", "claim_item", "submit_for_verification", "create_item"]);
    expect(findMcpTool("get_item_context")?.access).toBe("read");
    // Deciding an item is finished, paused or abandoned is the user's, so no
    // tool for it exists at any tier.
    for (const gone of ["submit_resolution", "mark_pending_verification", "release_item", "resume_execution"]) {
      expect(findMcpTool(gone)).toBeUndefined();
    }
  });
});
