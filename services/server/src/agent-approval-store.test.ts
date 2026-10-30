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

it("surfaces a source Simulator approval despite queued chat and invalidates decisions resolved elsewhere", () => {
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
    const prompt = { id: "simulator-1", kind: "manual" as const, status: "pending", turnId: "turn",
      action: 'cua_repl: Allow Computer Use to use "Simulator"?', startedAtMs: 1 };
    const session = { id: "session", agentKind: "codex" as const, needsAttention: false, waitingForReply: false,
      attention: { state: "not_needed" as const } };
    expect(() => approvals.record("other-node", "session", prompt)).toThrow();
    approvals.record("node", "session", prompt);
    expect(approvals.withAttention(session)).toMatchObject({ approval: prompt, needsAttention: true,
      attention: { state: "needed", kind: "approval" }, waitingForReply: true });
    expect(approvals.withAttention({ ...session, archivedAt: "now" }).needsAttention).toBe(false);
    approvals.decide("session", prompt.id, "accept");
    expect(approvals.withAttention(session).needsAttention).toBe(false);
    expect(approvals.pendingForNode("session").approvalDecision).toEqual({ id: prompt.id, choice: "accept" });
    approvals.record("node", "session", { ...prompt, status: "resolved" });
    expect(approvals.pendingForNode("session").approvalDecision).toBeUndefined();
    expect(() => approvals.decide("session", prompt.id, "accept")).toThrow();
    approvals.record("node", "session", prompt);
    expect(approvals.get("session")?.status).toBe("resolved");

    // A reconnected monitor reports a new id and cannot inherit an old grant.
    approvals.record("node", "session", { ...prompt, id: "simulator-2" });
    expect(approvals.pendingForNode("session").approvalDecision).toBeUndefined();
    expect(() => approvals.decide("session", prompt.id, "accept")).toThrow();
    approvals.record("node", "session", { ...prompt, id: "simulator-2", status: "unavailable" });
    expect(approvals.withAttention(session).needsAttention).toBe(true);
    expect(() => approvals.decide("session", "simulator-2", "accept")).toThrow();
  } finally { database.close(); }
});

it("persists only advertised scopes and discards decisions after a transport loss", () => {
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
    const prompt = { id: "prompt", kind: "manual" as const, status: "pending", turnId: "turn",
      action: "git status", startedAtMs: 1, options: [
        { id: "accept", kind: "once" as const }, { id: "acceptForSession", kind: "session" as const },
        { id: "execpolicy-2", kind: "rule" as const, detail: '"git" "status"' },
        { id: "acceptAlways", kind: "always" as const },
        { id: "choice-0", kind: "choice" as const, label: "Allow for this session", detail: "Current app only" },
      ] };
    approvals.record("node", "session", prompt);
    expect(approvals.get("session")?.options).toEqual(prompt.options);
    expect(() => approvals.decide("session", "prompt", "network-2")).toThrow();
    approvals.decide("session", "prompt", "acceptForSession");
    expect(approvals.pendingForNode("session").approvalDecision?.choice).toBe("acceptForSession");
    expect(() => approvals.decide("session", "prompt", "accept")).toThrow();
    approvals.record("node", "session", { ...prompt, status: "reconnecting" });
    expect(approvals.pendingForNode("session").approvalDecision).toBeUndefined();
    expect(approvals.withAttention({ id: "session", agentKind: "codex" }).needsAttention).toBe(true);
    expect(() => approvals.decide("session", "prompt", "acceptForSession")).toThrow();
    approvals.record("node", "session", prompt); // stale snapshot cannot revive an old transport
    expect(approvals.get("session")?.status).toBe("reconnecting");
    approvals.record("node", "session", { ...prompt, id: "fresh" });
    expect(approvals.get("session")?.decision).toBeUndefined();
    expect(() => approvals.decide("session", "prompt", "accept")).toThrow();
    approvals.decide("session", "fresh", "execpolicy-2");
    expect(approvals.pendingForNode("session").approvalDecision?.choice).toBe("execpolicy-2");
    approvals.record("node", "session", { ...prompt, id: "persistent" });
    approvals.decide("session", "persistent", "acceptAlways");
    expect(approvals.pendingForNode("session").approvalDecision?.choice).toBe("acceptAlways");
    approvals.record("node", "session", { ...prompt, id: "native-label" });
    expect(approvals.get("session")?.options?.find(option => option.id === "choice-0")?.label).toBe("Allow for this session");
    approvals.decide("session", "native-label", "choice-0");
    expect(approvals.pendingForNode("session").approvalDecision?.choice).toBe("choice-0");
    expect(() => approvals.record("node", "session", { ...prompt, id: "missing-label",
      options: [{ id: "choice-1", kind: "choice" }] })).toThrow("Invalid Codex approval options");
    approvals.record("node", "session", { ...prompt, id: "fresh", status: "approved" });
    approvals.record("node", "session", { ...prompt, id: "fresh", status: "reconnecting" });
    expect(approvals.get("session")?.status).toBe("approved");
  } finally { database.close(); }
});
