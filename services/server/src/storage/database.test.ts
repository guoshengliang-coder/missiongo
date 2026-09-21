import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MissionGoDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("database migrations", () => {
  it("widens legacy Agent reply commands so queued replies can be cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-command-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");

    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes
        (id, account_id, name, token_hash, created_at, updated_at)
      VALUES
        ('node-1', 'account-1', 'Mac mini', 'token-hash', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
      INSERT INTO dispatches
        (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES
        ('dispatch-1', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo', '2026-09-20T00:00:00.000Z');
      INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES
        ('session-1', 'dispatch-1', 'node-1', 'codex', 'thread-1', 'unavailable', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
      INSERT INTO agent_session_commands
        (id, session_id, account_id, text, status, created_at)
      VALUES
        ('command-1', 'session-1', 'account-1', 'Keep this reply', 'queued', '2026-09-20T00:00:00.000Z');
    `);
    seeded.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX idx_agent_session_one_queued_command;
      ALTER TABLE agent_session_commands RENAME TO agent_session_commands_current;
      CREATE TABLE agent_session_commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX idx_agent_session_one_queued_command
        ON agent_session_commands(session_id) WHERE status = 'queued';
      INSERT INTO agent_session_commands
        (id, session_id, account_id, text, status, error, created_at, delivered_at)
      SELECT id, session_id, account_id, text, status, error, created_at, delivered_at
      FROM agent_session_commands_current;
      DROP TABLE agent_session_commands_current;
      DELETE FROM schema_migrations WHERE version = 202609202336;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    const columns = migrated.connection
      .prepare("PRAGMA table_info(agent_session_commands)")
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("cancelled_at");
    const table = migrated.connection
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_commands'")
      .get() as unknown as { sql: string };
    expect(table.sql).toContain("'delivering'");
    expect(table.sql).toContain("'cancelled'");
    const command = migrated.connection
      .prepare("SELECT text, status, cancelled_at FROM agent_session_commands WHERE id = 'command-1'")
      .get() as unknown as { text: string; status: string; cancelled_at: string | null };
    expect(command).toEqual({ text: "Keep this reply", status: "queued", cancelled_at: null });
    const migration = migrated.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609202336")
      .get() as unknown as { version: number };
    expect(migration.version).toBe(202609202336);
    migrated.close();
  });
});
