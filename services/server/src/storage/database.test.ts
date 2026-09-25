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
  it("adds development_complete to an existing work_items constraint without losing references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-development-complete-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO products (id, key_prefix, name, next_item_sequence, created_at, updated_at)
      VALUES ('product-1', 'AND', 'Mission GO', 3, '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z');
      INSERT INTO work_items (id, item_key, sequence, product_id, type, priority, status, title, description, created_at, updated_at)
      VALUES ('item-1', 'AND-1', 1, 'product-1', 'task', 'normal', 'pending_verification', 'First', 'Before migration', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z');
      INSERT INTO work_items (id, item_key, sequence, product_id, type, priority, status, title, description, created_at, updated_at, derived_from_item_id)
      VALUES ('item-2', 'AND-2', 2, 'product-1', 'task', 'normal', 'in_progress', 'Child', 'Linked', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', 'item-1');
      INSERT INTO work_item_events (id, item_id, event_type, actor_kind, payload_json, created_at)
      VALUES ('event-1', 'item-1', 'item_created', 'human', '{}', '2026-09-24T00:00:00Z');
    `);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    const row = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'work_items'").get() as { sql: string };
    const oldSchema = row.sql
      .replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?work_items"?/i, "CREATE TABLE work_items_legacy")
      .replace("'in_progress', 'development_complete', 'on_hold'", "'in_progress', 'on_hold'");
    const columns = (legacy.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>)
      .map((column) => `"${column.name}"`).join(", ");
    legacy.exec(oldSchema);
    legacy.exec(`INSERT INTO work_items_legacy (${columns}) SELECT ${columns} FROM work_items;`);
    legacy.exec("DROP TABLE work_items; ALTER TABLE work_items_legacy RENAME TO work_items;");
    legacy.exec("DELETE FROM schema_migrations WHERE version = 202609241537; PRAGMA foreign_keys = ON;");
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare("SELECT item_key, status, derived_from_item_id FROM work_items ORDER BY sequence").all())
      .toEqual([
        { item_key: "AND-1", status: "pending_verification", derived_from_item_id: null },
        { item_key: "AND-2", status: "in_progress", derived_from_item_id: "item-1" },
      ]);
    expect(migrated.connection.prepare("SELECT item_id FROM work_item_events WHERE id = 'event-1'").get())
      .toEqual({ item_id: "item-1" });
    migrated.connection.exec("UPDATE work_items SET status = 'development_complete' WHERE id = 'item-2';");
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  it("adds OpenCode sessions to an existing database without losing mirrored messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-opencode-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at)
      VALUES ('node-1', 'account-1', 'Mac mini', 'hash', '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z');
      INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('dispatch-1', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo', '2026-09-23T00:00:00Z');
      INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES ('session-1', 'dispatch-1', 'node-1', 'codex', 'thread-1', 'idle',
        '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z');
      INSERT INTO agent_session_messages
        (id, session_id, source_id, role, text, position, observed_at, occurred_at)
      VALUES ('message-1', 'session-1', 'source-1', 'agent', 'Existing reply', 0,
        '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z');
    `);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    for (const [name, current, old] of [
      ["dispatches", "agent_kind IN ('claude_code', 'codex', 'opencode', 'hermes')", "agent_kind IN ('claude_code', 'codex', 'hermes')"],
      ["agent_sessions", "agent_kind IN ('codex', 'claude_code', 'opencode')", "agent_kind IN ('codex', 'claude_code')"],
    ]) {
      const table = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string };
      const columns = (legacy.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
        .map((column) => `"${column.name}"`).join(", ");
      const oldSchema = table.sql
        .replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+"?${name}"?`, "i"), `CREATE TABLE ${name}_legacy`)
        .replace(current, old);
      legacy.exec(oldSchema);
      legacy.exec(`INSERT INTO ${name}_legacy (${columns}) SELECT ${columns} FROM ${name};`);
      legacy.exec(`DROP TABLE ${name}; ALTER TABLE ${name}_legacy RENAME TO ${name};`);
    }
    legacy.exec("CREATE INDEX idx_agent_sessions_activity ON agent_sessions(activity_at DESC);");
    legacy.exec("DELETE FROM schema_migrations WHERE version = 202609230957; PRAGMA foreign_keys = ON;");
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare("SELECT text FROM agent_session_messages WHERE id = 'message-1'").get())
      .toEqual({ text: "Existing reply" });
    expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_agent_sessions_activity'").get())
      .toEqual({ name: "idx_agent_sessions_activity" });
    migrated.connection.exec(`
      INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('dispatch-2', 'account-1', 'node-1', 'opencode', 'default', 'launched', '/repo', '2026-09-23T00:00:00Z');
      INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES ('session-2', 'dispatch-2', 'node-1', 'opencode', 'ses-2', 'idle',
        '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z');
    `);
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  it("backfills stable Agent message occurrence times from the last legacy observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-message-time-migration-"));
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
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at, activity_at)
      VALUES
        ('session-1', 'dispatch-1', 'node-1', 'codex', 'thread-1', 'idle',
         '2026-09-21T00:00:00.000Z', '2026-09-21T00:01:00.000Z', '2026-09-21T00:01:00.000Z');
      INSERT INTO agent_session_messages
        (id, session_id, source_id, role, text, position, observed_at, occurred_at)
      VALUES
        ('message-1', 'session-1', 'source-1', 'agent', 'Done', 0,
         '2026-09-21T00:01:00.000Z', '2026-09-21T00:00:30.000Z');
    `);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE agent_session_messages DROP COLUMN occurred_at;
      DELETE FROM schema_migrations WHERE version = 202609220501;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare(
      "SELECT observed_at, occurred_at FROM agent_session_messages WHERE id = 'message-1'",
    ).get()).toEqual({
      observed_at: "2026-09-21T00:01:00.000Z",
      occurred_at: "2026-09-21T00:01:00.000Z",
    });
    expect(migrated.connection.prepare(
      "SELECT version FROM schema_migrations WHERE version = 202609220501",
    ).get()).toEqual({ version: 202609220501 });
    migrated.close();
  });

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

  it("adds the Agent attention flag and enables an existing DeepSeek key", async () => {
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
      DELETE FROM schema_migrations WHERE version = 202609210953;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare(
      "SELECT encrypted_key, agent_attention_enabled FROM ai_provider_settings WHERE name = 'deepseek'",
    ).get()).toEqual({ encrypted_key: "encrypted-value", agent_attention_enabled: 1 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210802").get())
      .toEqual({ version: 202609210802 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210953").get())
      .toEqual({ version: 202609210953 });
    migrated.close();
  });

  it("enables attention once for deployments that already have the old opt-in column", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-agent-attention-default-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.connection.prepare(
      `INSERT INTO ai_provider_settings
        (name, encrypted_key, agent_attention_enabled, updated_at)
       VALUES ('deepseek', 'encrypted-value', 0, '2026-09-21T00:00:00.000Z')`,
    ).run();
    seeded.connection.prepare("DELETE FROM schema_migrations WHERE version = 202609210953").run();
    seeded.close();

    const migrated = new MissionGoDatabase(path);
    expect(migrated.connection.prepare(
      "SELECT agent_attention_enabled FROM ai_provider_settings WHERE name = 'deepseek'",
    ).get()).toEqual({ agent_attention_enabled: 1 });
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210953").get())
      .toEqual({ version: 202609210953 });
    migrated.close();
  });

  it("adds content-bound attention dismissal columns to an existing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-agent-attention-dismissal-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE agent_session_attention DROP COLUMN dismissed_by_account_id;
      ALTER TABLE agent_session_attention DROP COLUMN dismissed_at;
      ALTER TABLE agent_session_attention DROP COLUMN dismissed_message_hash;
      DELETE FROM schema_migrations WHERE version = 202609211500;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    const columns = migrated.connection.prepare("PRAGMA table_info(agent_session_attention)")
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "dismissed_message_hash", "dismissed_at", "dismissed_by_account_id",
    ]));
    expect(migrated.connection.prepare(
      "SELECT version FROM schema_migrations WHERE version = 202609211500",
    ).get()).toEqual({ version: 202609211500 });
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
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations WHERE version = 202609210953").get())
      .toEqual({ version: 202609210953 });
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

  it("widens existing command constraints without losing an in-flight reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-unknown-delivery-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    seeded.connection.exec(`
      INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at)
      VALUES ('node-1', 'account-1', 'Mac mini', 'hash', '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z');
      INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('dispatch-1', 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo', '2026-09-25T00:00:00Z');
      INSERT INTO agent_sessions (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
      VALUES ('session-1', 'dispatch-1', 'node-1', 'codex', 'thread-1', 'idle', '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z');
      INSERT INTO agent_session_commands (id, session_id, account_id, text, status, created_at, delivering_at)
      VALUES ('command-1', 'session-1', 'account-1', 'Keep this reply', 'delivering',
              '2026-09-25T00:00:00Z', '2026-09-25T00:01:00Z');
    `);
    seeded.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX idx_agent_session_one_queued_command;
      ALTER TABLE agent_session_commands RENAME TO agent_session_commands_current;
      CREATE TABLE agent_session_commands (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'interrupt')),
        text TEXT NOT NULL, turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'failed', 'cancelled')),
        error TEXT, created_at TEXT NOT NULL, delivered_at TEXT, delivering_at TEXT, cancelled_at TEXT
      ) STRICT;
      INSERT INTO agent_session_commands
        (id, session_id, account_id, kind, text, turn_id, status, error, created_at, delivered_at, delivering_at, cancelled_at)
      SELECT id, session_id, account_id, kind, text, turn_id, status, error, created_at, delivered_at, delivering_at, cancelled_at
      FROM agent_session_commands_current;
      DROP TABLE agent_session_commands_current;
      CREATE UNIQUE INDEX idx_agent_session_one_queued_command
        ON agent_session_commands(session_id) WHERE status IN ('queued', 'delivering');
      DELETE FROM schema_migrations WHERE version = 202609250630;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    const migrated = new MissionGoDatabase(path);
    const row = migrated.connection.prepare(
      "SELECT status, text, delivering_at FROM agent_session_commands WHERE id = 'command-1'",
    ).get() as unknown as { status: string; text: string; delivering_at: string };
    expect(row).toEqual({ status: "delivering", text: "Keep this reply", delivering_at: "2026-09-25T00:01:00Z" });
    migrated.connection.prepare("UPDATE agent_session_commands SET status = 'delivery_unknown' WHERE id = 'command-1'").run();
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
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

describe("finished hand-off archive migration (AND-129)", () => {
  it("archives conversations whose items had all finished before the release, once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-auto-archive-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missiongo.sqlite");
    const seeded = new MissionGoDatabase(path);
    const at = "2026-09-21T00:00:00.000Z";
    seeded.connection.exec(`
      INSERT INTO products (id, key_prefix, name, next_item_sequence, created_at, updated_at)
      VALUES ('product-1', 'AND', 'Mission GO', 10, '${at}', '${at}');
      INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at)
      VALUES ('node-1', 'account-1', 'Mac mini', 'token-hash', '${at}', '${at}');
    `);
    const item = seeded.connection.prepare(
      `INSERT INTO work_items (id, product_id, item_key, sequence, type, priority, status, title, description, created_at, updated_at)
       VALUES (?, 'product-1', ?, ?, 'task', 'normal', ?, 'T', 'D', '${at}', '${at}')`,
    );
    const dispatch = seeded.connection.prepare(
      `INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
       VALUES (?, 'account-1', 'node-1', 'codex', 'plan', 'launched', '/repo', '${at}')`,
    );
    const link = seeded.connection.prepare("INSERT INTO dispatch_items (dispatch_id, item_id, position) VALUES (?, ?, ?)");
    const session = seeded.connection.prepare(
      `INSERT INTO agent_sessions (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at, activity_at)
       VALUES (?, ?, 'node-1', 'codex', ?, 'idle', '${at}', '${at}', '${at}')`,
    );
    // finished: done + cancelled; open: done + in progress; cancelled-only: nothing accepted.
    let sequence = 0;
    for (const [name, statuses] of [
      ["finished", ["done", "cancelled"]],
      ["open", ["done", "in_progress"]],
      ["cancelled", ["cancelled", "cancelled"]],
    ] as const) {
      dispatch.run(`dispatch-${name}`);
      session.run(`session-${name}`, `dispatch-${name}`, `thread-${name}`);
      statuses.forEach((status, index) => {
        const id = `item-${name}-${index}`;
        sequence += 1;
        item.run(id, `AND-${sequence}`, sequence, status);
        link.run(`dispatch-${name}`, id, index);
      });
    }
    seeded.connection.exec("DELETE FROM schema_migrations WHERE version = 202609220610");
    seeded.close();

    const migrated = new MissionGoDatabase(path);
    const archived = migrated.connection
      .prepare("SELECT id, archive_source, archive_reason, activity_at FROM agent_sessions WHERE archived_at IS NOT NULL")
      .all() as unknown as Array<{ id: string; archive_source: string; archive_reason: string; activity_at: string }>;
    expect(archived).toEqual([
      { id: "session-finished", archive_source: "missiongo", archive_reason: "auto", activity_at: at },
    ]);
    migrated.connection.exec("UPDATE agent_sessions SET archived_at = NULL, archive_reason = NULL");
    migrated.close();
    // Recorded once: reopening the database does not archive again.
    const reopened = new MissionGoDatabase(path);
    expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE archived_at IS NOT NULL").get())
      .toEqual({ count: 0 });
    reopened.close();
  });
});
