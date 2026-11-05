import { afterEach, expect, it, vi } from "vitest";
import { BuilderHandovers } from "./builder-handovers.js";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { itemExecutionBlockers } from "./item-execution-blockers.js";
import { WRITE_TOOLS_BY_TIER } from "./mcp.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });
const config = { id: "external-plan-owner", username: "external-plans@example.test", passwordScrypt: hashPassword("fixture-password"), sessionSecret: "synthetic-external-plan-signing-key", cookieSecure: false };

async function fixture() {
  const app = buildApp({ adminAccount: config, writeTools: "comments", publicOrigin: "https://approval.example.test" });
  apps.push(app);
  const store = app.missionGoStore, accounts = app.missionGoAccounts;
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.username, password: "fixture-password" } });
  const headers = { cookie: login.headers["set-cookie"]!.toString().split(";")[0]! };
  const account = accounts.getAccount(config.id);
  const tokenFor = (client: string, scopes = ["missiongo:read", "missiongo:write"]) => createAiAccessToken(config, { id: account.id, username: account.email, role: account.role }, accounts.credentialsStamp(account), client, scopes).token;
  const token = tokenFor("original-client");
  const product = store.createProduct({ name: "External plan fixture", keyPrefix: "EXT", createdByAccountId: config.id });
  const create = () => store.createWorkItem({ productId: product.id, status: "ready", title: "Unclaimed external work", description: "Current implementation boundary", type: "requirement", priority: "normal", environment: { platform: "shared" } });
  const item = create();
  const rpc = async (method: string, params: Record<string, unknown> = {}, bearer = token) => {
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream", ...(params["_meta"] ? {"mcp-method":method,"mcp-name":String(params.name ?? "")} : {}) }, payload: { jsonrpc: "2.0", id: 1, method, params } });
    const raw = response.headers["content-type"]?.includes("text/event-stream") ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const parsed = JSON.parse(raw);
    return parsed.result ?? {rpcError:parsed.error};
  };
  const call = (name: string, args: Record<string, unknown>, bearer = token) => rpc("tools/call", { name, arguments: args }, bearer);
  const session = { agentKind: "codex", refKind: "native", sessionRef: "original-native-thread", autoConnect: true };
  const proposal = { itemKeys: [item.key], session, plan: "Implement the reviewed behavior in an isolated worktree.", validation: "Verify the external pre-claim approval round trip.", approvalMethod: "web" };
  const request = async (extra: Record<string, unknown> = {}) => {
    const result = await call("request_plan_approval", { ...proposal, ...extra });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent;
  };
  const get = (id: string) => app.inject({ method: "GET", url: `/api/v1/agent-sessions/${id}`, headers });
  const approve = (id: string, revision: string) => app.inject({ method: "POST", url: `/api/v1/agent-sessions/${id}/plan-approval`, headers, payload: { revision } });
  return { app, store, headers, product, item, create, session, proposal, rpc, call, request, get, approve, tokenFor };
}

