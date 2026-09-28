import { expect, it } from "vitest";

import { AgentApprovalStore } from "./agent-approval-store.js";
import { MissionGoDatabase } from "./storage/database.js";

it("keeps a human retry attached to its denied review while a new approval arrives", () => {
  const database = new MissionGoDatabase(":memory:");
  try {
    database.connection.exec(`
      INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at)
      VALUES ('node', 'owner', 'Fixture', 'hash', 'now', 'now');
      INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('dispatch', 'owner', 'node', 'codex', 'auto', 'launched', '/synthetic/repo', 'now');
      INSERT INTO agent_sessions (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES ('session', 'dispatch', 'node', 'codex', 'thread', 'active', 'now', 'now');
    `);
    const approvals = new AgentApprovalStore(database);
    approvals.record("node", "session", { id: "review-1", kind: "auto", status: "denied",
      turnId: "turn-1", action: "command", startedAtMs: 1 });
    const retry = approvals.requestRetry("session", "review-1");
    expect(retry.retryStatus).toBe("queued");
    expect(approvals.requestRetry("session", "review-1").retryId).toBe(retry.retryId);
    expect(approvals.pendingForNode("session").approvalRetry).toEqual({ id: retry.retryId,
      reviewId: "review-1", status: "queued" });

    approvals.recordRetry("node", "session", retry.retryId!, "delivering");
    approvals.record("node", "session", { id: "human-1", kind: "manual", status: "pending",
      turnId: "turn-2", action: "same command", startedAtMs: 2 });
    expect(approvals.pendingForNode("session").approvalRetry).toEqual({ id: retry.retryId,
      reviewId: "review-1", status: "delivering" });
    expect(approvals.get("session")?.retryId).toBeUndefined();
    approvals.recordRetry("node", "session", retry.retryId!, "delivered");
    approvals.recordRetry("node", "session", retry.retryId!, "delivering");
    expect(approvals.pendingForNode("session").approvalRetry?.status).toBe("delivered");
    approvals.decide("session", "human-1", "accept");
    expect(approvals.pendingForNode("session").approvalDecision).toEqual({ id: "human-1", choice: "accept" });
    approvals.record("node", "session", { id: "human-1", kind: "manual", status: "approved",
      turnId: "turn-2", action: "same command", startedAtMs: 2 });
    approvals.recordRetry("node", "session", retry.retryId!, "restored");
    expect(approvals.pendingForNode("session").approvalRetry).toBeUndefined();

    approvals.record("node", "session", { id: "review-2", kind: "auto", status: "denied",
      turnId: "turn-3", action: "second command", startedAtMs: 3 });
    expect(approvals.requestRetry("session", "review-2").retryId).not.toBe(retry.retryId);
  } finally {
    database.close();
  }
});
