import { randomUUID, scryptSync } from "node:crypto";
import { afterEach, expect, it } from "vitest";

import { createAiAccessToken } from "./admin-auth.js";
import { buildApp } from "./app.js";
import { AgentSessionStore } from "./agent-session-store.js";
import type { AgentApproval } from "./agent-approval-store.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const offered: NonNullable<AgentApproval["options"]> = [
  { id: "accept", kind: "once" },
  { id: "acceptForSession", kind: "session" },
  { id: "acceptAlways", kind: "always" },
  { id: "rule-1", kind: "rule", detail: '"git" "status"' },
  { id: "network-1", kind: "networkAllow", detail: "example.test" },
  { id: "choice-1", kind: "choice", label: "Always allow this app", detail: "Remember Simulator access" },
  { id: "decline", kind: "decline" },
];
const prompt: AgentApproval = {
  id: "permission", kind: "manual", status: "pending", turnId: "turn",
  action: 'cua_repl: Allow Computer Use to use "Simulator"?', startedAtMs: 1,
};

async function fixture() {
  const salt = Buffer.from("synthetic-approval-salt");
  const account = {
    id: "owner", username: "owner@example.test", cookieSecure: false,
    sessionSecret: "synthetic-approval-session-secret",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("fixture-password", salt, 64).toString("base64url")}`,
  };
  const app = buildApp({ adminAccount: account });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login",
    payload: { username: account.username, password: "fixture-password" } });
  expect(login.statusCode, login.body).toBe(200);
  const headers = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]! };
  const credentialsAt = app.missionGoAccounts.credentialsStamp(app.missionGoAccounts.getAccount(account.id));
  const token = createAiAccessToken(account, { id: account.id, username: account.username, role: "admin" },
    credentialsAt, "fixture-node-client", ["missiongo:read", "missiongo:node"]).token;
  const registered = await app.inject({ method: "POST", url: "/api/v1/node/register",
    headers: { authorization: `Bearer ${token}` }, payload: { installationId: randomUUID(), name: "Fixture" } });
  expect(registered.statusCode, registered.body).toBe(201);
  const node = registered.json<{ nodeId: string; token: string }>();
  const nodeHeaders = { authorization: `Bearer ${node.token}` };
  const store = app.missionGoStore;
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const item = store.createWorkItem({ productId: product.id, title: "Approval scopes", description: "",
    type: "bug", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  store.database.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('dispatch','owner',?,'codex','plan','launched','synthetic-repo',?)`).run(node.nodeId, new Date().toISOString());
  store.database.connection.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
  const id = new AgentSessionStore(store.database).createForDispatch({ dispatchId: "dispatch", nodeId: node.nodeId, sessionRef: "thread" });
  const post = (approval: unknown) => app.inject({ method: "POST", url: `/api/v1/node/agent-sessions/${id}/snapshot`,
    headers: nodeHeaders, payload: { status: "active", messages: [], approval } });
  const get = () => app.inject({ method: "GET", url: `/api/v1/agent-sessions/${id}`, headers });
  const decide = (approvalId: string, decision: string) => app.inject({ method: "POST",
    url: `/api/v1/agent-sessions/${id}/approvals/${approvalId}/decision`, headers, payload: { decision } });
  const poll = () => app.inject({ method: "GET", url: "/api/v1/node/agent-sessions", headers: nodeHeaders });
  return { app, headers, id, post, get, decide, poll };
}

it("carries native scopes through the real snapshot, console, decision and node-poll routes", async () => {
  const f = await fixture();
  for (const option of offered) {
    const current = { ...prompt, id: `permission-${option.id}`, options: offered };
    const posted = await f.post(current);
    expect(posted.statusCode, posted.body).toBe(204);
    expect((await f.get()).json()).toMatchObject({ approval: current });
    const list = await f.app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers: f.headers });
    expect(list.json().sessions.find((session: { id: string }) => session.id === f.id).approval.options).toEqual(offered);
    expect((await f.decide(current.id, "unoffered")).statusCode).toBe(400);
    const chosen = await f.decide(current.id, option.id);
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect((await f.poll()).json().sessions.find((session: { id: string }) => session.id === f.id).approvalDecision)
      .toEqual({ id: current.id, choice: option.id });
    expect((await f.post({ ...current, status: "resolved" })).statusCode).toBe(204);
    expect((await f.decide(current.id, option.id)).statusCode).toBe(409);
    expect((await f.poll()).json().sessions[0]).not.toHaveProperty("approvalDecision");
  }
});

