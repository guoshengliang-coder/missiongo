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
  it("adds local archive state to historical dispatches without losing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-dispatch-archive-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes
        (id, account_id, name, token_hash, created_at, updated_at)
      VALUES
        ('node-1', 'account-1', 'Mac mini', 'token-hash', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
      INSERT INTO dispatches
        (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at, completed_at)
      VALUES
        ('dispatch-1', 'account-1', 'node-1', 'claude_code', 'plan', 'launched', '/repo',
         '2026-09-21T00:00:00.000Z', '2026-09-21T00:01:00.000Z');
    `);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_dispatches_archived;
      ALTER TABLE dispatches DROP COLUMN archived_at;
      DELETE FROM schema_migrations WHERE version = 202609210926;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    const dispatchColumns = migrated.connection
      .prepare("PRAGMA table_info(dispatches)")
      .all() as unknown as Array<{ name: string }>;
    expect(dispatchColumns.map((column) => column.name)).toContain("archived_at");
    expect(migrated.connection.prepare("SELECT status, archived_at FROM dispatches WHERE id = 'dispatch-1'").get())
      .toEqual({ status: "launched", archived_at: null });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210926").get())
      .toEqual({ version: 202609210926 });
    migrated.close();
  });

  it("adds the opt-in Agent attention flag without losing an existing DeepSeek key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-agent-attention-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE ai_provider_settings RENAME TO ai_provider_settings_current;
      CREATE TABLE ai_provider_settings (
        name TEXT PRIMARY KEY,
        encrypted_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO ai_provider_settings (name, encrypted_key, updated_at)
      VALUES ('deepseek', 'encrypted-value', '2026-09-21T00:00:00.000Z');
      DROP TABLE ai_provider_settings_current;
      DELETE FROM schema_migrations WHERE version = 202609210802;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare(
      "SELECT encrypted_key, agent_attention_enabled FROM ai_provider_settings WHERE name = 'deepseek'",
    ).get()).toEqual({ encrypted_key: "encrypted-value", agent_attention_enabled: 0 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210802").get())
      .toEqual({ version: 202609210802 });
    migrated.close();
  });

  it("widens legacy Agent sessions to include Claude Code without losing Codex sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-claude-session-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");

    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes
        (id, account_id, name, token_hash, created_at, updated_at)
      VALUES
        ('node-1', 'account-1', 'Mac mini', 'token-hash', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
      INSERT INTO dispatches
        (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES
        ('dispatch-1', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo', '2026-09-21T00:00:00.000Z');
      INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES
        ('session-1', 'dispatch-1', 'node-1', 'codex', 'thread-1', 'idle', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
    `);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE agent_sessions_legacy (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex')),
        agent_session_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'unavailable', 'failed')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO agent_sessions_legacy
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, last_error, created_at, updated_at)
      SELECT id, dispatch_id, node_id, agent_kind, agent_session_ref, status, last_error, created_at, updated_at
      FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_legacy RENAME TO agent_sessions;
      DELETE FROM schema_migrations WHERE version = 202609210206;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    const table = migrated.connection
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
      .get() as unknown as { sql: string };
    expect(table.sql).toContain("'claude_code'");
    const sessionColumns = migrated.connection
      .prepare("PRAGMA table_info(agent_sessions)")
      .all() as unknown as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toContain("archived_at");
    expect(sessionColumns.map((column) => column.name)).toContain("archive_source");
    expect(sessionColumns.map((column) => column.name)).toContain("activity_at");
    const providerColumns = migrated.connection
      .prepare("PRAGMA table_info(ai_provider_settings)")
      .all() as unknown as Array<{ name: string }>;
    expect(providerColumns.map((column) => column.name)).toContain("agent_attention_enabled");
    expect(migrated.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_attention'")
      .get()).toEqual({ name: "agent_session_attention" });
    expect(migrated.connection.prepare("SELECT agent_session_ref FROM agent_sessions WHERE id = 'session-1'").get())
      .toEqual({ agent_session_ref: "thread-1" });
    expect(migrated.connection.prepare("SELECT activity_at FROM agent_sessions WHERE id = 'session-1'").get())
      .toEqual({ activity_at: "2026-09-21T00:00:00.000Z" });
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210206").get())
      .toEqual({ version: 202609210206 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210421").get())
      .toEqual({ version: 202609210421 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210627").get())
      .toEqual({ version: 202609210627 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210802").get())
      .toEqual({ version: 202609210802 });
    migrated.close();
  });

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

  it("backfills historical launched Codex dispatches for source archive synchronization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-codex-session-backfill-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");

    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes
        (id, account_id, name, token_hash, created_at, updated_at)
      VALUES
        ('node-1', 'account-1', 'Mac mini', 'token-hash', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
      INSERT INTO dispatches
        (id, account_id, node_id, agent_kind, mode, status, repo_path, session_url, created_at, completed_at)
      VALUES
        ('dispatch-valid', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo',
         'codex://threads/01a0b2a3-968f-7a43-9d06-781d15a50d84',
         '2026-09-20T01:00:00.000Z', '2026-09-20T01:01:00.000Z'),
        ('dispatch-invalid', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo',
         'codex://threads/unsafe?prompt=ignored',
         '2026-09-20T02:00:00.000Z', '2026-09-20T02:01:00.000Z'),
        ('dispatch-existing', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo',
         'codex://threads/already-mirrored',
         '2026-09-20T03:00:00.000Z', '2026-09-20T03:01:00.000Z');
      INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES
        ('session-existing', 'dispatch-existing', 'node-1', 'codex', 'already-mirrored', 'idle',
         '2026-09-20T03:00:00.000Z', '2026-09-20T03:01:00.000Z');
      DELETE FROM schema_migrations WHERE version = 202609210545;
    `);
    seeded.close();

    const migrated = new MissionGoDatabase(path);
    const recovered = migrated.connection
      .prepare(
        `SELECT dispatch_id, agent_session_ref, status, created_at, updated_at, archived_at, archive_source
         FROM agent_sessions WHERE dispatch_id = 'dispatch-valid'`,
      )
      .get();
    expect(recovered).toEqual({
      dispatch_id: "dispatch-valid",
      agent_session_ref: "01a0b2a3-968f-7a43-9d06-781d15a50d84",
      status: "unavailable",
      created_at: "2026-09-20T01:00:00.000Z",
      updated_at: "2026-09-20T01:01:00.000Z",
      archived_at: null,
      archive_source: null,
    });
    expect(migrated.connection.prepare("SELECT id FROM agent_sessions WHERE dispatch_id = 'dispatch-invalid'").get())
      .toBeUndefined();
    expect(migrated.connection.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE dispatch_id = 'dispatch-existing'").get())
      .toEqual({ count: 1 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210545").get())
      .toEqual({ version: 202609210545 });
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });
});
