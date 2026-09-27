import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";

import { MissionGoDatabase } from "./database.js";
import { INITIAL_SCHEMA } from "./schema.js";

async function beforeLedgerMigration() {
  const dir = await mkdtemp(join(tmpdir(), "managed-migration-"));
  const path = join(dir, "test.sqlite");
  const db = new MissionGoDatabase(path);
  db.connection.exec(`
    DROP TABLE managed_run_events;
    DROP TABLE managed_attempts;
    DROP TABLE managed_stages;
    DROP TABLE managed_runs;
    DELETE FROM schema_migrations WHERE version = 202609262149;
  `);
  db.close();
  return { dir, path };
}

it("handles another connection completing the migration before this connection takes the write lock", async () => {
  const { dir, path } = await beforeLedgerMigration();
  const transaction = MissionGoDatabase.prototype.transaction;
  const connections = new Set<MissionGoDatabase>();
  let interleaved = false;
  // Scheduling seam only: both constructors, migrations and SQLite writes are real.
  // Pause the first constructor just before acquiring its transaction write lock.
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(
    this: MissionGoDatabase, body: () => T,
  ): T {
    connections.add(this);
    if (!interleaved) {
      interleaved = true;
      connections.add(new MissionGoDatabase(path));
    }
    return transaction.call(this, body) as T;
  });
  try {
    const db = new MissionGoDatabase(path);
    connections.add(db);
    expect(interleaved).toBe(true);
    expect(connections.size).toBe(2);
    expect(db.connection.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=202609262149").get()).toEqual({ n: 1 });
    expect(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%'").all()).toHaveLength(4);
    expect(db.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    spy.mockRestore();
    for (const db of connections) db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rolls back all ledger tables when the migration receipt fails and can then retry", async () => {
  const { dir, path } = await beforeLedgerMigration();
  const inspect = new DatabaseSync(path);
  inspect.exec(`CREATE TRIGGER fail_test_migration BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 202609262149 BEGIN SELECT RAISE(ABORT, 'test migration failure'); END;`);
  const transaction = MissionGoDatabase.prototype.transaction;
  const connections = new Set<MissionGoDatabase>();
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(
    this: MissionGoDatabase, body: () => T,
  ): T {
    connections.add(this);
    return transaction.call(this, body) as T;
  });
  try {
    expect(() => new MissionGoDatabase(path)).toThrow("test migration failure");
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_%'").all()).toEqual([]);
    expect(inspect.prepare("SELECT version FROM schema_migrations WHERE version=202609262149").get()).toBeUndefined();
    inspect.exec("DROP TRIGGER fail_test_migration;");
    const recovered = new MissionGoDatabase(path);
    connections.add(recovered);
    expect(recovered.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%'").all()).toHaveLength(4);
    expect(recovered.connection.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=202609262149").get()).toEqual({ n: 1 });
  } finally {
    spy.mockRestore();
    for (const db of connections) db.close();
    inspect.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("upgrades an existing database with a durable ledger without changing business records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-migration-"));
  const path = join(dir, "test.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(INITIAL_SCHEMA);
  legacy.exec(`
    INSERT INTO products (id,key_prefix,name,created_at,updated_at) VALUES ('p','AND','Test','now','now');
    INSERT INTO work_items (id,item_key,sequence,product_id,type,priority,status,title,description,created_at,updated_at)
      VALUES ('i','AND-1',1,'p','task','normal','in_progress','Task','Unchanged','now','now');
  `);
  legacy.close();
  let db: MissionGoDatabase | undefined;
  try {
    db = new MissionGoDatabase(path);
    const names = db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["managed_runs", "managed_stages", "managed_attempts", "managed_run_events"]));
    expect(db.connection.prepare("SELECT status,description FROM work_items WHERE id='i'").get())
      .toEqual({ status: "in_progress", description: "Unchanged" });
    const migrations = db.connection.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.close();
    db = new MissionGoDatabase(path);
    expect(db.connection.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(migrations);
    expect(db.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
