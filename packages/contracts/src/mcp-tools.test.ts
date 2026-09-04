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
    expect(names).not.toContain("update_task");
    expect(names).not.toContain("delete_task");
    expect(names).not.toContain("complete_task");
  });

  it("marks claims and resolution submission as writes", () => {
    expect(findMcpTool("claim_task")?.access).toBe("write");
    expect(findMcpTool("submit_resolution")?.access).toBe("write");
  });
});
