import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { TEST_CONSOLE_ACCOUNT, testConsoleHeaders } from "./testing-fixtures.js";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const app = buildApp({ adminAccount: TEST_CONSOLE_ACCOUNT }); apps.push(app);
  const headers = await testConsoleHeaders(app), store = app.missionGoStore, db = store.database.connection;
  const accountId = TEST_CONSOLE_ACCOUNT.id, now = new Date().toISOString();
  const product = store.createProduct({ name: "Favorite fixture", keyPrefix: "FAV" });
  const item = store.createWorkItem({ productId: product.id, title: "Favorite fixture", type: "task", priority: "normal", description: "" });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node',?,'favorite-node','Fixture','synthetic','[]',?,?,?)`).run(accountId, now, now, now);
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch',?,'node','codex','default','launched','synthetic',?)`).run(accountId, now);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
  const sessions = new AgentSessionStore(store.database);
  const id = sessions.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "thread" });
  const put = (favorite: unknown, key = id, auth = headers) => app.inject({ method: "PUT", url: `/api/v1/agent-sessions/${key}/favorite`, headers: auth, payload: { favorite } });
  const list = async (auth = headers) => (await app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers: auth })).json().sessions;
  return { app, store, db, headers, sessions, accountId, product, item, id, put, list };
}
it("persists explicit favorite values across signed-in clients and protects account boundaries", async () => {
  const f = await fixture(), secondClient = await testConsoleHeaders(f.app);
  const before = (await f.list())[0];
  expect((await f.put(true)).statusCode).toBe(200);
  expect((await f.put(true)).json()).toMatchObject({ favorite: true });
  expect((await f.list(secondClient))[0]).toMatchObject({ favorite: true, activityAt: before.activityAt, unread: before.unread });
  expect((await f.put("true")).statusCode).toBe(400);
  expect((await f.put(false)).json()).toMatchObject({ favorite: false });
  const other = f.app.missionGoAccounts.createAccount({ email: "other-favorite@example.test", password: "synthetic-password", role: "admin" });
  const login = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: other.email, password: "synthetic-password" } });
  const auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]! };
  expect((await f.put(true, f.id, auth)).statusCode).toBe(404);
  expect(await f.list(auth)).toEqual([]);
});
it("lets a view-only owner favorite archived sessions but rejects revoked product access", async () => {
  const f = await fixture();
  f.app.missionGoAccounts.createAccount({ email: "spare-admin@example.test", password: "synthetic-password", role: "admin" });
  f.app.missionGoAccounts.replacePermissions(f.accountId, [{ productId: f.product.id, canView: true, canOperate: false, canUseAi: false }], "none");
  f.app.missionGoAccounts.updateAccount(f.accountId, { role: "member" });
  f.db.prepare("UPDATE agent_sessions SET archived_at=?,archive_source='source' WHERE id=?").run(new Date().toISOString(), f.id);
  expect((await f.put(true)).statusCode).toBe(200);
  expect((await f.list())[0]).toMatchObject({ favorite: true, canReply: false, archivedSource: "source" });
  f.app.missionGoAccounts.replacePermissions(f.accountId, [], "none");
  expect((await f.put(false)).statusCode).toBe(404);
  expect(await f.list()).toEqual([]);
});
it("keeps favorite metadata when automatic completion archives the whole conversation", async () => {
  const f = await fixture();
  const external = new ExternalAgentSessionStore(f.store);
  const mirror = external.register({ accountId: f.accountId, clientId: "fixture" }, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, f.item.key);
  await f.put(true, mirror);
  const before = (await f.list())[0];
  f.store.transitionWorkItem({ itemKey: f.item.key, to: "development_complete", reason: "resolution_submitted", actor: "human" });
  f.store.transitionWorkItem({ itemKey: f.item.key, to: "pending_verification", reason: "release_verified", actor: "human" });
  f.store.transitionWorkItem({ itemKey: f.item.key, to: "done", reason: "verification_passed", actor: "human" });
  expect((await f.list())[0]).toMatchObject({ favorite: true, archivedAt: expect.any(String), activityAt: before.activityAt });
  expect((await f.put(false, mirror)).json().favorite).toBe(false);
});

it("binds delivery-only classifications to the current message and rejects delayed old verdicts", async () => {
  const f = await fixture();
  const snapshot = (sourceId: string, text: string) => f.sessions.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "idle",
    messages: [{ sourceId, role: "agent", phase: "final_answer", text }] });
  snapshot("delivery-result", "代码与检查已完成，请发起合并。");
  const first = f.sessions.pendingAttention(f.id)!;
  expect(first).toBeDefined();
  expect(f.sessions.completeAttention(f.id, first.messageHash, { needsAttention: true, kind: "instruction", reason: "等待发起合并", model: "synthetic", deliveryOnly: true })).toBe(true);
  expect(f.sessions.listForAccount(f.accountId)[0]!.attention.deliveryOnly).toBe(true);
  snapshot("independent-request", "请决定另一项独立安排。");
  const next = f.sessions.pendingAttention(f.id)!;
  expect(next.messageHash).not.toBe(first.messageHash);
  expect(f.sessions.listForAccount(f.accountId)[0]!.attention.deliveryOnly).toBeUndefined();
  expect(f.sessions.completeAttention(f.id, first.messageHash, { needsAttention: true, kind: "instruction", reason: "旧结果", model: "synthetic", deliveryOnly: true })).toBe(false);
  expect(f.sessions.completeAttention(f.id, next.messageHash, { needsAttention: true, kind: "instruction", reason: "独立安排", model: "synthetic", deliveryOnly: false })).toBe(true);
  expect(f.sessions.listForAccount(f.accountId)[0]).toMatchObject({ needsAttention: true, attention: { reason: "独立安排" } });
  snapshot("long-request", "等待合并" + "x".repeat(21_000));
  expect(f.sessions.pendingAttention(f.id)?.truncated).toBe(true);
});
