import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionStore, type AgentSessionStatus } from "./agent-session-store.js";
import { MissionGoDatabase } from "./storage/database.js";

const databases: MissionGoDatabase[] = [];
const time = (minute: number) => new Date(Date.UTC(2026, 8, 30, 0, minute)).toISOString();
const message = { sourceId: "answer", role: "agent" as const, text: "Result", occurredAt: time(1) };

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(time(0));
  const database = new MissionGoDatabase(":memory:");
  databases.push(database);
  const db = database.connection;
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('node','owner','fixture-node','Fixture','synthetic','[]',?,?)`).run(time(0), time(0));
  const store = new AgentSessionStore(database);
  const create = (id: string) => {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES (?,'owner','node','codex','plan','launched','/synthetic/repo',?)`).run(id, time(0));
    return store.createForDispatch({ dispatchId: id, nodeId: "node", sessionRef: id });
  };
  const sessionId = create("dispatch");
  const snapshot = (input: Omit<Parameters<AgentSessionStore["recordSnapshot"]>[0], "nodeId" | "sessionId">) =>
    store.recordSnapshot({ nodeId: "node", sessionId, ...input });
  const row = () => db.prepare("SELECT activity_at, updated_at, status, last_error, activities_json, activity_repair_pending FROM agent_sessions WHERE id=?")
    .get(sessionId) as { activity_at: string; updated_at: string; status: string; last_error: string | null;
      activities_json: string; activity_repair_pending: number };
  vi.setSystemTime(time(1));
  snapshot({ status: "idle", messages: [message], activityAt: time(1) });
  return { db, store, sessionId, create, snapshot, row };
}

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

it("connection failures, changed errors and recovery preserve list time and ordering", () => {
  const { store, sessionId, create, snapshot, row } = fixture();
  vi.setSystemTime(time(2));
  const newer = create("newer");
  expect(store.listForAccount("owner").map((session) => session.id)).toEqual([newer, sessionId]);
  for (const error of ["Codex 集成已停用；不会读取或回复现有会话。", "Transport failed", "Another sync failure"]) {
    vi.setSystemTime(time(10));
    snapshot({ status: "unavailable", messages: [], error });
    expect(row()).toMatchObject({ activity_at: time(1), updated_at: time(10), status: "unavailable", last_error: error });
    expect(store.listForAccount("owner")[0]!.id).toBe(newer);
  }
  vi.setSystemTime(time(11));
  snapshot({ status: "idle", messages: [message], activityAt: time(1) });
  expect(row()).toMatchObject({ activity_at: time(1), status: "idle", last_error: null });
  snapshot({ status: "idle", messages: [message], error: "Mirror diagnostic" });
  snapshot({ status: "idle", messages: [message] });
  expect(row().activity_at).toBe(time(1));
});

it("empty unavailable reports retain tasks, so restoring the same snapshot is not progress", () => {
  const { snapshot, row } = fixture();
  const activities = [{ id: "task", title: "Check", startedAt: time(2) }];
  vi.setSystemTime(time(2));
  snapshot({ status: "active", messages: [message], activities, turnState: { turnActive: true } });
  vi.setSystemTime(time(10));
  snapshot({ status: "unavailable", messages: [], activities: [], error: "Sync failed" });
  expect(row().activity_at).toBe(time(2));
  expect(JSON.parse(row().activities_json)).toEqual(activities);
  snapshot({ status: "active", messages: [message], activities, turnState: { turnActive: true } });
  expect(row().activity_at).toBe(time(2));
  vi.setSystemTime(time(11));
  snapshot({ status: "active", messages: [message], activities: [{ ...activities[0]!, detail: "Completed" }] });
  expect(row().activity_at).toBe(time(11));
});

it.each<AgentSessionStatus>(["active", "stalled", "suspended", "failed"])("real task status %s remains activity", (status) => {
  const { snapshot, row } = fixture();
  vi.setSystemTime(time(3));
  snapshot({ status, messages: [message] });
  expect(row().activity_at).toBe(time(3));
});

