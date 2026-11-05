import { afterEach, expect, it } from "vitest";
import { AgentHistory } from "./agent-history.js";
import { AgentArtifacts } from "./agent-artifacts.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { MissionGoDatabase } from "./storage/database.js";

const databases: MissionGoDatabase[] = [];
function fixture() {
  const database = new MissionGoDatabase(":memory:"); databases.push(database);
  const db = database.connection; const now = new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('node','owner','history-fixture','Node','synthetic','[]',?,?)`).run(now, now);
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner','node','codex','plan','launched','/synthetic/repo',?)`).run(now);
  const sessions = new AgentSessionStore(database);
  const id = sessions.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "exact-thread" });
  const history = new AgentHistory(database, new AgentArtifacts(database, "/synthetic/artifacts"));
  const messages = [{ id: "recent", sourceId: "recent", role: "agent" as const, text: "Recent", occurredAt: now }];
  const head = () => history.window("owner", id, messages).history.nextCursor!;
  return { database, db, history, sessions, id, messages, head };
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

it("queues source history independently and caches a page idempotently", () => {
  const f = fixture();
  f.history.observe("owner", "node", f.id, { cursor: "opaque-source-anchor", complete: false });
  const page = f.head();
  expect(f.history.request("owner", f.id, page).status).toBe("pending");
  f.history.request("owner", f.id, page);
  expect(f.history.jobs("owner", "node")).toEqual([{ id: page, sessionId: f.id, sessionRef: "exact-thread", agentKind: "codex", cursor: "opaque-source-anchor" }]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toEqual({ n: 0 });
  const result = { messages: [{ sourceId: "old", role: "agent", text: "Earlier" }], nextCursor: "still-older" };
  f.history.complete("owner", "node", page, result);
  f.history.complete("owner", "node", page, result);
  const cached = f.history.request("owner", f.id, page);
  expect(cached).toMatchObject({ status: "ready", messages: [{ sourceId: "old", text: "Earlier", occurredAt: "" }] });
  expect(cached.nextCursor).toBeTruthy();
  expect(f.history.jobs("owner", "node")).toEqual([]);
  expect(f.history.cachedMessages("owner", f.id)).toMatchObject([{ sourceId: "old" }]);
});

it("paginates stored messages without deleting or reordering them", () => {
  const f = fixture();
  const messages = Array.from({ length: 123 }, (_, n) => ({ ...f.messages[0]!, id: `id-${n}`, sourceId: `source-${n}` }));
  const latest = f.history.window("owner", f.id, messages);
  expect(latest.messages).toEqual(messages.slice(73));
  const middle = f.history.window("owner", f.id, messages, latest.history.nextCursor);
  expect(middle.messages).toEqual(messages.slice(23, 73));
  const oldest = f.history.window("owner", f.id, messages, middle.history.nextCursor);
  expect(oldest.messages).toEqual(messages.slice(0, 23));
  expect(oldest.history.nextCursor).toBeUndefined();
  expect(messages).toHaveLength(123);
});

it("checks account, node and current native binding for every source result", () => {
  const f = fixture(); f.history.observe("owner", "node", f.id, { cursor: "anchor", complete: false });
  const page = f.head(); f.history.request("owner", f.id, page);
  expect(() => f.history.get("another", f.id, page)).toThrow();
  expect(() => f.history.complete("owner", "wrong-node", page, { messages: [] })).toThrow();
  expect(() => f.history.request("owner", f.id, "unissued-cursor")).toThrow();
  f.db.prepare("UPDATE agent_sessions SET agent_session_ref='rebound-thread' WHERE id=?").run(f.id);
  expect(f.history.jobs("owner", "node")).toEqual([]);
  expect(() => f.history.complete("owner", "node", page, { messages: [] })).toThrow();
});

it("retains old cursors when the recent window advances and rejects cursor cycles", () => {
  const f = fixture(); f.history.observe("owner", "node", f.id, { cursor: "first", complete: false });
  const first = f.head();
  f.history.observe("owner", "node", f.id, { cursor: "second", complete: false });
  const second = f.head();
  f.history.request("owner", f.id, first);
  f.history.complete("owner", "node", first, { messages: [], nextCursor: "second" });
  f.history.request("owner", f.id, second);
  expect(() => f.history.complete("owner", "node", second, { messages: [], nextCursor: "first" })).toThrow(/cycle/);
});

it("history reads never change runtime state, activity, unread or stored messages", () => {
  const f = fixture();
  f.sessions.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "active", messages: f.messages });
  const before = f.db.prepare("SELECT * FROM agent_sessions WHERE id=?").get(f.id);
  const stored = f.db.prepare("SELECT * FROM agent_session_messages WHERE session_id=?").all(f.id);
  f.history.observe("owner", "node", f.id, { cursor: "anchor", complete: false });
  const page = f.head(); f.history.request("owner", f.id, page);
  f.history.complete("owner", "node", page, { messages: [{ sourceId: "older", role: "user", text: "Original" }] });
  expect(f.db.prepare("SELECT * FROM agent_sessions WHERE id=?").get(f.id)).toEqual(before);
  expect(f.db.prepare("SELECT * FROM agent_session_messages WHERE session_id=?").all(f.id)).toEqual(stored);
});

it("supports retry after a failed historical read and refuses unscoped payloads", () => {
  const f = fixture(); f.history.observe("owner", "node", f.id, { cursor: "anchor", complete: false });
  const page = f.head(); f.history.request("owner", f.id, page);
  f.history.complete("owner", "node", page, { messages: [], error: "node_unavailable" });
  expect(f.history.get("owner", f.id, page).status).toBe("failed");
  expect(f.history.request("owner", f.id, page).status).toBe("pending");
  expect(() => f.history.complete("owner", "node", page, { messages: [], nextCursor: "anchor" })).toThrow();
  expect(() => f.history.complete("owner", "node", page, { messages: [{ sourceId: "tool", role: "tool", text: "output" }] })).toThrow();
});

it("supports external native Codex history and invalidates it when the node binding is removed", () => {
  const f = fixture(); const now = new Date().toISOString();
  f.db.prepare(`INSERT INTO external_agent_sessions
    (id,account_id,client_id,agent_kind,session_ref,ref_kind,progress_status,created_at,updated_at,activity_at,native_node_id)
    VALUES ('external','owner','external-client','codex','external-thread','native','working',?,?,?,'node')`).run(now, now, now);
  f.history.observe("owner", "node", "external", { cursor: "external-cursor", complete: false });
  const cursor = f.history.window("owner", "external", []).history.nextCursor!;
  f.history.request("owner", "external", cursor);
  expect(f.history.jobs("owner", "node")).toMatchObject([{ sessionId: "external", sessionRef: "external-thread" }]);
  f.history.complete("owner", "node", cursor, { messages: [{ sourceId: "old", role: "agent", text: "Old answer",
    questions: [{ title: "Old question", options: ["Yes"], answered: "Yes" }] }] });
  expect(f.history.get("owner", "external", cursor).messages[0]!.questions).toMatchObject([{ answered: "Yes" }]);
  f.db.prepare("UPDATE external_agent_sessions SET native_node_id=NULL WHERE id='external'").run();
  expect(() => f.history.get("owner", "external", cursor)).toThrow();
});
