import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./database.js";

it("adds decision records and append-only event storage and survives reopen", () => {
  const db = new MissionGoDatabase(":memory:");
  try {
    expect(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('decision_records','decision_events')").all()).toHaveLength(2);
    expect(db.connection.prepare("SELECT version FROM schema_migrations WHERE version=202609270131").get()).toBeDefined();
  } finally { db.close(); }
});

it("checks its receipt after taking the write lock and rolls back DDL with a failed receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-migration-"));
  const path = join(dir, "test.sqlite");
  const db = new MissionGoDatabase(path);
  try {
    db.connection.exec("DROP TABLE decision_events; DROP TABLE decision_records; DELETE FROM schema_migrations WHERE version=202609270131;");
  } finally { db.close(); }
  const inspect = new DatabaseSync(path);
  const connections = new Set<MissionGoDatabase>();
  const transaction = MissionGoDatabase.prototype.transaction;
  const spy = vi.spyOn(MissionGoDatabase.prototype, "transaction").mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
    connections.add(this);
    return transaction.call(this, body) as T;
  });
  try {
    inspect.exec("CREATE TRIGGER fail_decision_receipt BEFORE INSERT ON schema_migrations WHEN NEW.version=202609270131 BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
    expect(() => new MissionGoDatabase(path)).toThrow("receipt failed");
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'decision_%'").all()).toEqual([]);
    inspect.exec("DROP TRIGGER fail_decision_receipt;");
    let interleaved = false;
    spy.mockImplementation(function<T>(this: MissionGoDatabase, body: () => T): T {
      connections.add(this);
      // Target this migration's lock boundary, not an earlier migration's transaction.
      if (!interleaved && body.toString().includes("202609270131")) {
        interleaved = true; connections.add(new MissionGoDatabase(path));
      }
      return transaction.call(this, body) as T;
    });
    const recovered = new MissionGoDatabase(path);
    connections.add(recovered);
    expect(interleaved).toBe(true);
    expect(recovered.connection.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=202609270131").get()).toEqual({ n: 1 });
    expect(recovered.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    spy.mockRestore();
    for (const c of connections) c.close();
    inspect.close();
    await rm(dir, { recursive: true, force: true });
  }
});
