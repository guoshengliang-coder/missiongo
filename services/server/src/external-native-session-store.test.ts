import { afterEach, expect, it, vi } from "vitest";

import { AgentSessionStore } from "./agent-session-store.js";
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

it.each(["delivered", "failed"] as const)("archives a finished external record when its last reply is %s, without archiving the source", (status) => {
  const f = fixture();
  f.native.connect("owner", f.id, "node"); f.report();
  const command = f.native.enqueue("owner", f.id, "Continue");
  f.report({ commandId: command.id, commandStatus: "delivering" });
  for (const [to, reason] of [["development_complete", "resolution_submitted"], ["pending_verification", "release_verified"], ["done", "verification_passed"]] as const) {
    f.store.transitionWorkItem({ itemKey: f.item.key, to, reason, actor: "human" });
  }
  expect(f.progress.getForAccount("owner", f.id).archivedAt).toBeUndefined();
  f.report({ commandId: command.id, commandStatus: status });
  expect(f.progress.getForAccount("owner", f.id).archivedSource).toBe("missiongo");
  expect(f.progress.getForAccount("owner", f.id).progressStatus).toBe("working");
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true)).toEqual([]);
  const row = f.store.database.connection.prepare("SELECT native_snapshot_json FROM external_agent_sessions WHERE id=?").get(f.id) as { native_snapshot_json: string };
  expect(JSON.parse(row.native_snapshot_json).sourceArchived).toBeUndefined();
});

it.each(["codex", "opencode", "claude_code"] as const)("keeps the existing %s channel and resumes duplicate probing only after disconnect", (kind) => {
  const f = fixture(kind);
  f.native.connect("owner", f.id, "node"); f.report();
  const command = f.native.enqueue("owner", f.id, "Keep this reply");
  const duplicate = f.progress.register({ accountId: "owner", clientId: "another-client" }, { ...f.identity, autoConnect: true }, f.item.key);
  const unrelated = f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, sessionRef: "other-thread", autoConnect: true }, f.item.key);
  const offers = f.native.listForNode("owner", "node", "worker-one", () => {}, true);
  expect(offers.map((offer) => offer.id)).toEqual([f.id, unrelated]);
  expect(offers[0]!.command?.id).toBe(command.id);
  expect(f.native.overlay("owner", f.id).replyable).toBe(true);
  expect(f.native.overlay("owner", duplicate).nativeConnection?.nodeId).toBeUndefined();
  expect(f.progress.listForAccount("owner")).toHaveLength(3);
  f.native.cancel("owner", f.id, command.id);
  f.native.disconnect("owner", f.id);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true).map((offer) => offer.id)).toContain(duplicate);
});

it("does not let duplicate automatic mirrors fill the polling limit", () => {
  const f = fixture(); const db = f.store.database.connection;
  f.native.connect("owner", f.id, "node"); f.report();
  for (let index = 0; index < 100; index++) {
    const id = `000-duplicate-${index}`;
    db.prepare(`INSERT INTO external_agent_sessions
      (id,account_id,client_id,agent_kind,session_ref,ref_kind,progress_status,created_at,updated_at,activity_at,native_auto_connect)
      SELECT ?,account_id,?,agent_kind,session_ref,ref_kind,progress_status,created_at,updated_at,activity_at,1
      FROM external_agent_sessions WHERE id=?`).run(id, `client-${index}`, f.id);
    db.prepare("INSERT INTO external_agent_session_items(session_id,item_id) VALUES (?,?)").run(id, f.item.id);
  }
  const unrelated = f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, sessionRef: "other-thread", autoConnect: true }, f.item.key);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true).map((offer) => offer.id)).toEqual([f.id, unrelated]);
});

it("rejects a stale competing probe without changing the winner's reply or messages", () => {
  const f = fixture();
  const duplicate = f.progress.register({ accountId: "owner", clientId: "another-client" }, { ...f.identity, autoConnect: true }, f.item.key);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true).map((offer) => offer.id)).toContain(duplicate);
  f.native.connect("owner", f.id, "node"); f.report();
  const command = f.native.enqueue("owner", f.id, "Original reply");
  const before = f.native.overlay("owner", f.id);
  expect(() => f.report({ sessionId: duplicate, generation: 0, autoConnect: true, nativeSessionRef: f.identity.sessionRef }))
    .toThrow(expect.objectContaining({ statusCode: 409, code: "external_native_already_bound" }));
  expect(f.native.overlay("owner", f.id)).toEqual(before);
  expect(f.native.overlay("owner", f.id).command?.id).toBe(command.id);
  expect(f.native.overlay("owner", duplicate).nativeMessages).toEqual([]);
});