it("reads, submits, approves offline and claims the same original external conversation without a second approval", async () => {
  const f = await fixture(), db = f.store.database.connection;
  expect((await f.call("get_item_context", { itemKey: f.item.key })).structuredContent.item.status).toBe("ready");
  const requested = await f.request();
  expect(requested).toMatchObject({ approved: false, approvalRequired: true, sessionId: expect.any(String), reviewUrl: expect.stringContaining(`session=${requested.sessionId}`) });
  expect((await f.request()).sessionId).toBe(requested.sessionId);
  expect(db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({ n: 1 });
  expect(db.prepare("SELECT link_kind FROM external_agent_session_items").get()).toMatchObject({ link_kind: "approval" });
  expect(db.prepare("SELECT native_auto_connect FROM external_agent_sessions").get()).toMatchObject({ native_auto_connect: 0 });
  for (const table of ["external_agent_session_reports", "builder_execution_authorizations", "mcp_agent_claim_receipts"]) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
  expect(itemExecutionBlockers(f.store.database, f.item.id)).toEqual([]);
  const comment = await f.call("append_comment", { itemKey:f.item.key,sessionId:requested.sessionId,agentName:"Fixture",bodyKind:"free",summary:"Plan investigation",text:"The reviewed plan is ready.",idempotencyKey:"approval-only-comment" });
  expect(comment.isError,JSON.stringify(comment)).not.toBe(true);
  expect(db.prepare("SELECT COUNT(*) AS n FROM external_agent_session_reports").get()).toMatchObject({n:0});
  const report = await f.call("report_agent_session", { itemKey: f.item.key, sessionId: requested.sessionId, status: "working", idempotencyKey: "not-yet-claimed" });
  expect(report.isError).toBe(true);
  expect((await f.call("register_agent_session", { itemKey: f.item.key, session: f.session })).isError).toBe(true);
  const listed = (await f.app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers: f.headers })).json();
  expect(listed.sessions).toEqual([expect.objectContaining({ agentSessionId: requested.sessionId, approvalOnly: true, needsAttention: true, canReply: false })]);
  const detail = (await f.get(requested.sessionId)).json();
  expect(detail).toMatchObject({ approvalOnly: true, canReply: false, canApprovePlan: true, planApprovalStatus: { code: "ready" }, planApproval: { revision: requested.revision, plan: f.proposal.plan } });
  expect(detail.implementationPlan).toMatchObject({ plan: f.proposal.plan, validation: f.proposal.validation, approved: false, valid: true });
  expect((await f.approve(requested.sessionId, requested.revision)).json()).toEqual({ approved: true, revision: requested.revision, continuationQueued: false });
  expect((await f.get(requested.sessionId)).json()).toMatchObject({ canReply: false, canApprovePlan: false, planApprovalState: { approved: true, continuationQueued: false } });
  expect((await f.get(requested.sessionId)).json().implementationPlan).toMatchObject({
    revision: requested.revision, plan: f.proposal.plan, validation: f.proposal.validation, approved: true, valid: true });
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  expect(itemExecutionBlockers(f.store.database, f.item.id)).toEqual([]);
  expect((await f.approve(requested.sessionId, requested.revision)).statusCode).toBe(409);
  expect(await f.request({ approvalMethod: "native" })).toMatchObject({ approved: true, revision: requested.revision, sessionId: requested.sessionId });
  const claim = await f.call("claim_item", { itemKey: f.item.key, agentId: "Fixture", session: f.session, idempotencyKey: "approved-original-claim" });
  expect(claim.isError, JSON.stringify(claim)).not.toBe(true);
  expect(claim.structuredContent).toMatchObject({ sessionId: requested.sessionId, item: { status: "in_progress" }, executionAuthorization: expect.any(String) });
  expect(db.prepare("SELECT link_kind FROM external_agent_session_items").get()).toMatchObject({ link_kind: "handling" });
  expect((await f.get(requested.sessionId)).json().approvalOnly).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM external_agent_session_reports").get()).toMatchObject({ n: 1 });
  expect(db.prepare("SELECT source FROM implementation_plan_approvals").get()).toMatchObject({ source: "web" });
});

it("returns a usable same-session handoff when native confirmation is unavailable, then recognizes its saved Web approval", async () => {
  const f = await fixture();
  const native = await f.request({ approvalMethod: "native" });
  expect(native).toMatchObject({ approved: false, requiresWeb: true, code: "native_approval_unavailable", reviewUrl: expect.stringContaining("session="), sessionId: expect.any(String) });
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
  expect((await f.approve(native.sessionId, native.revision)).statusCode).toBe(201);
  expect(await f.request({ approvalMethod: "native" })).toMatchObject({ approved: true, revision: native.revision, sessionId: native.sessionId });
});

