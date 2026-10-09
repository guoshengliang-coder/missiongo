import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const owner = { accountId: "owner", clientId: "client" };
const identity = { agentKind: "codex" as const, sessionRef: "native-thread", refKind: "native" as const };

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-09T00:00:00Z");
  const store = new MissionGoStore(":memory:");
  stores.push(store);
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const create = () => {
    const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
    store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
    store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: `claim:${item.key}` });
    return store.getWorkItem(item.key);
  };
  const item = create();
  const sessions = new ExternalAgentSessionStore(store);
  const id = sessions.register(owner, identity, item.key);
  return { store, sessions, id, item, create };
}

afterEach(() => {
  vi.useRealTimers();
  stores.splice(0).forEach((store) => store.close());
});

it("deduplicates a conversation across multiple items and keeps different clients separate", () => {
  const { sessions, id, item, create } = fixture();
  const second = create();
  expect(sessions.register(owner, identity, item.key)).toBe(id);
  expect(sessions.register(owner, identity, second.key)).toBe(id);
  expect(sessions.getForAccount(owner.accountId, id).messages).toHaveLength(2);
  expect(sessions.listForAccount(owner.accountId)[0]!.items.map((item) => item.key)).toEqual([item.key, second.key]);
  expect(sessions.register({ ...owner, clientId: "different-client" }, identity, item.key)).not.toBe(id);
});

it("rejects updates from another account or client and checks every linked item", () => {
  const { sessions, id, item, create } = fixture();
  const second = create();
  sessions.register(owner, identity, second.key);
  expect(() => sessions.report({ ...owner, accountId: "other" }, id, item.key, "failed", "Spoof", "spoof")).toThrow(/not found/);
  expect(() => sessions.report({ ...owner, clientId: "other" }, id, item.key, "failed", "Spoof", "spoof")).toThrow(/not found/);
  const checked: string[] = [];
  expect(() => sessions.authorize(owner, id, item.key, (key) => {
    checked.push(key);
    if (key === second.key) throw new Error("product revoked");
  })).toThrow("product revoked");
  expect(checked).toEqual([item.key, second.key]);
  expect(sessions.getForAccount(owner.accountId, id).progressStatus).toBe("working");
});

it("report retries neither duplicate messages nor reopen a newer completed report", () => {
  const { sessions, id, item, store } = fixture();
  sessions.report(owner, id, item.key, "working", "Checking", "progress");
  sessions.report(owner, id, item.key, "completed", "Finished handling", "finish");
  sessions.report(owner, id, item.key, "working", "Checking", "progress");
  expect(sessions.getForAccount(owner.accountId, id)).toMatchObject({ status: "idle", progressStatus: "completed" });
  expect(sessions.getForAccount(owner.accountId, id).messages).toHaveLength(3);
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  expect(() => sessions.report(owner, id, item.key, "failed", "Different", "finish")).toThrow(/different content/);
});

it("degrades a stale report without changing the item, and explicit progress restores it", () => {
  const { sessions, id, item, store } = fixture();
  vi.advanceTimersByTime(31 * 60_000);
  expect(sessions.getForAccount(owner.accountId, id)).toMatchObject({ status: "unavailable", progressStatus: "working" });
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  sessions.report(owner, id, item.key, "waiting_for_input", "Need a decision", "question");
  expect(sessions.listForAccount(owner.accountId)[0]).toMatchObject({ status: "stalled", needsAttention: true });
});

it("keeps new arrivals unread and refuses future read clocks", () => {
  const { sessions, id, item } = fixture();
  const first = sessions.listForAccount(owner.accountId)[0]!.unreadAt!;
  sessions.report(owner, id, item.key, "completed", "Done", "finish");
  sessions.markRead(owner.accountId, id, first);
  expect(sessions.listForAccount(owner.accountId)[0]!.unread).toBe(true);
  const latest = sessions.listForAccount(owner.accountId)[0]!.unreadAt!;
  sessions.markRead(owner.accountId, id, latest);
  expect(sessions.listForAccount(owner.accountId)[0]!.unread).toBe(false);
  expect(() => sessions.markRead(owner.accountId, id, "2099-01-01T00:00:00Z")).toThrow(/observed/);
});

it("dismissal is revision-safe and archiving controls only the progress record", () => {
  const { sessions, id, item, store } = fixture();
  sessions.report(owner, id, item.key, "blocked", "Blocked", "blocked");
  const revision = sessions.listForAccount(owner.accountId)[0]!.attention.revision!;
  sessions.dismissAttention(owner.accountId, id, revision);
  expect(sessions.listForAccount(owner.accountId)[0]!.needsAttention).toBe(false);
  sessions.report(owner, id, item.key, "waiting_for_input", "New question", "question");
  expect(() => sessions.dismissAttention(owner.accountId, id, revision)).toThrow(/New progress/);
  sessions.setArchived(owner.accountId, id, true);
  expect(sessions.getForAccount(owner.accountId, id).archivedSource).toBe("missiongo");
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  sessions.setArchived(owner.accountId, id, false);
  expect(sessions.getForAccount(owner.accountId, id).archivedAt).toBeUndefined();
});

it("does not let registration change reference kind or claim a ready item", () => {
  const { sessions, id, item, store } = fixture();
  expect(() => sessions.register(owner, { ...identity, refKind: "tracking" }, item.key)).toThrow(/cannot change/);
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "released", actor: "human", note: "Another round" });
  // An idempotent registration remains readable, but a fresh conversation cannot claim it.
  expect(sessions.register(owner, identity, item.key)).toBe(id);
  expect(() => sessions.register(owner, { ...identity, sessionRef: "new-thread" }, item.key)).toThrow(/Claim the ready item/);
  expect(store.getWorkItem(item.key).status).toBe("ready");
});

it("persists session identity and reports across database reopen without rerunning the migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-external-session-"));
  const path = join(directory, "missiongo.sqlite");
  let store = new MissionGoStore(path);
  try {
    const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
    const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
    store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
    store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
    const sessions = new ExternalAgentSessionStore(store);
    const id = sessions.register(owner, identity, item.key);
    sessions.report(owner, id, item.key, "completed", "Handling ended", "end");
    store.close();
    store = new MissionGoStore(path);
    const reopened = new ExternalAgentSessionStore(store);
    expect(reopened.register(owner, identity, item.key)).toBe(id);
    expect(reopened.getForAccount(owner.accountId, id)).toMatchObject({ progressStatus: "completed", messages: [{}, {}] });
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 202610090518").get()).toMatchObject({ n: 1 });
    expect(store.database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
