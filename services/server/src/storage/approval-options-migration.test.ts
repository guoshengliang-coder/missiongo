import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentApprovalStore } from "../agent-approval-store.js";
import { MissionGoDatabase } from "./database.js";

it("upgrades an existing yes/no approval without losing its queued decision or retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "missiongo-approval-migration-"));
  const path = join(directory, "fixture.sqlite");
  let database = new MissionGoDatabase(path);
  try {
    database.connection.exec(`
      INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at)
      VALUES ('node', 'owner', 'Fixture', 'hash', 'now', 'now');
      INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('dispatch', 'owner', 'node', 'codex', 'auto', 'launched', '/synthetic/repo', 'now');
      INSERT INTO agent_sessions (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES ('session', 'dispatch', 'node', 'codex', 'thread', 'active', 'now', 'now');
      DROP TABLE agent_session_approvals;
      CREATE TABLE agent_session_approvals (
        session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('manual','auto')),
        status TEXT NOT NULL, turn_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT,
        started_at_ms INTEGER NOT NULL, decision TEXT CHECK (decision IN ('accept','decline')),
        retry_id TEXT, retry_review_id TEXT, retry_status TEXT, retry_error TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO agent_session_approvals VALUES
        ('session','old','manual','pending','turn','git status',NULL,1,'accept','retry','review','delivered',NULL,'now');
      DELETE FROM schema_migrations WHERE version = 202610282337;
    `);
    database.close();
    database = new MissionGoDatabase(path);
    const store = new AgentApprovalStore(database);
    expect(store.pendingForNode("session")).toEqual({
      approvalDecision: { id: "old", choice: "accept" },
      approvalRetry: { id: "retry", reviewId: "review", status: "delivered" },
    });
    expect(() => store.decide("session", "old", "acceptForSession")).toThrow();
    store.record("node", "session", { id: "new", kind: "manual", status: "pending", turnId: "turn",
      action: "git status", startedAtMs: 2, options: [{ id: "acceptForSession", kind: "session" }] });
    store.decide("session", "new", "acceptForSession");
    database.close();
    database = new MissionGoDatabase(path);
    expect(new AgentApprovalStore(database).get("session")).toMatchObject({ id: "new",
      decision: "acceptForSession", options: [{ id: "acceptForSession", kind: "session" }] });
    database.connection.exec("DELETE FROM agent_sessions WHERE id = 'session'");
    expect(new AgentApprovalStore(database).get("session")).toBeUndefined();
    expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
