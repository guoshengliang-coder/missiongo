import { scryptSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const evidence = "以上方案等待你批准，批准后开始实施。";

async function fixture(external = false) {
  const provider = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    canApprove: true, reason: "方案明确且没有待答问题", evidence,
  }) } }] })));
  const salt = Buffer.from("synthetic-salt-for-tests");
  const app = buildApp({ aiProviderFetch: provider as typeof fetch, adminAccount: {
    id: "owner", username: "owner@example.test", sessionSecret: "synthetic-session-secret-for-testing", cookieSecure: false,
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("fixture-password", salt, 64).toString("base64url")}`,
  } });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner@example.test", password: "fixture-password" } });
  expect(login.statusCode, login.body).toBe(200);
  const headers = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]! };
  expect((await app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers, payload: { apiKey: "synthetic-api-key" } })).statusCode).toBe(200);
  const store = app.missionGoStore;
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const item = store.createWorkItem({ productId: product.id, title: "Shortcut", description: "", type: "requirement", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  const now = new Date().toISOString();
  const db = store.database.connection;
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?,?)`).run(now, now, now);
  const dispatch = new AgentSessionStore(store.database);
  const messages = [{ sourceId: "plan", role: "agent" as const, text: "方案：增加快捷按钮并测试。\n" + evidence, occurredAt: now }];
  let id: string;
  if (external) {
    const progress = new ExternalAgentSessionStore(store);
    id = progress.register({ accountId: "owner", clientId: "fixture" }, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, item.key);
    db.prepare("UPDATE external_agent_sessions SET native_node_id='node',native_generation=1,native_synced_at=?,native_snapshot_json=? WHERE id=?")
      .run(now, JSON.stringify({ status: "idle", turnState: {} }), id);
    messages.forEach((message, position) => db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)")
      .run("native-plan", id, message.sourceId, JSON.stringify(message), position));
  } else {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('dispatch','owner','node','codex','plan','launched','synthetic-repo',?)`).run(now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
    id = dispatch.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "thread" });
    dispatch.recordSnapshot({ nodeId: "node", sessionId: id, status: "idle", messages });
  }
  const get = () => app.inject({ method: "GET", url: `/api/v1/agent-sessions/${id}`, headers });
  const offer = async () => {
    await get();
    for (let i = 0; i < 20; i++) {
      const result = (await get()).json();
      if (result.planApproval) return result.planApproval as { revision: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("No approval offer");
  };
  const approve = (revision: string) => app.inject({ method: "POST", url: `/api/v1/agent-sessions/${id}/plan-approval`, headers, payload: { revision, text: "must be ignored" } });
  return { app, headers, store, db, product, dispatch, id, get, offer, approve, provider, messages };
}

it.each([false, true])("queues exactly one fixed reply on the existing channel (external=%s)", async (external) => {
  const f = await fixture(external);
  const { revision } = await f.offer();
  const sent = await f.approve(revision);
  expect(sent.statusCode, sent.body).toBe(201);
  expect(sent.json()).toMatchObject({ text: "批准", status: "queued", kind: "message" });
  expect(sent.json()).not.toHaveProperty("attachments");
  expect((await f.approve(revision)).statusCode).toBe(409);
  expect((await f.get()).json()).not.toHaveProperty("planApproval");
  const table = external ? "external_native_commands" : "agent_session_commands";
  expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`).get(f.id)).toMatchObject({ n: 1 });
  if (external) expect(new ExternalNativeSessionStore(f.store).overlay("owner", f.id).command?.text).toBe("批准");
});

it("rejects stale content and rechecks AI settings and the caller's current permissions", async () => {
  const f = await fixture();
  const { revision } = await f.offer();
  f.dispatch.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "idle", messages: [{ ...f.messages[0]!, text: "范围还需要选择 A 或 B" }] });
  expect((await f.approve(revision)).statusCode).toBe(409);
  expect((await f.app.inject({ method: "POST", url: `/api/v1/agent-sessions/${f.id}/plan-approval`, payload: { revision } })).statusCode).toBe(401);
  // Reset and classify the current content before disabling AI.
  f.dispatch.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "idle", messages: f.messages });
  const current = await f.offer();
  await f.app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers: f.headers, payload: { agentAttentionEnabled: false } });
  expect((await f.approve(current.revision)).statusCode).toBe(409);
  expect((await f.get()).json()).not.toHaveProperty("planApproval");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({ n: 0 });

  await f.app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers: f.headers, payload: { agentAttentionEnabled: true } });
  const restored = await f.offer();
  // Still inside the normal session's 30-minute stale threshold: the shortcut requires an online node.
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date(Date.now() - 10 * 60_000).toISOString());
  expect((await f.approve(restored.revision)).statusCode).toBe(409);
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date().toISOString());
  const online = await f.offer();
  const other = f.store.createProduct({ name: "Other", keyPrefix: "OTHER" });
  f.app.missionGoAccounts.replacePermissions("owner", [{ productId: other.id, canView: true, canOperate: true, canUseAi: true }]);
  expect((await f.approve(online.revision)).statusCode).toBe(403);
  expect((await f.get()).json()).not.toHaveProperty("planApproval");
});
