import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SESSION_MESSAGE_CLOCK_SCHEMA } from "./session-message-clock-schema.js";

it("rebuilds polluted clocks from verified source frontiers and accepted messages, never legacy receipt time", () => {
  const db=new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE session_unread_state(session_key TEXT,source_at TEXT);
      CREATE TABLE agent_sessions(id TEXT,dispatch_id TEXT,activity_at TEXT);
      CREATE TABLE agent_session_messages(session_id TEXT,occurred_at TEXT);
      CREATE TABLE agent_session_commands(id TEXT,session_id TEXT,kind TEXT,created_at TEXT);
      CREATE TABLE external_native_commands(id TEXT,session_id TEXT,created_at TEXT);
      CREATE TABLE external_agent_session_reports(id TEXT,session_id TEXT,created_at TEXT);
      INSERT INTO agent_sessions VALUES ('s','d','2026-11-08T11:24:23.000Z');
      INSERT INTO agent_session_messages VALUES ('s','2026-11-08T11:24:23.000Z');
      INSERT INTO session_unread_state VALUES ('dispatch:d','2026-11-07T03:39:51.894Z');
      INSERT INTO agent_session_commands VALUES ('u','s','message','2026-11-07T02:12:38.000Z');
      INSERT INTO agent_session_commands VALUES ('stop','s','interrupt','2026-11-08T11:24:23.000Z');
      INSERT INTO external_agent_session_reports VALUES ('report','external','2026-11-06T00:00:00.000Z');
      INSERT INTO external_native_commands VALUES ('reply','external','2026-11-07T00:00:00.000Z');`);
    db.exec(SESSION_MESSAGE_CLOCK_SCHEMA);
    expect(db.prepare("SELECT * FROM session_message_clocks ORDER BY session_key").all()).toEqual([
      {session_key:"dispatch:d",message_at:"2026-11-07T03:39:51.894Z"},
      {session_key:"external:external",message_at:"2026-11-07T00:00:00.000Z"},
    ]);
    expect(db.prepare("SELECT activity_at FROM agent_sessions").get()).toEqual({activity_at:"2026-11-08T11:24:23.000Z"});
  } finally {db.close();}
});
