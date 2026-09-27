import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ManagedDecision } from "@missiongo/domain";
import { buildApp } from "./app.js";
import { hashPassword, createAiAccessToken } from "./admin-auth.js";
import { ManagedRunStore } from "./managed-run-store.js";

let app: FastifyInstance;
let cookie: string;
let runId: string;
let productId: string;
let proposal: Record<string, unknown>;
const password = randomBytes(24).toString("hex");
const operator = randomBytes(24).toString("hex");
const origin = "https://decision.test";
const config = { id: "decision-owner", username: "owner@example.com", passwordScrypt: hashPassword(password),
  sessionSecret: randomBytes(32).toString("hex"), cookieSecure: true };
const content = { title: "Decision title", recommendation: "Local implementation", alternatives: ["Defer: no delivery"],
  costs: "Local resources only", acceptanceCriteria: ["Tests pass"], allowedActions: ["implement", "review", "verify"] };
const guard = (d: ManagedDecision, key: string) => ({ version: d.version, stateVersion: d.stateVersion, contentDigest: d.contentDigest,
  scopeDigest: d.scopeDigest, contractRevision: d.scope.contractRevision, idempotencyKey: key });
const headers = () => ({ cookie, origin });
const create = () => app.inject({ method: "POST", url: `/api/v1/managed-runs/${runId}/decisions`, headers: headers(), payload: proposal });
beforeEach(async () => {
  app = buildApp({ adminAccount: config, adminToken: operator, publicOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.username, password } });
  expect(login.statusCode).toBe(200);
  cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;
  const product = await app.inject({ method: "POST", url: "/api/v1/products", headers: headers(), payload: { name: "Approval test", keyPrefix: "APP" } });
  productId = product.json().id;
  const item = await app.inject({ method: "POST", url: "/api/v1/items", headers: headers(),
    payload: { productId, type: "task", priority: "normal", title: "Task", description: "Contract" } });
  expect(item.statusCode).toBe(201);
  const run = new ManagedRunStore(app.missionGoStore.database).createRun({ accountId: config.id, productIds: [productId] }, {
    scope: { productId, repositoryRef: "repo", itemKeys: [item.json().key], contractRevision: 1 }, idempotencyKey: "run" });
  runId = run.id;
  proposal = { decisionKey: "implement", content, scopeDigest: run.scopeDigest, contractRevision: 1, idempotencyKey: "create" };
});
afterEach(async () => { await app.close(); });

