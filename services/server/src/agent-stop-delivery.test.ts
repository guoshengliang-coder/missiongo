import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionStore, STOP_COMMAND_TIMEOUT_MS } from "./agent-session-store.js";
import { MissionGoDatabase } from "./storage/database.js";

const databases: MissionGoDatabase[] = [];
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime("2026-11-04T01:00:00Z");
  const database = new MissionGoDatabase(":memory:");
  databases.push(database);
  const db = database.connection;
  const now = new Date().toISOString();
  for (const node of ["node", "other"]) db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
    VALUES (?,'owner',?,?,?,'[]',?,?)`).run(node, node, node, node, now, now);
  const store = new AgentSessionStore(database);
  const create = (id: string, node = "node") => {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES (?,'owner',?,'codex','default','launched','/synthetic/repo',?)`).run(id, node, new Date().toISOString());
    return store.createForDispatch({ dispatchId: id, nodeId: node, sessionRef: id });
  };
  const sessionId = create("target");
  const snapshot = (input: Omit<Parameters<AgentSessionStore["recordSnapshot"]>[0], "nodeId" | "sessionId">) =>
    store.recordSnapshot({ nodeId: "node", sessionId, ...input });
  snapshot({ status: "active", messages: [{ sourceId: "user", role: "user", text: "Work", turnId: "exact-old-turn" }], turnState: { turnActive: true } });
  return { db, store, create, sessionId, snapshot };
}
afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((database) => database.close());
});

it("expires an unreceived stop on a detail read and allows a new request without claiming the turn stopped", () => {
  const { store, sessionId } = fixture();
  const stop = store.enqueueInterrupt("owner", sessionId);
  expect(store.enqueueInterrupt("owner", sessionId).id).toBe(stop.id);
  vi.advanceTimersByTime(STOP_COMMAND_TIMEOUT_MS);
  expect(store.getForAccount("owner", sessionId)).toMatchObject({
    stopCommand: { id: stop.id, status: "failed", error: expect.stringContaining("未接收") }, turnState: { turnActive: true },
  });
  const retry = store.enqueueInterrupt("owner", sessionId);
  expect(retry.id).not.toBe(stop.id);
  expect(retry.turnId).toBe("exact-old-turn");
});

it("expires an accepted stop without releasing or replaying an ambiguous ordinary reply", () => {
  const { db, store, sessionId, snapshot } = fixture();
  const reply = store.enqueue("owner", sessionId, "Continue");
  snapshot({ status: "active", messages: [], commandId: reply.id, commandStatus: "delivery_unknown" });
  const stop = store.enqueueInterrupt("owner", sessionId);
  snapshot({ status: "active", messages: [], commandId: stop.id, commandStatus: "delivering" });
  vi.advanceTimersByTime(STOP_COMMAND_TIMEOUT_MS);
  store.listForNode("node", true);
  expect(store.getForAccount("owner", sessionId)).toMatchObject({
    stopCommand: { status: "failed", error: expect.stringContaining("未回报") }, command: { id: reply.id, status: "delivery_unknown" },
  });
  expect(db.prepare("SELECT status FROM agent_session_commands WHERE id=?").get(reply.id)).toMatchObject({ status: "delivery_unknown" });
});

it("rejects reservation and late results for expired stops without overwriting a newer stop or task state", () => {
  const { store, sessionId, snapshot } = fixture();
  const old = store.enqueueInterrupt("owner", sessionId);
  vi.advanceTimersByTime(STOP_COMMAND_TIMEOUT_MS);
  const fresh = store.enqueueInterrupt("owner", sessionId);
  for (const commandStatus of ["delivering", "delivered"] as const) {
    expect(() => snapshot({ status: "idle", messages: [], commandId: old.id, commandStatus,
      stopConfirmed: true, turnState: { turnActive: false } })).toThrow();
  }
  expect(store.getForAccount("owner", sessionId)).toMatchObject({
    stopCommand: { id: fresh.id, status: "queued" }, turnState: { turnActive: true },
  });
});

it("rejects an expired poll's reservation even without an intervening console read", () => {
  const { store, sessionId, snapshot } = fixture();
  const old = store.enqueueInterrupt("owner", sessionId);
  vi.advanceTimersByTime(STOP_COMMAND_TIMEOUT_MS);
  expect(() => snapshot({ status: "active", messages: [], commandId: old.id, commandStatus: "delivering" })).toThrow();
  expect(store.getForAccount("owner", sessionId).stopCommand).toMatchObject({ id: old.id, status: "failed" });
});

it("selects stops before the ordinary page limit and retains node isolation", () => {
  const { store, sessionId, create } = fixture();
  const stop = store.enqueueInterrupt("owner", sessionId);
  vi.advanceTimersByTime(1000);
  for (let i = 0; i < 105; i++) create(`mirror-${i}`);
  const other = create("other-node-session", "other");
  store.enqueueInterrupt("owner", other);
  expect(store.listForNode("node")).toHaveLength(100);
  expect(store.listForNode("node", true)).toMatchObject([{ id: sessionId, command: { id: stop.id } }]);
});

it("preserves the startup launch fence while a native turn is not bound", () => {
  const { store, create } = fixture();
  const starting = create("starting");
  const stop = store.enqueueInterrupt("owner", starting);
  expect(stop.turnId).toBe("startup");
  vi.advanceTimersByTime(STOP_COMMAND_TIMEOUT_MS);
  expect(store.getForAccount("owner", starting).stopCommand).toMatchObject({ id: stop.id, status: "queued" });
});
