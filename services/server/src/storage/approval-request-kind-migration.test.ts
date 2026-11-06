import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentApprovalStore } from "../agent-approval-store.js";
import { MissionGoDatabase } from "./database.js";

it("adds request_kind without changing legacy rows, which read as neutral (AND-408)", () => {
  const directory = mkdtempSync(join(tmpdir(), "missiongo-approval-request-kind-"));
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
      CREATE TABLE agent_session_approvals_pre_kind (
        session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('manual','auto')),
        status TEXT NOT NULL, turn_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT,
        started_at_ms INTEGER NOT NULL, decision TEXT,
        options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
        retry_id TEXT, retry_review_id TEXT, retry_status TEXT, retry_error TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO agent_session_approvals_pre_kind VALUES
        ('session','legacy','manual','pending','turn','git status',NULL,1,NULL,
         '[{"id":"accept","kind":"once"}]',NULL,NULL,NULL,NULL,'now');
      DROP TABLE agent_session_approvals;
      ALTER TABLE agent_session_approvals_pre_kind RENAME TO agent_session_approvals;
      DELETE FROM schema_migrations WHERE version = 202611060654;
    `);
    database.close();
    database = new MissionGoDatabase(path);
    const store = new AgentApprovalStore(database);
    expect(store.get("session")).toMatchObject({ id: "legacy" });
    expect(store.get("session")?.requestKind).toBeUndefined();
    expect(store.withAttention({ id: "session", agentKind: "codex" })).toMatchObject({
      attention: { kind: "approval", reason: "Codex 正在等待处理。" } });
    store.record("node", "session", { id: "question", kind: "manual", status: "pending", turnId: "turn",
      action: "选择产品偏好", startedAtMs: 2, requestKind: "question",
      options: [{ id: "choice-0", kind: "choice", label: "方案 A" }] });
    database.close();
    database = new MissionGoDatabase(path);
    expect(new AgentApprovalStore(database).get("session")).toMatchObject({ id: "question", requestKind: "question" });
    expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
