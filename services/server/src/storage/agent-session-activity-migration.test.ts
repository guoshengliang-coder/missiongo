import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./database.js";

const version = 202609300121;
const timestamp = "2026-09-30T00:52:00.000Z";

async function legacyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-activity-migration-"));
  const path = join(directory, "test.sqlite");
  const initial = new MissionGoDatabase(path);
  const db = initial.connection;
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('node','owner','fixture-node','Fixture','synthetic','[]',?,?)`).run(timestamp, timestamp);
  const fixtures = [
    ["affected", "unavailable", "Codex 集成已停用；不会读取或回复现有会话。"],
    ["missing-adapter", "unavailable", "本机已停用 claude_code 集成，会话暂不同步；重新启用后会自动恢复。"],
    ["different-error", "unavailable", "Transport failed"],
    ["healthy", "idle", null],
    ["failed-task", "failed", "Codex 集成已停用；不会读取或回复现有会话。"],
  ];
  for (const [id, status, error] of fixtures) {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES (?,'owner','node','codex','plan','launched','/synthetic/repo',?)`).run(id!, timestamp);
    db.prepare(`INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,last_error,created_at,updated_at,activity_at)
      VALUES (?,?,'node','codex',?,?,?,?,?,?)`).run(id!, id!, id!, status!, error ?? null, timestamp, timestamp, timestamp);
  }
  db.exec(`ALTER TABLE agent_sessions DROP COLUMN activity_repair_pending;
    DELETE FROM schema_migrations WHERE version=${version};`);
  initial.close();
  return { directory, path };
}

it("flags only known integration errors without guessing historical times, and survives concurrent upgrade/reopen", async () => {
  const { directory, path } = await legacyDatabase();
  const connections = new Set<MissionGoDatabase>();
  const transaction = MissionGoDatabase.prototype.transaction;
  let interleaved = false;
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
    connections.add(this);
    if (!interleaved && body.toString().includes(String(version))) {
      interleaved = true;
      connections.add(new MissionGoDatabase(path));
    }
    return transaction.call(this, body) as T;
  });
  try {
    const upgraded = new MissionGoDatabase(path);
    connections.add(upgraded);
    expect(interleaved).toBe(true);
    const expected = [
      { id: "affected", activity_repair_pending: 1, activity_at: timestamp },
      { id: "different-error", activity_repair_pending: 0, activity_at: timestamp },
      { id: "failed-task", activity_repair_pending: 0, activity_at: timestamp },
      { id: "healthy", activity_repair_pending: 0, activity_at: timestamp },
      { id: "missing-adapter", activity_repair_pending: 1, activity_at: timestamp },
    ];
    expect(upgraded.connection.prepare("SELECT id, activity_repair_pending, activity_at FROM agent_sessions ORDER BY id").all()).toEqual(expected);
    const reopened = new MissionGoDatabase(path);
    connections.add(reopened);
    expect(reopened.connection.prepare("SELECT id, activity_repair_pending, activity_at FROM agent_sessions ORDER BY id").all()).toEqual(expected);
    expect(reopened.connection.prepare("SELECT version FROM schema_migrations WHERE version=?").all(version)).toHaveLength(1);
    expect(reopened.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    spy.mockRestore();
    for (const database of connections) database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rolls back the repair marker and receipt together when migration fails", async () => {
  const { directory, path } = await legacyDatabase();
  const inspect = new DatabaseSync(path);
  inspect.exec(`CREATE TRIGGER fail_activity_receipt BEFORE INSERT ON schema_migrations WHEN NEW.version=${version}
    BEGIN SELECT RAISE(ABORT,'activity receipt failed'); END;`);
  const connections = new Set<MissionGoDatabase>();
  const transaction = MissionGoDatabase.prototype.transaction;
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
    connections.add(this);
    return transaction.call(this, body) as T;
  });
  try {
    expect(() => new MissionGoDatabase(path)).toThrow("activity receipt failed");
    expect(inspect.prepare("PRAGMA table_info(agent_sessions)").all().map((column) => column.name)).not.toContain("activity_repair_pending");
    expect(inspect.prepare("SELECT DISTINCT activity_at FROM agent_sessions").all()).toEqual([{ activity_at: timestamp }]);
    inspect.exec("DROP TRIGGER fail_activity_receipt;");
    const recovered = new MissionGoDatabase(path);
    connections.add(recovered);
    expect(recovered.connection.prepare("SELECT activity_repair_pending FROM agent_sessions WHERE id='affected'").get())
      .toEqual({ activity_repair_pending: 1 });
  } finally {
    spy.mockRestore();
    for (const database of connections) database.close();
    inspect.close();
    await rm(directory, { recursive: true, force: true });
  }
});