it.each([
  { name: "null", options: null },
  { name: "non-array", options: "invalid" },
  { name: "unknown kind", options: [{ id: "bad", kind: "unknown" }] },
  { name: "missing label", options: [{ id: "bad", kind: "choice" }] },
  { name: "duplicate IDs", options: [{ id: "duplicate", kind: "once" }, { id: "duplicate", kind: "always" }] },
  { name: "oversized detail", options: [{ id: "bad", kind: "rule", detail: "x".repeat(4_001) }] },
  { name: "too many options", options: Array.from({ length: 21 }, (_, i) => ({ id: `choice-${i}`, kind: "once" })) },
])("rejects malformed native options at the HTTP boundary ($name)", async ({ options }) => {
  const f = await fixture();
  expect((await f.post({ ...prompt, options })).statusCode).toBe(400);
  expect((await f.get()).json()).not.toHaveProperty("approval");
});

it("repairs an unanswered legacy prompt once, without replacing its advertised options", async () => {
  const f = await fixture();
  expect((await f.post(prompt)).statusCode).toBe(204);
  expect((await f.get()).json().approval).not.toHaveProperty("options");
  expect((await f.decide(prompt.id, "acceptAlways")).statusCode).toBe(400);
  expect((await f.post({ ...prompt, options: offered })).statusCode).toBe(204);
  expect((await f.get()).json().approval.options).toEqual(offered);
  expect((await f.post(prompt)).statusCode).toBe(204);
  expect((await f.post({ ...prompt, options: [] })).statusCode).toBe(204);
  expect((await f.get()).json().approval.options).toEqual(offered);
  expect((await f.decide(prompt.id, "acceptAlways")).statusCode).toBe(200);
  expect((await f.post({ ...prompt, options: offered })).statusCode).toBe(204);
  expect((await f.get()).json().approval.decision).toBe("acceptAlways");
});

it("preserves an already queued legacy choice instead of upgrading its authorization", async () => {
  const f = await fixture();
  await f.post(prompt);
  expect((await f.decide(prompt.id, "accept")).statusCode).toBe(200);
  await f.post({ ...prompt, options: offered });
  const approval = (await f.get()).json().approval;
  expect(approval.decision).toBe("accept");
  expect(approval).not.toHaveProperty("options");
  expect((await f.decide(prompt.id, "acceptAlways")).statusCode).toBe(400);
  expect((await f.poll()).json().sessions[0].approvalDecision).toEqual({ id: prompt.id, choice: "accept" });
});

it.each(["resolved", "reconnecting", "unavailable", "approved", "denied"])(
  "does not restore missing options or revive a legacy %s request", async (status) => {
    const f = await fixture();
    await f.post(prompt);
    await f.post({ ...prompt, status, options: offered });
    await f.post({ ...prompt, options: offered });
    const approval = (await f.get()).json().approval;
    expect(approval.status).toBe(status);
    expect(approval).not.toHaveProperty("options");
    expect((await f.decide(prompt.id, "acceptAlways")).statusCode).toBe(409);
  },
);

it.each([{ action: "Different app" }, { turnId: "different-turn" }, { startedAtMs: 2 }, { kind: "auto", status: "inProgress" }])(
  "rejects changed request identity or scope before repairing missing options (%j)", async (change) => {
    const f = await fixture();
    await f.post(prompt);
    expect((await f.post({ ...prompt, ...change, options: offered })).statusCode).toBe(409);
    expect((await f.get()).json().approval).toEqual(prompt);
    expect((await f.post({ ...prompt, ...change, options: offered })).statusCode).toBe(409);
  },
);

it("keeps an explicitly empty source list empty instead of granting fallback choices", async () => {
  const f = await fixture();
  await f.post({ ...prompt, options: [] });
  await f.post({ ...prompt, options: offered });
  expect((await f.get()).json().approval.options).toEqual([]);
  expect((await f.decide(prompt.id, "accept")).statusCode).toBe(400);
  expect((await f.decide(prompt.id, "acceptAlways")).statusCode).toBe(400);
});
