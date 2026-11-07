import { afterEach, expect, it } from "vitest";
import { MissionGoDatabase } from "./storage/database.js";
import { observeSessionUnread, acknowledgeSessionUnread, type UnreadMessage } from "./session-unread.js";

const databases: MissionGoDatabase[] = [];
const time = (minute: number) => new Date(Date.UTC(2026, 10, 7, 0, minute)).toISOString();
const message = (id: string, minute?: number, phase?: string): UnreadMessage => ({
  sourceId: id, role: "agent", occurredAt: minute === undefined ? undefined : time(minute), phase,
});
function fixture() {
  const db = new MissionGoDatabase(":memory:"); databases.push(db);
  let stored: UnreadMessage[] = [];
  let status = "idle";
  let minute = 10;
  const report = (messages: UnreadMessage[], nextStatus = "idle") => db.transaction(() => {
    const unread = observeSessionUnread(db, { key: "test", previousStatus: status, status: nextStatus,
      now: time(minute++), stored, messages });
    stored = [...new Map([...stored, ...messages].map(m => [m.sourceId, m])).values()];
    status = nextStatus;
    return unread;
  });
  return { db, report };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

it("stores a stable frontier across restart/recovery, filtering old output and execution records", () => {
  const f = fixture();
  expect(f.report([message("answer", 5)])).toBe(true);
  expect(f.report([], "unavailable")).toBe(false);
  expect(f.report([message("old-tool", 9, "execution"), message("backfill", 2), message("answer", 5)])).toBe(false);
  expect(f.report([message("offline-answer", 8)])).toBe(true);
  expect(f.report([message("offline-answer", 8)])).toBe(false);
  const events = f.db.connection.prepare("SELECT reason,source_at FROM session_unread_events ORDER BY received_at").all();
  expect(events).toEqual([{ reason: "new_output", source_at: time(5) }, { reason: "new_output", source_at: time(8) }]);
});

it("does not lose new messages sharing a source timestamp or legacy messages without timestamps", () => {
  const f = fixture();
  expect(f.report([message("a", 5)])).toBe(true);
  expect(f.report([message("b", 5)])).toBe(true);
  expect(f.report([message("undated")])).toBe(true);
  expect(f.report([message("undated")])).toBe(false);
});

it("does not repeat failed/stalled/completed status on transport recovery", () => {
  const f = fixture();
  expect(f.report([], "active")).toBe(false);
  expect(f.report([], "failed")).toBe(true);
  expect(f.report([], "unavailable")).toBe(false);
  expect(f.report([], "failed")).toBe(false);
  expect(f.report([], "active")).toBe(false);
  expect(f.report([], "unavailable")).toBe(false);
  expect(f.report([], "idle")).toBe(true);
  expect(f.report([], "unavailable")).toBe(false);
  expect(f.report([], "idle")).toBe(false);
  expect(f.report([], "active")).toBe(false);
  expect(f.report([], "failed")).toBe(true);
});

it("notifies newly attached or revised open questions, not answered historical cards", () => {
  const f = fixture();
  const original = message("ask", 5);
  f.report([original]);
  const question = { ...original, questions: [{ title: "Choose", answered: undefined }] };
  expect(f.report([question])).toBe(true);
  expect(f.report([question])).toBe(false);
  expect(f.report([{ ...question, questions: [{ title: "Changed" }] }])).toBe(true);
  expect(f.report([{ ...message("past", 1), questions: [{ answered: "yes" }] }])).toBe(false);
});

it("a source replay omitting an acknowledged answer cannot reopen a settled card", () => {
  const f = fixture();
  f.report([{ ...message("settled", 5), questions: [{ answered: "yes" }] }]);
  expect(f.report([{ ...message("settled", 5), questions: [{}] }])).toBe(false);
});

it("legacy receipt-time fallbacks cannot hide genuine offline output on first recovery", () => {
  const db = new MissionGoDatabase(":memory:"); databases.push(db);
  const stored = [message("known", 9)]; // Old server stored poll time, not source time.
  const report = (messages: UnreadMessage[], status: string) => observeSessionUnread(db, {
    key: "legacy", previousStatus: "unavailable", status, now: time(10), stored, messages,
  });
  expect(report([], "unavailable")).toBe(false);
  expect(report([message("known", 1),message("historical", 0),message("offline", 5)], "idle")).toBe(true);
  expect(db.connection.prepare("SELECT event_key FROM session_unread_events").all()).toEqual([{ event_key: "message:offline" }]);
});

it("a newly discovered unresolved question remains actionable even with an old source timestamp", () => {
  const f = fixture(); f.report([message("answer", 5)]);
  expect(f.report([{ ...message("ask", 1), questions: [{}] }])).toBe(true);
});

it("records the source boundary covered by an acknowledgement without absorbing later arrivals", () => {
  const f = fixture();
  f.report([message("a", 5)]);
  f.report([message("b", 6)]);
  acknowledgeSessionUnread(f.db, "test", time(10));
  expect(f.db.connection.prepare("SELECT read_source_at FROM session_unread_state WHERE session_key='test'").get())
    .toEqual({ read_source_at: time(5) });
});
