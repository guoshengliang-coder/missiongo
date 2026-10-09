import { afterEach, expect, it, vi } from "vitest";

import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
function fixture(kind: "codex" | "opencode" | "claude_code" = "codex", refKind: "native" | "tracking" = "native") {
  vi.useFakeTimers(); vi.setSystemTime("2026-10-09T07:00:00Z");
  const store = new MissionGoStore(":memory:"); stores.push(store);
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: kind, idempotencyKey: "claim" });
  const progress = new ExternalAgentSessionStore(store);
  const identity = { agentKind: kind, sessionRef: "exact-native-id", refKind };
  const id = progress.register({ accountId: "owner", clientId: "client" }, identity, item.key);
  const now = new Date().toISOString();
  store.database.connection.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','installation','Example node','synthetic',?,?,?,?)`).run(JSON.stringify([{ kind }]), now, now, now);
  const native = new ExternalNativeSessionStore(store);
  const report = (changes: Partial<Parameters<typeof native.recordSnapshot>[0]> = {}, authorize = (_id: string, _execute: boolean) => {}) => native.recordSnapshot({
    accountId: "owner", nodeId: "node", sessionId: id, generation: 1, workerId: "worker-one", status: "idle", turnState: {},
    messages: [{ sourceId: "user-1", role: "user", text: "Fix the item", occurredAt: now }, { sourceId: "agent-1", role: "agent", text: "Fixed", occurredAt: now }], ...changes }, authorize);
  return { store, progress, native, id, item, identity, report };
}
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach((store) => store.close()); });

