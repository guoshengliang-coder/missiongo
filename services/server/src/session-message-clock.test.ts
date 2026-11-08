import { afterEach, expect, it, vi } from "vitest";
import { MissionGoDatabase } from "./storage/database.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { observeMessageTimes, recordMessageTime } from "./session-message-clock.js";

const databases: MissionGoDatabase[] = [];
const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T03:39:51.894Z`;
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(at(7));
  const database = new MissionGoDatabase(":memory:"); databases.push(database);
  const db = database.connection;
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES ('node','owner','fixture','Node','synthetic','[]',?,?)`).run(at(7), at(7));
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner','node','codex','auto','launched','/synthetic/repo',?)`).run(at(7));
  const store = new AgentSessionStore(database);
  const id = store.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "native" });
  const snapshot = (input: Omit<Parameters<typeof store.recordSnapshot>[0], "sessionId" | "nodeId">) =>
    store.recordSnapshot({ ...input, sessionId: id, nodeId: "node" });
  const time = () => store.listForAccount("owner")[0]!.activityAt;
  return { db, database, store, id, snapshot, time };
}

it("metadata, settings, reconnect, tasks, status and archive cannot promote yesterday's conversation", () => {
  const f = fixture();
  const message = { sourceId: "answer", role: "agent" as const, text: "Result", occurredAt: at(7) };
  f.snapshot({ status: "idle", messages: [message] });
  vi.setSystemTime(at(8));
  for (const status of ["unavailable", "idle", "active", "failed", "idle"] as const) {
    f.snapshot({ status, messages: [message], activityAt: at(8), model: "model", settingsRevision: 1,
      activities: [{ id: "task", title: "sync", startedAt: at(8) }] });
    expect(f.time()).toBe(at(7));
  }
  f.store.setArchived("owner", f.id, true);
  expect(f.time()).toBe(at(7));
  f.store.setArchived("owner", f.id, false);
  expect(f.time()).toBe(at(7));
});

it("history backfill, timestamp-free records and duplicate streams never use receipt time", () => {
  const { db, time, snapshot } = fixture();
  snapshot({ status: "idle", messages: [{ sourceId: "answer", role: "agent", text: "Result", occurredAt: at(7) }] });
  vi.setSystemTime(at(9));
  snapshot({ status: "idle", activityAt: at(9), messages: [
    { sourceId: "old", role: "agent", text: "Backfill", occurredAt: at(6) },
    { sourceId: "unknown", role: "agent", text: "Undated history" },
    { sourceId: "answer", role: "agent", text: "Updated stream", occurredAt: at(9) },
    { sourceId: "tool", role: "agent", phase: "execution", text: "Tool JSON", occurredAt: at(9) },
  ] });
  expect(time()).toBe(at(7));
  expect(db.prepare("SELECT COUNT(*) AS n FROM session_message_times").get()).toEqual({ n: 2 });
});

it("offline new replies retain source time and accepted attachment-only replies use server time", () => {
  const f = fixture(); vi.setSystemTime(at(10));
  f.snapshot({ status: "idle", messages: [{ sourceId: "offline", role: "agent", text: "Offline result", occurredAt: at(9) }] });
  expect(f.time()).toBe(at(9));
  // The same primitive is called in the attachment-binding transaction.
  recordMessageTime(f.db, "dispatch:dispatch", "command:attachment-only", at(10));
  expect(f.time()).toBe(at(10));
  recordMessageTime(f.db, "dispatch:dispatch", "command:attachment-only", at(11));
  expect(f.time()).toBe(at(10));
});

it("rejects impossible source clocks and keeps an external mirror on the same message semantics", () => {
  const f = fixture();
  observeMessageTimes(f.db, "external:mirror", [
    { sourceId: "bad", occurredAt: "invalid" }, { sourceId: "future", occurredAt: at(20) },
    { sourceId: "actual", occurredAt: at(6) },
  ], at(8));
  expect(f.db.prepare("SELECT message_at FROM session_message_clocks WHERE session_key='external:mirror'").get())
    .toEqual({ message_at: at(6) });
});