it("invalidates old revisions and frozen content, and rejects forged native approval or another OAuth client's claim", async () => {
  const f = await fixture();
  const first = await f.request({ approved: true });
  expect(first.approved).toBe(false);
  const second = await f.request({ plan: "Revised exact implementation boundary." });
  expect(second.sessionId).toBe(first.sessionId);
  expect((await f.approve(first.sessionId, first.revision)).statusCode).toBe(409);
  expect((await f.approve(second.sessionId, second.revision)).statusCode).toBe(201);
  expect((await f.call("claim_item", { itemKey: f.item.key, agentId: "Fixture", session: f.session, idempotencyKey: "other-client" }, f.tokenFor("other-client"))).isError).toBe(true);
  f.store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  expect((await f.call("claim_item", { itemKey: f.item.key, agentId: "Fixture", session: f.session, idempotencyKey: "stale-claim" })).isError).toBe(true);
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  expect(itemExecutionBlockers(f.store.database, f.item.id)).toEqual([]);
});

it("rechecks permissions at approval and keeps a revised batch on one original conversation", async () => {
  const f = await fixture(), second = f.create();
  const requested = await f.request({ itemKeys: [f.item.key, second.key] });
  expect(new ImplementationPlans(f.store.database).proposal(config.id, `native:original-client:codex:native:${f.session.sessionRef}`)?.keys).toEqual([f.item.key, second.key].sort());
  f.app.missionGoAccounts.replacePermissions(config.id, [{ productId: f.product.id, canView: true, canOperate: true, canUseAi: false }]);
  expect((await f.get(requested.sessionId)).json()).toMatchObject({ canApprovePlan: false });
  expect((await f.approve(requested.sessionId, requested.revision)).statusCode).toBe(404);
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
});

it("announces exactly the writable tools exposed by a real MCP tools/list response", async () => {
  const f = await fixture();
  const account = (await f.call("get_current_account", {})).structuredContent;
  const tools = (await f.rpc("tools/list")).tools;
  const writable = tools.filter((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint === false).map((tool: { name: string }) => tool.name);
  expect(writable.sort()).toEqual([...account.capabilities.writeTools].sort());
  expect(writable.sort()).toEqual([...WRITE_TOOLS_BY_TIER.comments].sort());
  expect(writable).toContain("request_plan_approval");
  expect((await f.call("get_current_account", {}, f.tokenFor("reader", ["missiongo:read"]))).structuredContent.capabilities.writeTools).toEqual([]);
  expect((await f.call("request_plan_approval", f.proposal, f.tokenFor("reader", ["missiongo:read"]))).isError).toBe(true);
});

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "native-approval-fixture", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

it.each(["accept", "decline", "cancel"])("persists only the signed modern native elicitation result (%s) across HTTP requests", async action => {
  const f = await fixture();
  const params = { name: "request_plan_approval", arguments: { ...f.proposal, approvalMethod: "native" }, _meta: modernMeta };
  const first = await f.rpc("tools/call", params);
  expect(first, JSON.stringify(first)).toMatchObject({ resultType: "input_required", requestState: expect.any(String), inputRequests: { planApproval: expect.any(Object) } });
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
  const result = await f.rpc("tools/call", { ...params, requestState: first.requestState, inputResponses: { planApproval: { action, content: action === "accept" ? {} : null } } });
  expect(result, JSON.stringify(result)).toMatchObject({ structuredContent: { approved: action === "accept" } });
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: action === "accept" ? 1 : 0 });
  if (action === "accept") {
    expect(f.store.database.connection.prepare("SELECT source FROM implementation_plan_approvals").get()).toMatchObject({ source: "native" });
    const repeated = await f.rpc("tools/call", params);
    expect(repeated).toMatchObject({ structuredContent: { approved: true } });
    expect(repeated.inputRequests).toBeUndefined();
    const claimed = await f.call("claim_item", { itemKey: f.item.key, agentId: "Native fixture", session: f.session, idempotencyKey: "native-original-claim" });
    expect(claimed.isError, JSON.stringify(claimed)).not.toBe(true);
  }
});