it.each(["codex", "opencode"] as const)("connects %s by exact native identity without a dispatch or launch", (kind) => {
  const { native, progress, id, store, item, report } = fixture(kind);
  native.connect("owner", id, "node");
  expect(native.overlay("owner", id)).toMatchObject({ nativeConnection: { state: "pending" }, replyable: false });
  expect(() => native.enqueue("owner", id, "Reply before sync")).toThrow(/successful node sync/);
  const list = native.listForNode("owner", "node", "worker-one", () => {});
  expect(list).toMatchObject([{ sessionRef: "exact-native-id", externalBindingGeneration: 1, occupiesExecutionSlot: false }]);
  expect(list[0]).not.toHaveProperty("dispatchId");
  report();
  expect(progress.getForAccount("owner", id)).toMatchObject({ nativeConnection: { state: "connected" }, replyable: true, status: "idle" });
  expect(progress.getForAccount("owner", id).messages.map((message) => message.role)).toEqual(["agent", "user", "agent"]);
  expect(store.getWorkItem(item.key).status).toBe("in_progress");
  expect(store.database.connection.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toMatchObject({ count: 0 });
});

it("rejects tracking IDs, unsupported Claude control, foreign nodes and duplicate native bindings", () => {
  for (const [kind, ref] of [["codex", "tracking"], ["claude_code", "native"]] as const) {
    const f = fixture(kind, ref); expect(() => f.native.connect("owner", f.id, "node")).toThrow(/verified Codex or OpenCode/);
  }
  const f = fixture();
  expect(() => f.native.connect("different-owner", f.id, "node")).toThrow(/not found/);
  expect(() => f.native.connect("owner", f.id, "missing")).toThrow(/not found/);
  f.native.connect("owner", f.id, "node");
  const second = f.progress.register({ accountId: "owner", clientId: "another-client" }, f.identity, f.item.key);
  expect(() => f.native.connect("owner", second, "node")).toThrow(/already connected/);
});

it("fences disconnected and reconnected snapshots and rechecks every product on each poll and upload", () => {
  const f = fixture(); f.native.connect("owner", f.id, "node"); f.report();
  f.native.disconnect("owner", f.id);
  expect(() => f.report()).toThrow(/not found/);
  f.native.connect("owner", f.id, "node");
  expect(() => f.report()).toThrow(/not found/);
  expect(f.native.listForNode("owner", "node", "worker-one", () => { throw new Error("revoked"); })).toEqual([]);
  expect(() => f.report({ generation: 3 }, () => { throw new Error("revoked"); })).toThrow("revoked");
  expect(f.native.overlay("owner", f.id).nativeConnection?.state).toBe("pending");
  f.report({ generation: 3 });
  expect(f.native.overlay("owner", f.id).nativeConnection?.state).toBe("connected");
});

it("deduplicates changing transcripts, preserves omitted history and advances unread only for changed messages", () => {
  const f = fixture(); f.native.connect("owner", f.id, "node"); f.report();
  const first = f.progress.listForAccount("owner")[0]!.unreadAt!;
  f.progress.markRead("owner", f.id, first); f.report();
  expect(f.progress.listForAccount("owner")[0]!.unread).toBe(false);
  const original = f.progress.getForAccount("owner", f.id).messages.at(-1)!.id;
  f.report({ messages: [{ sourceId: "agent-1", role: "agent", text: "Fixed and checked" }] });
  const detail = f.progress.getForAccount("owner", f.id);
  expect(detail.messages).toHaveLength(3); expect(detail.messages.at(-1)!.id).toBe(original);
  expect(f.progress.listForAccount("owner")[0]!.unread).toBe(true);
  f.report({ status: "unavailable", messages: [], error: "Transport unavailable" });
  expect(f.progress.getForAccount("owner", f.id).messages).toHaveLength(3);
  expect(f.native.overlay("owner", f.id).replyable).toBe(false);
});

it("settles disappeared native questions, preserves answered history and never closes cards on transport failure", () => {
  const f = fixture("opencode"); f.native.connect("owner", f.id, "node");
  const card = { sourceId: "choice", role: "agent" as const, text: "Choose", questions: [{ title: "Which option?", options: ["A", "B"] }] };
  f.report({ messages: [card], turnState: { waitingForInput: true } });
  f.report({ messages: [], status: "unavailable", error: "Offline" });
  expect(f.native.overlay("owner", f.id).nativeMessages[0]!.questions![0]!.withdrawn).toBeUndefined();
  f.report({ messages: [] });
  expect(f.native.overlay("owner", f.id).nativeMessages[0]!.questions![0]!.withdrawn).toBe(true);
  const answered = { ...card, sourceId: "answered", questions: [{ ...card.questions[0]!, answered: "A" }] };
  f.report({ messages: [answered] });
  f.report({ messages: [{ ...answered, questions: card.questions }] });
  expect(f.native.overlay("owner", f.id).nativeMessages.at(-1)!.questions![0]!.answered).toBe("A");
  f.native.disconnect("owner", f.id);
  f.progress.report({ accountId: "owner", clientId: "client" }, f.id, f.item.key, "blocked", "Need help", "blocked");
  f.progress.dismissAttention("owner", f.id, f.progress.listForAccount("owner")[0]!.attention.revision!);
  expect(f.progress.listForAccount("owner")[0]!.needsAttention).toBe(false);
});

it("uses a two-step delivery reservation, disallows cancellation after reservation and preserves a single outcome", () => {
  const f = fixture(); f.native.connect("owner", f.id, "node"); f.report();
  const command = f.native.enqueue("owner", f.id, "Continue");
  const c = { commandId: command.id, commandStatus: "delivering" as const };
  f.report(c); f.report(c);
  expect(() => f.native.cancel("owner", f.id, command.id)).toThrow(/queued/);
  expect(() => f.native.disconnect("owner", f.id)).toThrow(/pending reply/);
  expect(() => f.native.beforeArchive("owner", f.id)).toThrow(/pending reply/);
  f.report({ commandId: command.id, commandStatus: "delivered" });
  f.report({ commandId: command.id, commandStatus: "delivered" });
  expect(f.native.listForNode("owner", "node", "worker-one", () => {})[0]).not.toHaveProperty("command");
  f.native.disconnect("owner", f.id);
  expect(f.native.overlay("owner", f.id)).toMatchObject({ nativeConnection: { state: "disconnected" }, replyable: false });
});

it("never replays a reserved reply after worker restart or delivery timeout", () => {
  const f = fixture(); f.native.connect("owner", f.id, "node"); f.report();
  const command = f.native.enqueue("owner", f.id, "Continue");
  f.report({ commandId: command.id, commandStatus: "delivering" });
  expect(f.native.listForNode("owner", "node", "worker-two", () => {})[0]).not.toHaveProperty("command");
  expect(f.native.overlay("owner", f.id).command?.status).toBe("delivery_unknown");
  expect(() => f.native.enqueue("owner", f.id, "Again")).toThrow(/pending reply/);
  expect(() => f.report({ workerId: "worker-two", commandId: command.id, commandStatus: "delivered" })).toThrow(/previous worker/);
  expect(f.native.resolve("owner", f.id, command.id, "not_received").status).toBe("failed");
  const another = f.native.enqueue("owner", f.id, "New reply");
  f.report({ commandId: another.id, commandStatus: "delivering" });
  vi.advanceTimersByTime(6 * 60_000);
  expect(f.native.overlay("owner", f.id).command?.status).toBe("delivery_unknown");
  expect(f.native.resolve("owner", f.id, another.id, "received").status).toBe("delivered");
});

it("revokes reply capability when the node is offline or revoked and keeps native attention revision-safe", () => {
  const f = fixture(); f.native.connect("owner", f.id, "node"); f.report({ turnState: { waitingForInput: true } });
  const revision = f.progress.listForAccount("owner")[0]!.attention.revision!;
  f.progress.dismissAttention("owner", f.id, revision);
  expect(f.progress.listForAccount("owner")[0]!.needsAttention).toBe(false);
  f.report({ turnState: { waitingForInput: true }, messages: [{ sourceId: "agent-1", role: "agent", text: "A new question" }] });
  expect(() => f.progress.dismissAttention("owner", f.id, revision)).toThrow(/New progress/);
  f.store.database.connection.prepare("UPDATE nodes SET revoked_at=? WHERE id='node'").run(new Date().toISOString());
  expect(f.native.overlay("owner", f.id)).toMatchObject({ nativeConnection: { state: "unavailable" }, replyable: false });
});