it("excludes a dispatch-bound native identity only on its exact node and agent", () => {
  const f = fixture(); const db = f.store.database.connection;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner','node','codex','default','launched','/synthetic/repo',?)`).run(now);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(f.item.id);
  const dispatch = new AgentSessionStore(f.store.database);
  const dispatchId = dispatch.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: f.identity.sessionRef });
  const before = dispatch.getForAccount("owner", dispatchId);
  f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, autoConnect: true }, f.item.key);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true)).toEqual([]);
  const otherAgent = f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, agentKind: "opencode", autoConnect: true }, f.item.key);
  db.prepare("UPDATE nodes SET agents_json='[{\"kind\":\"codex\"},{\"kind\":\"opencode\"}]' WHERE id='node'").run();
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true).map((offer) => offer.id)).toEqual([otherAgent]);
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('other-node','owner','other-installation','Other node','other-synthetic','[{"kind":"codex"}]',?,?,?)`).run(now, now, now);
  expect(f.native.listForNode("owner", "other-node", "worker-two", () => {}, true).map((offer) => offer.id)).toEqual([f.id]);
  expect(f.native.listForNode("other-owner", "node", "worker-one", () => {}, true)).toEqual([]);
  expect(f.native.listForNode("owner", "other-node", "worker-two", () => { throw new Error("permission denied"); }, true)).toEqual([]);
  expect(dispatch.getForAccount("owner", dispatchId)).toEqual(before);
});

it.each(["codex", "opencode", "claude_code"] as const)("connects %s by exact native identity without a dispatch or launch", (kind) => {
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

it("rejects tracking IDs, foreign nodes and duplicate native bindings", () => {
  for (const [kind, ref] of [["codex", "tracking"], ["claude_code", "tracking"]] as const) {
    const f = fixture(kind, ref); expect(() => f.native.connect("owner", f.id, "node")).toThrow(/verified Codex, OpenCode or Claude/);
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

it.each(["codex", "opencode", "claude_code"] as const)("automatically binds %s only after the exact source confirms a healthy read", (kind) => {
  const f = fixture(kind);
  f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, autoConnect: true }, f.item.key);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {})).toEqual([]);
  const offers = f.native.listForNode("owner", "node", "worker-one", () => {}, true);
  expect(offers).toMatchObject([{ id: f.id, externalAutoConnect: true, externalBindingGeneration: 0, occupiesExecutionSlot: false }]);
  expect(offers[0]).not.toHaveProperty("command");
  expect(f.native.overlay("owner", f.id)).toMatchObject({ nativeConnection: { state: "pending", automatic: true }, replyable: false });
  const probe = { generation: 0, autoConnect: true, nativeSessionRef: f.identity.sessionRef };
  f.report({ ...probe, status: "unavailable", error: "not this node", messages: [] });
  expect(f.native.overlay("owner", f.id).nativeConnection?.nodeId).toBeUndefined();
  expect(() => f.report({ ...probe, nativeSessionRef: "different-thread" })).toThrow(/not found/);
  f.report(probe); f.report(probe); // Lost response is retry-safe.
  expect(f.native.overlay("owner", f.id)).toMatchObject({ nativeConnection: { state: "connected", nodeId: "node" }, replyable: true });
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true)[0]).toMatchObject({ externalBindingGeneration: 1 });
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true)[0]).not.toHaveProperty("externalAutoConnect");
  const command = f.native.enqueue("owner", f.id, "Continue in the original conversation");
  expect(command.status).toBe("queued");
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toMatchObject({ count: 0 });
});

it("rechecks execute permission for probes and keeps manual disconnect final across registration retries", () => {
  const f = fixture();
  f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, autoConnect: true }, f.item.key);
  const denied = (_id: string, execute: boolean) => { if (execute) throw new Error("AI permission revoked"); };
  expect(f.native.listForNode("owner", "node", "worker-one", denied, true)).toEqual([]);
  const probe = { generation: 0, autoConnect: true, nativeSessionRef: f.identity.sessionRef };
  expect(() => f.report(probe, denied)).toThrow(/revoked/);
  expect(f.native.overlay("owner", f.id).nativeConnection?.nodeId).toBeUndefined();
  f.report(probe);
  f.native.disconnect("owner", f.id);
  f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, autoConnect: true }, f.item.key);
  expect(f.native.listForNode("owner", "node", "worker-one", () => {}, true)).toEqual([]);
  expect(() => f.report(probe)).toThrow(/not found/);
  expect(f.native.overlay("owner", f.id).nativeConnection?.state).toBe("disconnected");
});

it("lets only one account-owned enabled node win automatic connection and rejects later probes", () => {
  const f = fixture();
  f.progress.register({ accountId: "owner", clientId: "client" }, { ...f.identity, autoConnect: true }, f.item.key);
  const now = new Date().toISOString();
  f.store.database.connection.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('other-node','owner','other-installation','Other node','other-synthetic','[{"kind":"codex"}]',?,?,?)`).run(now, now, now);
  const probe = { generation: 0, autoConnect: true, nativeSessionRef: f.identity.sessionRef };
  f.report(probe);
  expect(() => f.report({ ...probe, nodeId: "other-node" })).toThrow(/not found/);
  expect(f.native.listForNode("owner", "other-node", "another-worker", () => {}, true)).toEqual([]);
  expect(f.native.listForNode("other-account", "node", "worker-one", () => {}, true)).toEqual([]);
  expect(f.native.overlay("owner", f.id).nativeConnection?.nodeId).toBe("node");
});