it("rejects missing, forged, cross-client and changed-plan native response state without saving an approval", async () => {
  const f = await fixture();
  const params = { name: "request_plan_approval", arguments: { ...f.proposal, approvalMethod: "native" }, _meta: modernMeta };
  const first = await f.rpc("tools/call", params);
  const answer = { planApproval: { action: "accept", content: {} } };
  const missing = await f.rpc("tools/call", { ...params, inputResponses: answer });
  expect(missing.isError).toBe(true);
  const forged = await f.rpc("tools/call", { ...params, requestState: `${first.requestState}forged`, inputResponses: answer });
  expect(forged.rpcError).toBeDefined();
  const other = await f.rpc("tools/call", { ...params, requestState: first.requestState, inputResponses: answer }, f.tokenFor("other-client"));
  expect(other.rpcError).toBeDefined();
  const changed = await f.rpc("tools/call", { ...params, arguments: { ...params.arguments, plan: "Another plan" }, requestState: first.requestState, inputResponses: answer });
  expect(changed.isError).toBe(true);
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
});

it("does not let an older native answer supersede a newer pending proposal", async () => {
  const f = await fixture();
  const params = { name: "request_plan_approval", arguments: { ...f.proposal, approvalMethod: "native" }, _meta: modernMeta };
  const first = await f.rpc("tools/call", params);
  const current = await f.request({ plan: "A newer proposal awaiting its own human decision." });
  const stale = await f.rpc("tools/call", { ...params, requestState: first.requestState, inputResponses: { planApproval: { action: "accept", content: {} } } });
  expect(stale.isError).toBe(true);
  expect((await f.get(current.sessionId)).json()).toMatchObject({ planApproval: { revision: current.revision } });
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
});

it("does not stop or revoke the session's other handling work when only an approval link changes Builder", async () => {
  const f = await fixture(), db = f.store.database.connection;
  const requested = await f.request();
  const handling = f.create();
  f.store.claimWorkItem({ itemKey: handling.key, agentId: "Fixture", idempotencyKey: "existing-handling" });
  const { ExternalAgentSessionStore } = await import("./external-agent-session-store.js");
  new ExternalAgentSessionStore(f.store).register({ accountId: config.id, clientId: "original-client" }, { ...f.session, agentKind: "codex", refKind: "native", autoConnect: false }, handling.key);
  db.prepare("UPDATE work_items SET builder_account_id=? WHERE id=?").run(config.id, f.item.id);
  new BuilderHandovers(f.store).start(f.item.key, config.id, null, config.id, "Transfer only the unclaimed approval scope.");
  expect(db.prepare("SELECT status FROM builder_handovers WHERE item_id=?").get(f.item.id)).toMatchObject({ status: "completed" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM builder_revoked_external_sessions WHERE session_id=?").get(requested.sessionId)).toMatchObject({ n: 0 });
  expect((await f.approve(requested.sessionId, requested.revision)).statusCode).toBe(409);
});

it("can dismiss a pending approval and shows a later revision again on the same session", async () => {
  const f = await fixture();
  const requested = await f.request();
  const dismiss = await f.app.inject({ method: "POST", url: `/api/v1/agent-sessions/${requested.sessionId}/attention/dismiss`, headers: f.headers, payload: { revision: requested.revision } });
  expect(dismiss.statusCode, dismiss.body).toBe(200);
  const current = await f.request({ plan: "A revised plan requiring its own review." });
  expect(current.sessionId).toBe(requested.sessionId);
  const listed = (await f.app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers: f.headers })).json();
  expect(listed.sessions[0]).toMatchObject({ needsAttention: true, attention: { revision: current.revision } });
});

it("rejects an expired signed native response and leaves the unclaimed item unchanged", async () => {
  const f = await fixture();
  const params = { name: "request_plan_approval", arguments: { ...f.proposal, approvalMethod: "native" }, _meta: modernMeta };
  const first = await f.rpc("tools/call", params);
  const now = Date.now();
  vi.spyOn(Date,"now").mockReturnValue(now + 3601_000);
  const expired = await f.rpc("tools/call", { ...params, requestState: first.requestState, inputResponses: { planApproval: { action: "accept", content: {} } } });
  expect(expired.rpcError, JSON.stringify(expired)).toMatchObject({ message: expect.stringContaining("requestState") });
  expect(f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({ n: 0 });
  expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
});
