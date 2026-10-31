import { afterEach, expect, it } from "vitest";
import { autoArchiveForItem } from "./auto-archive.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const owner = { accountId: "owner", clientId: "client" };
function fixture() {
  const store = new MissionGoStore(":memory:"); stores.push(store);
  const db = store.database.connection;
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const create = () => {
    const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "task", priority: "normal" });
    store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
    store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: `claim:${item.key}` });
    return item;
  };
  const finish = (key: string) => {
    store.transitionWorkItem({ itemKey: key, to: "development_complete", reason: "resolution_submitted", actor: "human" });
    store.transitionWorkItem({ itemKey: key, to: "pending_verification", reason: "release_verified", actor: "human" });
    store.transitionWorkItem({ itemKey: key, to: "done", reason: "verification_passed", actor: "human" });
  };
  const item = create();
  const sessions = new ExternalAgentSessionStore(store);
  const id = sessions.register(owner, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, item.key);
  return { store, db, create, finish, item, sessions, id };
}
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it("archives only after the last linked item is accepted and preserves progress and unread clocks", () => {
  const f = fixture(); const second = f.create();
  f.sessions.register(owner, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, second.key);
  f.sessions.report(owner, f.id, f.item.key, "completed", "Handling ended", "complete");
  const before = f.db.prepare("SELECT activity_at,unread_at,updated_at,progress_status FROM external_agent_sessions WHERE id=?").get(f.id);
  f.finish(f.item.key);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
  f.finish(second.key);
  expect(f.sessions.getForAccount("owner", f.id).archivedSource).toBe("missiongo");
  expect(f.db.prepare("SELECT activity_at,unread_at,updated_at,progress_status FROM external_agent_sessions WHERE id=?").get(f.id)).toEqual(before);
  f.sessions.setArchived("owner", f.id, false);
  autoArchiveForItem(f.store.database, second.id);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
});

it("does not archive empty or cancelled-only conversations, but accepts done plus cancelled", () => {
  const f = fixture();
  f.store.transitionWorkItem({ itemKey: f.item.key, to: "cancelled", reason: "cancelled", actor: "human", note: "No longer needed" });
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
  const second = f.create();
  f.sessions.register(owner, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, second.key);
  f.finish(second.key);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeTruthy();
});

it.each(["queued", "delivering", "delivery_unknown"])("defers while a %s reply is unresolved", (status) => {
  const f = fixture();
  f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES ('reply',?,'Continue',?,?)")
    .run(f.id, status, new Date().toISOString());
  f.finish(f.item.key);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
  const native = new ExternalNativeSessionStore(f.store);
  if (status === "queued") native.cancel("owner", f.id, "reply");
  else {
    f.db.prepare("UPDATE external_native_commands SET status='delivery_unknown' WHERE id='reply'").run();
    native.resolve("owner", f.id, "reply", "not_received");
  }
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeTruthy();
});

it.each(["external", "dispatch"])("waits for all items and %s replies across the merged native conversation", (source) => {
  const f = fixture(); const second = f.create(); const now = new Date().toISOString();
  f.db.prepare(`INSERT INTO nodes(id,account_id,name,token_hash,created_at,updated_at)
    VALUES ('node','owner','Node','synthetic',?,?)`).run(now, now);
  f.db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner','node','codex','plan','launched','/synthetic/repo',?)`).run(now);
  f.db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(second.id);
  const dispatch = new AgentSessionStore(f.store.database);
  const sessionId = dispatch.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "thread" });
  f.finish(f.item.key);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
  expect(dispatch.getForAccount("owner", sessionId).archivedAt).toBeUndefined();
  if (source === "external") f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES ('reply',?,'Continue','queued',?)").run(f.id, now);
  else f.db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES ('reply',?,'owner','message','Continue','queued',?)").run(sessionId, now);
  f.finish(second.key);
  expect(dispatch.getForAccount("owner", sessionId).archivedAt).toBeUndefined();
  if (source === "external") new ExternalNativeSessionStore(f.store).cancel("owner", f.id, "reply");
  else dispatch.cancel("owner", sessionId, "reply");
  expect(dispatch.getForAccount("owner", sessionId).archivedAt).toBeTruthy();
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeTruthy();
  f.sessions.setArchived("owner", f.id, false);
  autoArchiveForItem(f.store.database, second.id);
  expect(f.sessions.getForAccount("owner", f.id).archivedAt).toBeUndefined();
});
