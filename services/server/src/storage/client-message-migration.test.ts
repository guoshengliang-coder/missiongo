import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MissionGoDatabase } from "./database.js";
import { AgentSessionStore } from "../agent-session-store.js";

it("AND-527 upgrades the actual previous schema and preserves identities across reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "and527-migration-"));
  const path = join(directory, "fixture.sqlite");
  let database: MissionGoDatabase | undefined;
  try {
    database = new MissionGoDatabase(path);
    const stamp = "2026-11-15T04:24:00Z";
    database.connection.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
      VALUES ('node','owner','migration-fixture','Fixture','synthetic','[]',?,?)`).run(stamp, stamp);
    database.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('dispatch','owner','node','codex','default','launched','synthetic',?)`).run(stamp);
    const sessions = new AgentSessionStore(database);
    const sessionId = sessions.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "native-thread" });
    const native = { sourceId: "native", role: "user" as const, text: "Original user input", occurredAt: stamp };
    sessions.recordSnapshot({ nodeId: "node", sessionId, status: "idle", messages: [native] });
    const command = sessions.enqueue("owner", sessionId, native.text);
    const original = sessions.getForAccount("owner", sessionId).messages[0]!;
    database.connection.exec(`DROP INDEX agent_message_client_identity;
      DROP INDEX external_message_client_identity;
      ALTER TABLE agent_session_messages DROP COLUMN client_message_id;
      DELETE FROM schema_migrations WHERE version=202611150551;`);
    database.close(); database = undefined;
    database = new MissionGoDatabase(path);
    expect(database.connection.prepare("PRAGMA table_info(agent_session_messages)").all()).toContainEqual(expect.objectContaining({ name: "client_message_id", notnull: 0 }));
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=202611150551").get()).toEqual({ n: 1 });
    const migrated = new AgentSessionStore(database);
    expect(migrated.getForAccount("owner", sessionId).messages[0]).toEqual(original);
    migrated.recordSnapshot({ nodeId: "node", sessionId, status: "idle", messages: [{ ...native, clientMessageId: command.id }] });
    expect(migrated.commandById(sessionId, command.id)?.sourceMessageId).toBe(native.sourceId);
    database.close(); database = undefined;
    database = new MissionGoDatabase(path);
    const reopened = new AgentSessionStore(database);
    expect(reopened.commandById(sessionId, command.id)?.sourceMessageId).toBe(native.sourceId);
    expect(reopened.getForAccount("owner", sessionId).messages[0]).toEqual({ ...original, clientMessageId: command.id });
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=202611150551").get()).toEqual({ n: 1 });
  } finally { database?.close(); await rm(directory, { recursive: true, force: true }); }
});
