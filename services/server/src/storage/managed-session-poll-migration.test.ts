import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./database.js";

const version = 202609271554;
it("AND-235 poll cursor migration upgrades atomically, rechecks under lock and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-poll-migration-"));
  const path = join(dir, "test.sqlite");
  const initial = new MissionGoDatabase(path);
  initial.connection.exec(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('n','owner','fixture-node','Fixture','synthetic','[]','now','now');`);
  expect(initial.connection.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)).toBeDefined();
  initial.connection.exec(`DROP TABLE managed_session_poll_cursors; DROP INDEX idx_agent_sessions_node_id;
    DELETE FROM schema_migrations WHERE version=${version};`);
  initial.close();
  const inspect = new DatabaseSync(path);
  const connections = new Set<MissionGoDatabase>();
  const transaction = MissionGoDatabase.prototype.transaction;
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
    connections.add(this);
    return transaction.call(this, body) as T;
  });
  try {
    const nodes = inspect.prepare("SELECT * FROM nodes").all();
    inspect.exec(`CREATE TRIGGER fail_poll_receipt BEFORE INSERT ON schema_migrations WHEN NEW.version=${version}
      BEGIN SELECT RAISE(ABORT,'poll receipt failed'); END;`);
    expect(() => new MissionGoDatabase(path)).toThrow("poll receipt failed");
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name IN ('managed_session_poll_cursors','idx_agent_sessions_node_id')").all()).toEqual([]);
    inspect.exec("DROP TRIGGER fail_poll_receipt;");
    let interleaved = false;
    spy.mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
      connections.add(this);
      if (!interleaved && body.toString().includes(String(version))) {
        interleaved = true;
        connections.add(new MissionGoDatabase(path));
      }
      return transaction.call(this, body) as T;
    });
    const upgraded = new MissionGoDatabase(path);
    expect(interleaved).toBe(true);
    upgraded.connection.prepare("INSERT INTO managed_session_poll_cursors VALUES ('n','stable-session-id')").run();
    const reopened = new MissionGoDatabase(path);
    expect(reopened.connection.prepare("SELECT * FROM managed_session_poll_cursors").all())
      .toEqual([{ node_id: "n", after_session_id: "stable-session-id" }]);
    expect(reopened.connection.prepare("SELECT * FROM nodes").all()).toEqual(nodes);
    expect(reopened.connection.prepare("SELECT version FROM schema_migrations WHERE version=?").all(version)).toHaveLength(1);
    expect(reopened.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    spy.mockRestore();
    for (const connection of connections) connection.close();
    inspect.close();
    await rm(dir, { recursive: true, force: true });
  }
});
