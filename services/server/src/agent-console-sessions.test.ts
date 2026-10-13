import { afterEach, expect, it, vi } from "vitest";

import { AgentConsoleSessions } from "./agent-console-sessions.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const owner = { accountId: "owner", clientId: "client" };

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime("2026-10-13T02:00:00Z");
  const store = new MissionGoStore(":memory:"); stores.push(store);
  const db = store.database.connection;
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "bug", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  const now = new Date().toISOString();
  for (const node of ["node", "other-node"]) db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES (?, 'owner', ?, ?, ?, '[]', ?, ?, ?)`).run(node, node, node, `synthetic-${node}`, now, now, now);
  const dispatch = new AgentSessionStore(store.database);
  const createDispatch = (id: string, ref: string, node = "node") => {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,unread_at)
      VALUES (?, 'owner', ?, 'codex', 'default', 'launched', '/synthetic/repo', ?, ?)`).run(id, node, now, now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(id, item.id);
    return dispatch.createForDispatch({ dispatchId: id, nodeId: node, sessionRef: ref });
  };
  const sessionId = createDispatch("dispatch", "native-thread");
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  const external = new ExternalAgentSessionStore(store);
  const externalId = external.register(owner, { agentKind: "codex", sessionRef: "native-thread", refKind: "native" }, item.key);
  const console = new AgentConsoleSessions(store, dispatch, external);
  return { store, db, item, dispatch, external, console, sessionId, externalId, createDispatch };
}

afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach((store) => store.close()); });

it("unifies historical native mirrors, keeps their records and exposes both IDs", () => {
  const f = fixture();
  f.external.report(owner, f.externalId, f.item.key, "completed", "Local tests passed", "finish");
  expect(f.console.list("owner")).toMatchObject([{ id: f.sessionId, relatedSessionIds: [f.sessionId, f.externalId], unread: true }]);
  expect(f.console.list("owner")).toHaveLength(1);
  const detail = f.console.withMessages("owner", f.sessionId, f.dispatch.getForAccount("owner", f.sessionId));
  expect(detail.messages.map((message) => message.text)).toContain(`${f.item.key} · Local tests passed`);
  expect(detail.replyable).toBe(true);
  expect(f.console.members("owner", f.externalId).map((row) => row.id)).toEqual([f.sessionId, f.externalId]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({ n: 1 });
  expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
});

it("retains different conversations on the same item and unknown legacy tracking", () => {
  const f = fixture();
  const different = f.external.register(owner, { agentKind: "codex", sessionRef: "other-thread", refKind: "native" }, f.item.key);
  const tracking = f.external.register({ ...owner, clientId: "legacy-client" }, { agentKind: "codex", sessionRef: "native-thread", refKind: "tracking" }, f.item.key);
  expect(f.console.list("owner").map((row) => row.id)).toEqual(expect.arrayContaining([f.sessionId, different, tracking]));
  expect(f.console.list("owner")).toHaveLength(3);
});

it("keeps ambiguous IDs on different nodes separate until a node binding proves the association", () => {
  const f = fixture();
  f.createDispatch("second-dispatch", "native-thread", "other-node");
  expect(f.console.list("owner")).toHaveLength(3);
  f.db.prepare("UPDATE external_agent_sessions SET native_node_id='node' WHERE id=?").run(f.externalId);
  expect(f.console.list("owner")).toHaveLength(2);
  expect(f.console.members("owner", f.externalId)[0]!.id).toBe(f.sessionId);
});

it("projects the same native conversation across OAuth clients without sharing write ownership", () => {
  const f = fixture();
  const second = f.external.register({ ...owner, clientId: "second-client" }, { agentKind: "codex", sessionRef: "native-thread", refKind: "native" }, f.item.key);
  expect(f.console.list("owner")).toHaveLength(1);
  expect(f.console.members("owner", second)).toHaveLength(3);
  expect(() => f.external.report(owner, second, f.item.key, "completed", "Spoof", "spoof")).toThrow(/not found/);
  expect(f.console.list("other-owner")).toEqual([]);
  expect(() => f.console.members("other-owner", f.sessionId)).toThrow(/not found/);
});

it("marks every represented record read only through the observed clock", () => {
  const f = fixture();
  const observed = f.console.list("owner")[0]!.unreadAt!;
  f.external.report(owner, f.externalId, f.item.key, "completed", "Later message", "later");
  f.console.markRead("owner", f.sessionId, observed);
  expect(f.console.list("owner")[0]!.unread).toBe(true);
  f.console.markRead("owner", f.externalId, f.console.list("owner")[0]!.unreadAt!);
  expect(f.console.list("owner")[0]!.unread).toBe(false);
  expect(() => f.console.markRead("owner", f.sessionId, "2099-01-01T00:00:00Z")).toThrow(/observed/);
});

it("archives and restores the whole view and routes attention dismissal to its actual record", () => {
  const f = fixture();
  f.external.report(owner, f.externalId, f.item.key, "blocked", "Need help", "question");
  const revision = f.console.list("owner")[0]!.attention.revision!;
  f.console.dismissAttention("owner", f.sessionId, revision);
  expect(f.console.list("owner")[0]!.needsAttention).toBe(false);
  f.external.report(owner, f.externalId, f.item.key, "blocked", "New question", "new-question");
  expect(() => f.console.dismissAttention("owner", f.sessionId, revision)).toThrow(/New progress/);
  f.console.setArchived("owner", f.sessionId, true);
  expect(f.dispatch.getForAccount("owner", f.sessionId).archivedAt).toBeTruthy();
  expect(f.external.getForAccount("owner", f.externalId).archivedAt).toBeTruthy();
  f.console.setArchived("owner", f.externalId, false);
  expect(f.console.list("owner")[0]!.archivedAt).toBeUndefined();
});

it("keeps a historical source archive authoritative in both the list and detail", () => {
  const f = fixture();
  const now = new Date().toISOString();
  f.db.prepare("UPDATE agent_sessions SET archived_at=?,archive_source='source' WHERE id=?").run(now, f.sessionId);
  expect(f.external.getForAccount("owner", f.externalId).archivedAt).toBeUndefined();
  expect(f.console.list("owner")[0]).toMatchObject({ archivedAt: now, archivedSource: "source" });
  expect(f.console.withMessages("owner", f.sessionId, f.dispatch.getForAccount("owner", f.sessionId)))
    .toMatchObject({ archivedAt: now, archivedSource: "source" });
});

it("includes every linked item for boundary authorization instead of losing a hidden product", () => {
  const f = fixture();
  const product = f.store.createProduct({ name: "Other", keyPrefix: "OTHER" });
  const item = f.store.createWorkItem({ productId: product.id, title: "Restricted", description: "", type: "task", priority: "normal" });
  f.store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  f.store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "second-claim" });
  f.external.register(owner, { agentKind: "codex", sessionRef: "native-thread", refKind: "native" }, item.key);
  expect(f.console.list("owner")[0]!.items.map((item) => item.key)).toEqual([f.item.key, item.key]);
});
