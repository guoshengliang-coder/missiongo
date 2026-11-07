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

  it("publishes the release candidate read tool, commenting, the three status changes, and derived items", () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(53);
    expect(MCP_TOOL_DEFINITIONS.filter((tool) => tool.access === "write").map((tool) => tool.name))
      .toEqual(["request_collaboration_approval", "request_merge_reconciliation_approval", "request_managed_decision_approval", "request_merge_reconciliation", "apply_merge_reconciliation", "record_merge_combined_validation", "propose_merge_delivery", "refresh_merge_delivery", "report_merge_batch", "finish_merge_batch", "record_merge_integration", "prepare_collaboration_request", "append_collaboration_discussion", "append_comment", "prepare_plan_document", "request_plan_approval", "claim_item", "recover_execution_authorization", "submit_development_complete", "submit_for_verification", "submit_release_batch", "supplement_release_evidence", "create_item", "upload_attachment_chunk", "prepare_attachment_upload", "add_item_attachment", "register_agent_session", "report_agent_session"]);
    expect(findMcpTool("get_item_context")?.access).toBe("read");
    // Deciding an item is finished, paused or abandoned is the user's, so no
    // tool for it exists at any tier.
    for (const gone of ["submit_resolution", "mark_pending_verification", "release_item", "resume_execution"]) {
      expect(findMcpTool(gone)).toBeUndefined();
    }
  });
});
