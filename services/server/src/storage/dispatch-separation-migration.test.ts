import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./database.js";
import { restoreNodeOwnership } from "../test-fixtures/before-dispatch-separation.js";

const version = 202609271508;
const names = ["message", "settings", "restore", "insert", "start"];
it("AND-235 fresh and upgraded databases drop node exclusion, retain execution fencing and are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-migration-"));
  const path = join(dir, "test.sqlite");
  let db = new MissionGoDatabase(path);
  try {
    expect(db.connection.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)).toBeDefined();
    restoreNodeOwnership(db.connection);
    db.close(); db = new MissionGoDatabase(path);
    expect(db.connection.prepare("SELECT name FROM sqlite_master WHERE name='managed_execution_node_owner'").get()).toBeUndefined();
    expect(db.connection.prepare("SELECT name FROM sqlite_master WHERE name='managed_execution_run_owner'").get()).toBeDefined();
    for (const name of names) expect(db.connection.prepare("SELECT name FROM sqlite_master WHERE name=?").get("managed_manual_" + name)).toBeUndefined();
    const schema = db.connection.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    db.close(); db = new MissionGoDatabase(path);
    expect(db.connection.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(db.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
it("AND-235 rolls back all exclusion changes when its migration receipt fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-rollback-"));
  const path = join(dir, "test.sqlite");
  const db = new MissionGoDatabase(path);
  restoreNodeOwnership(db.connection);
  db.close();
  const inspect = new DatabaseSync(path);
  const connections = new Set<MissionGoDatabase>();
  const transaction = MissionGoDatabase.prototype.transaction;
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
    connections.add(this);
    return transaction.call(this, body) as T;
  });
  try {
    const schema = inspect.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    inspect.exec(`CREATE TRIGGER fail_separation BEFORE INSERT ON schema_migrations WHEN NEW.version=${version} BEGIN SELECT RAISE(ABORT,'receipt failed'); END;`);
    expect(() => new MissionGoDatabase(path)).toThrow("receipt failed");
    inspect.exec("DROP TRIGGER fail_separation;");
    expect(inspect.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    let interleaved = false;
    spy.mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
      connections.add(this);
      // Another connection completes this migration before we obtain its lock.
      if (!interleaved && body.toString().includes("202609271508")) {
        interleaved = true; connections.add(new MissionGoDatabase(path));
      }
      return transaction.call(this, body) as T;
    });
    const recovered = new MissionGoDatabase(path); connections.add(recovered);
    expect(interleaved).toBe(true);
    expect(recovered.connection.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=?").get(version)).toEqual({ n: 1 });
  } finally {
    spy.mockRestore(); for (const connection of connections) connection.close(); inspect.close();
    await rm(dir, { recursive: true, force: true });
  }
});