it("new messages, source progress and user commands update time without moving it backwards", () => {
  const { snapshot, row, store, sessionId } = fixture();
  vi.setSystemTime(time(3));
  snapshot({ status: "idle", messages: [{ ...message, text: "New result", occurredAt: time(3) }], activityAt: time(3) });
  expect(row().activity_at).toBe(time(3));
  vi.setSystemTime(time(4));
  const current = { ...message, text: "New result", occurredAt: time(3) };
  snapshot({ status: "idle", messages: [current], activityAt: time(4) });
  expect(row().activity_at).toBe(time(4));
  vi.setSystemTime(time(5));
  const command = store.enqueue("owner", sessionId, "Continue");
  expect(row().activity_at).toBe(time(5));
  snapshot({ status: "active", messages: [current], activityAt: time(3), commandId: command.id, commandStatus: "delivered" });
  expect(row().activity_at).toBe(time(5));
  vi.setSystemTime(time(6));
  snapshot({ status: "active", messages: [current], activityAt: time(3), commandId: command.id, commandStatus: "delivered" });
  expect(row().activity_at).toBe(time(5));
});

it("an uncertain transport delivery does not refresh time beyond the user's send", () => {
  const { snapshot, row, store, sessionId } = fixture();
  vi.setSystemTime(time(3));
  const command = store.enqueue("owner", sessionId, "Continue");
  vi.setSystemTime(time(10));
  snapshot({ status: "unavailable", messages: [], error: "Sync failed", commandId: command.id, commandStatus: "delivery_unknown" });
  expect(row().activity_at).toBe(time(3));
});

it.each(["source-clock", "source-message"])("repairs a flagged historical time using %s and later durable user operations", (evidence) => {
  const { db, sessionId, snapshot, row } = fixture();
  db.prepare("UPDATE agent_sessions SET status='unavailable', activity_at=?, activity_repair_pending=1 WHERE id=?")
    .run(time(10), sessionId);
  db.prepare(`INSERT INTO agent_session_commands(id,session_id,account_id,text,status,created_at,cancelled_at)
    VALUES ('historical-command',?,'owner','Continue','cancelled',?,?)`).run(sessionId, time(2), time(3));
  vi.setSystemTime(time(11));
  snapshot({ status: "idle", messages: [message], ...(evidence === "source-clock" ? { activityAt: time(1) } : {}) });
  expect(row()).toMatchObject({ activity_at: time(3), activity_repair_pending: 0 });
  vi.setSystemTime(time(12));
  snapshot({ status: "idle", messages: [message], activityAt: time(1) });
  expect(row().activity_at).toBe(time(3));
});

it("unverified legacy timestamps are preserved; a later authoritative report can repair them", () => {
  const { db, sessionId, snapshot, row } = fixture();
  db.prepare("UPDATE agent_sessions SET status='unavailable', activity_at=?, activity_repair_pending=1 WHERE id=?")
    .run(time(10), sessionId);
  vi.setSystemTime(time(11));
  const withoutTimestamp = { sourceId: message.sourceId, role: message.role, text: message.text };
  snapshot({ status: "idle", messages: [withoutTimestamp] });
  expect(row()).toMatchObject({ activity_at: time(10), activity_repair_pending: 1 });
  snapshot({ status: "idle", messages: [message] });
  expect(row()).toMatchObject({ activity_at: time(1), activity_repair_pending: 0 });
});

it("a user operation after migration supersedes pending historical recovery", () => {
  const { db, sessionId, snapshot, row, store } = fixture();
  db.prepare("UPDATE agent_sessions SET status='unavailable', activity_at=?, activity_repair_pending=1 WHERE id=?")
    .run(time(10), sessionId);
  vi.setSystemTime(time(11));
  store.enqueue("owner", sessionId, "Continue");
  expect(row()).toMatchObject({ activity_at: time(11), activity_repair_pending: 0 });
  snapshot({ status: "idle", messages: [message], activityAt: time(1) });
  expect(row().activity_at).toBe(time(11));
});

it("an older message alone cannot repair a running session's newer task progress", () => {
  const { db, sessionId, snapshot, row } = fixture();
  const activities = [{ id: "task", title: "Check", startedAt: time(2) }];
  vi.setSystemTime(time(2));
  snapshot({ status: "active", messages: [message], activities, turnState: { lastOutputAt: time(2) } });
  db.prepare("UPDATE agent_sessions SET status='unavailable', activity_at=?, activity_repair_pending=1 WHERE id=?")
    .run(time(10), sessionId);
  vi.setSystemTime(time(11));
  snapshot({ status: "active", messages: [message], activities });
  expect(row()).toMatchObject({ activity_at: time(10), activity_repair_pending: 1 });
  snapshot({ status: "active", messages: [message], activities, activityAt: time(1) });
  expect(row()).toMatchObject({ activity_at: time(2), activity_repair_pending: 0 });
});