it("replays a committed HTTP revision and rejects stale receipts after approval", async () => {
  const d = (await create()).json() as ManagedDecision;
  const payload = { ...guard(d, "revise-repeat"), content: { ...content, costs: "Changed costs" } };
  const request = { method: "POST" as const, url: `/api/v1/managed-decisions/${d.id}/revise`, headers: headers(), payload };
  const first = await app.inject(request);
  expect(first.statusCode).toBe(200);
  expect((await app.inject(request)).json()).toEqual(first.json());
  const mismatch = await app.inject({ ...request, payload: { ...payload, content: { ...content, costs: "Other costs" } } });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().code).toBe("idempotency_conflict");
  const approved = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`, headers: headers(), payload: guard(first.json(), "approve-revised") });
  expect(approved.statusCode).toBe(200);
  const stale = await app.inject(request);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("decision_changed");
  expect(app.missionGoStore.database.connection.prepare("SELECT count(*) AS n FROM decision_events").get()).toMatchObject({ n: 3 });
});

it("serves a human-owned decision and records explicit approval/revocation with no dispatch", async () => {
  const proposed = await create();
  expect(proposed.statusCode).toBe(201);
  const d = proposed.json<ManagedDecision>();
  const read = await app.inject({ url: `/api/v1/managed-decisions/${d.id}`, headers: headers() });
  expect(read.statusCode).toBe(200);
  expect(read.headers["cache-control"]).toBe("no-store");
  expect(read.json()).toMatchObject({ decision: d, access: { canApprove: true, canRevoke: true }, productName: "Approval test" });
  const approved = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`, headers: headers(), payload: guard(d, "approve") });
  expect(approved.statusCode).toBe(200);
  expect(approved.json()).toMatchObject({ status: "approved", approval: { accountId: config.id } });
  const revoked = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/revoke`, headers: headers(), payload: guard(approved.json(), "revoke") });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json().status).toBe("revoked");
  expect(app.missionGoStore.database.connection.prepare("SELECT * FROM managed_attempts").all()).toEqual([]);
  expect(app.missionGoStore.database.connection.prepare("SELECT * FROM dispatches").all()).toEqual([]);
});

it("enforces current member permissions, owner binding and account suspension on every replay", async () => {
  const member = (await app.inject({ method: "POST", url: "/api/v1/accounts", headers: headers(),
    payload: { email: "member@example.com", password, role: "member" } })).json<{ id: string }>();
  const grant = async (canView: boolean, canOperate: boolean, canUseAi: boolean) => {
    const r = await app.inject({ method: "PUT", url: `/api/v1/accounts/${member.id}/products`, headers: headers(),
      payload: { permissions: [{ productId, canView, canOperate, canUseAi }] } });
    expect(r.statusCode).toBe(200);
  };
  await grant(true, true, true);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "member@example.com", password } });
  const memberHeaders = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]!, origin };
  const runStore = new ManagedRunStore(app.missionGoStore.database);
  const parent = runStore.getRun({ accountId: config.id, productIds: [productId] }, runId);
  const run = runStore.createRun({ accountId: member.id, productIds: [productId] }, { scope: parent.scope, idempotencyKey: "member-run" });
  const made = await app.inject({ method: "POST", url: `/api/v1/managed-runs/${run.id}/decisions`, headers: memberHeaders, payload: { ...proposal, scopeDigest: run.scopeDigest } });
  expect(made.statusCode).toBe(201);
  const d = made.json<ManagedDecision>();
  const url = `/api/v1/managed-decisions/${d.id}`;
  expect((await app.inject({ url, headers: headers() })).statusCode).toBe(404);
  await grant(true, true, false);
  expect((await app.inject({ url, headers: memberHeaders })).json().access.canApprove).toBe(false);
  for (const h of [memberHeaders, { ...memberHeaders, authorization: `Bearer ${operator}` }]) {
    expect((await app.inject({ method: "POST", url: `${url}/approve`, headers: h, payload: guard(d, "approve") })).statusCode).toBe(403);
  }
  await grant(true, true, true);
  const approved = await app.inject({ method: "POST", url: `${url}/approve`, headers: memberHeaders, payload: guard(d, "approve") });
  expect(approved.statusCode).toBe(200);
  await grant(true, false, false);
  expect((await app.inject({ method: "POST", url: `${url}/approve`, headers: memberHeaders, payload: guard(d, "approve") })).statusCode).toBe(403);
  await grant(false, false, false);
  expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `${url}/approve`, headers: memberHeaders, payload: guard(d, "approve") })).statusCode).toBe(404);
  await grant(true, true, false);
  // Losing AI access must not stop a human with operate permission withdrawing an approval.
  const revoked = await app.inject({ method: "POST", url: `${url}/revoke`, headers: memberHeaders, payload: guard(approved.json(), "revoke") });
  expect(revoked.statusCode).toBe(200);
  await app.inject({ method: "PATCH", url: `/api/v1/accounts/${member.id}`, headers: headers(), payload: { disabled: true } });
  expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: `${url}/revoke`, headers: memberHeaders, payload: guard(approved.json(), "revoke") })).statusCode).toBe(401);
});

it("rejects old login cookies after password rotation and real node credentials", async () => {
  const proposed = await create(); expect(proposed.statusCode).toBe(201);
  const d = proposed.json<ManagedDecision>();
  const account = app.missionGoAccounts.getAccount(config.id);
  const enrollment = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
    app.missionGoAccounts.credentialsStamp(account), "mgc_node_test", ["missiongo:read", "missiongo:node"]).token;
  const registered = await app.inject({ method: "POST", url: "/api/v1/node/register", headers: { authorization: `Bearer ${enrollment}` },
    payload: { installationId: "test-node", name: "Test node", hostname: "test-machine" } });
  expect(registered.statusCode).toBe(201);
  const denied = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`,
    headers: { origin, authorization: `Bearer ${registered.json().token}` }, payload: guard(d, "approve") });
  expect([401, 403]).toContain(denied.statusCode);
  const changed = await app.inject({ method: "POST", url: "/api/v1/auth/password", headers: headers(),
    payload: { currentPassword: password, newPassword: "replacement-fixture-password" } });
  expect(changed.statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`, headers: headers(), payload: guard(d, "approve") })).statusCode).toBe(401);
});

it("fails closed without human authentication or a configured origin", async () => {
  for (const options of [{}, { adminToken: operator }, { adminAccount: config }]) {
    const isolated = buildApp(options);
    try {
      let h: Record<string, string> = { origin };
      if (options.adminAccount) {
        const login = await isolated.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.username, password } });
        h.cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;
      } else if (options.adminToken) h.authorization = `Bearer ${operator}`;
      const r = await isolated.inject({ method: "POST", url: "/api/v1/managed-runs/nonexistent/decisions", headers: h, payload: proposal });
      expect([401, 403]).toContain(r.statusCode);
    } finally { await isolated.close(); }
  }
});

it("does not accept machine bearers, mixed auth, spoofed actors or cross-origin writes", async () => {
  const proposed = await create(); expect(proposed.statusCode).toBe(201);
  const d = proposed.json<ManagedDecision>();
  const account = app.missionGoAccounts.getAccount(config.id);
  const ai = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
    app.missionGoAccounts.credentialsStamp(account), "mgc_test", ["missiongo:read", "missiongo:write"]).token;
  for (const h of [{ origin }, { origin, authorization: `Bearer ${operator}` }, { origin, authorization: `Bearer ${ai}` },
    { ...headers(), authorization: `Bearer ${operator}` }, { cookie }, { cookie, origin: "null" },
    { cookie, origin: "https://other.test" }, { ...headers(), "sec-fetch-site": "cross-site" }]) {
    for (const action of ["approve", "revoke"]) {
      const denied = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/${action}`, headers: h, payload: guard(d, "deny") });
      expect([401, 403]).toContain(denied.statusCode);
    }
  }
  for (const forged of [{ actorKind: "human" }, { approver: config.id }, { accountId: config.id }, { allowedActions: ["merge"] }]) {
    const denied = await app.inject({ method: "POST", url: `/api/v1/managed-decisions/${d.id}/approve`, headers: headers(), payload: { ...guard(d, "forged"), ...forged } });
    expect(denied.statusCode).toBe(400);
  }
  const read = await app.inject({ url: `/api/v1/managed-decisions/${d.id}`, headers: headers() });
  expect(read.json().decision).toEqual(d);
  expect(app.missionGoStore.database.connection.prepare("SELECT * FROM decision_events").all()).toHaveLength(1);
});
