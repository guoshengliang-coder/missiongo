import { approvedClaimFixture } from "./testing-fixtures.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { BuilderHandovers } from "./builder-handovers.js";
import { DispatchStore } from "./dispatch-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { assertExecutionAuthorization } from "./builder-authority.js";
import type { TransitionWorkItemInput } from "./types.js";

const config = { id: "recovery-admin", username: "admin@example.test", passwordScrypt: hashPassword("synthetic recovery password"),
  sessionSecret: "synthetic-execution-recovery-secret", cookieSecure: false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture() {
  const app = buildApp({ databasePath: ":memory:", adminAccount: config, writeTools: "comments", statusCheckTime: false });
  apps.push(app);
  const store = app.missionGoStore, accounts = app.missionGoAccounts, db = store.database.connection;
  const owner = accounts.createAccount({ email: "owner@example.test", password: "synthetic recovery password", role: "member" });
  const other = accounts.createAccount({ email: "other@example.test", password: "synthetic recovery password", role: "member" });
  const product = store.createProduct({ name: "Recovery", keyPrefix: "REC", createdByAccountId: config.id });
  const grant = (canOperate = true, canUseAi = true) => accounts.replacePermissions(owner.id,
    [{ productId: product.id, canView: true, canOperate, canUseAi }]);
  grant();
  accounts.replacePermissions(other.id, [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }]);
  const item = store.createWorkItem({ productId: product.id, title: "Continue this work", description: "Retain original execution",
    type: "task", priority: "normal", status: "ready", environment: { platform: "shared" } });
  const identity = { agentKind: "codex" as const, refKind: "native" as const, sessionRef: randomUUID() };
  const call = async (name: string, args: Record<string, unknown>, options: { accountId?: string; clientId?: string; scopes?: string[] } = {}) => {
    const account = accounts.getAccount(options.accountId ?? owner.id);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), options.clientId ?? "original-client", options.scopes ?? ["missiongo:read", "missiongo:write"]).token;
    // Deliberately no credential cache: this is a fresh client call after context loss.
    if(name==="claim_item") approvedClaimFixture(store,token,args);
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const payload = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const result = JSON.parse(payload);
    return { response, ...result, ...result.result } as {
      response: typeof response; isError?: boolean; error?: unknown;
      structuredContent?: { executionAuthorization?: string; sessionId?: string; dispatchId?: string; statusChanged?: boolean; [key: string]: unknown };
    };
  };
  const claim = async (input: Record<string, unknown> = { session: identity }) => {
    const result = await call("claim_item", { itemKey: item.key, agentId: "Codex", idempotencyKey: randomUUID(), ...input });
    expect(result.isError ?? result.error, JSON.stringify(result)).toBeFalsy();
    return result.structuredContent!;
  };
  const launch = () => {
    const dispatches = new DispatchStore(store.database);
    const node = dispatches.registerNode({ accountId: owner.id, installationId: randomUUID(), name: "Recovery node" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind: "codex",planApprovalProtocol:1, ready: true }]);
    dispatches.replaceOwnRepos(node.nodeId, [{ productId: product.id, repoPath: "/synthetic/recovery" }]);
    const dispatch = dispatches.createDispatch({ accountId: owner.id, nodeId: node.nodeId, agentKind: "codex", mode: "default", itemKeys: [item.key] });
    dispatches.claimNextDispatch(node.nodeId);
    dispatches.recordDispatchResult({ nodeId: node.nodeId, dispatchId: dispatch.id, status: "launched" });
    const sessions = new AgentSessionStore(store.database);
    const sessionId = sessions.createForDispatch({ dispatchId: dispatch.id, nodeId: node.nodeId, sessionRef: identity.sessionRef });
    sessions.recordSnapshot({ nodeId: node.nodeId, sessionId, status: "active", messages: [], turnState: { turnActive: true } });
    return { dispatch, node };
  };
  const snapshot = () => ({
    item: store.getWorkItem(item.key), timeline: store.getTimeline(item.key),
    claims: db.prepare("SELECT * FROM mcp_agent_claim_receipts").all(),
    credentials: db.prepare("SELECT * FROM builder_execution_authorizations").all(),
    sessions: db.prepare("SELECT * FROM external_agent_sessions").all(),
    links: db.prepare("SELECT * FROM dispatch_items").all(),
  });
  const recover = (input: Record<string, unknown>, options?: Parameters<typeof call>[2]) =>
    call("recover_execution_authorization", { itemKey: item.key, ...input }, options);
  return { app, store, accounts, db, owner, other, product, grant, item, identity, call, claim, launch, snapshot, recover };
}

function refused(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["recover"]>>, credential?: string) {
  expect(result.isError || result.error || result.response.statusCode >= 400, JSON.stringify(result)).toBeTruthy();
  expect(result.structuredContent?.executionAuthorization).toBeUndefined();
  if (credential) expect(JSON.stringify(result)).not.toContain(credential);
}

describe("AND-397 execution authorization recovery", () => {
  it.each(["dispatchId", "dispatch-native", "external-native", "external-id", "legacy-id", "tracking"] as const)(
    "recovers the original %s claim without mutating its historic receipt, card, round or sessions", async kind => {
      const f = await fixture();
      const dispatch = kind.startsWith("dispatch") ? f.launch().dispatch : undefined;
      const identity = kind === "tracking" ? { ...f.identity, refKind: "tracking" as const } : f.identity;
      const original = await f.claim(dispatch ? { dispatchId: dispatch.id } : kind === "legacy-id" ? {} : { session: identity });
      const before = f.snapshot();
      const input = kind === "dispatchId" ? { dispatchId: dispatch!.id }
        : kind === "external-id" || kind === "legacy-id" ? { sessionId: original.sessionId } : { session: identity };
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovered = await f.recover(input);
        expect(recovered.isError ?? recovered.error, JSON.stringify(recovered)).toBeFalsy();
        expect(recovered.structuredContent).toMatchObject({ itemKey: f.item.key,
          executionAuthorization: original.executionAuthorization, statusChanged: false });
        expect(f.snapshot()).toEqual(before);
      }
      // A real status call must work with the recovered credential.
      const recovered = await f.recover(input);
      const completed = await f.call("submit_development_complete", {
        itemKey: f.item.key, executionAuthorization: recovered.structuredContent!.executionAuthorization,
        completion: { kind: "commit", commit: "a".repeat(40), targetBranch: "main" },
        requiredArtifacts: [], noReleaseReason: "Synthetic recovery regression", idempotencyKey: randomUUID(),
      });
      expect(completed.isError ?? completed.error, JSON.stringify(completed)).toBeFalsy();
      expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    });

  it.each(["wrong-account", "wrong-client", "read-only", "operation-revoked", "ai-revoked", "product-scope"] as const)(
    "does not disclose credentials with %s", async condition => {
      const f = await fixture(), original = await f.claim();
      if (condition === "operation-revoked") f.grant(false, true);
      if (condition === "ai-revoked") f.grant(true, false);
      if (condition === "product-scope") f.accounts.replacePermissions(f.owner.id, [], "none");
      const before = f.snapshot();
      const result = await f.recover({ sessionId: original.sessionId }, {
        ...(condition === "wrong-account" ? { accountId: f.other.id } : {}),
        ...(condition === "wrong-client" ? { clientId: "other-client" } : {}),
        ...(condition === "read-only" ? { scopes: ["missiongo:read"] } : {}),
      });
      refused(result, original.executionAuthorization);
      expect(f.snapshot()).toEqual(before);
    });

  it("cannot turn a later registration on the same item into the original claimant", async () => {
    const f = await fixture(), original = await f.claim();
    const identity = { ...f.identity, sessionRef: randomUUID() };
    const registration = await f.call("register_agent_session", { itemKey: f.item.key, session: identity });
    const before = f.snapshot();
    refused(await f.recover({ session: identity }), original.executionAuthorization);
    refused(await f.recover({ sessionId: registration.structuredContent!.sessionId }), original.executionAuthorization);
    refused(await f.recover({ session: { ...f.identity, refKind: "tracking" } }), original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(["missing", "multiple"] as const)("requires exactly one identity (%s)", async kind => {
    const f = await fixture(), original = await f.claim();
    refused(await f.recover(kind === "missing" ? {} : { session: f.identity, sessionId: original.sessionId }),
      original.executionAuthorization);
  });

  it.each(["receipt-missing", "receipt-mismatch", "ambiguous-credential", "old-round", "revoked"] as const)(
    "refuses unverifiable %s evidence without minting a new credential", async condition => {
      const f = await fixture(), original = await f.claim();
      if (condition === "receipt-missing") f.db.prepare("DELETE FROM mcp_agent_claim_receipts").run();
      if (condition === "receipt-mismatch") f.db.prepare("UPDATE mcp_agent_claim_receipts SET result_json=json_set(result_json,'$.item.id',?)").run(randomUUID());
      if (condition === "old-round") f.db.prepare("UPDATE builder_execution_authorizations SET round_key=?").run(randomUUID());
      if (condition === "revoked") f.db.prepare("UPDATE builder_execution_authorizations SET revoked=1").run();
      if (condition === "ambiguous-credential") {
        const id = randomUUID();
        f.db.prepare(`INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,dispatch_id,created_at,round_key)
          SELECT ?,item_id,account_id,client_id,dispatch_id,created_at,round_key FROM builder_execution_authorizations`).run(id);
        f.db.prepare(`INSERT INTO mcp_agent_claim_receipts(account_id,client_id,idempotency_key,digest,result_json)
          SELECT account_id,client_id,'ambiguous-claim',digest,json_set(result_json,'$.executionAuthorization',?) FROM mcp_agent_claim_receipts`).run(id);
      }
      const before = f.snapshot();
      const result = await f.recover({ session: f.identity });
      refused(result, original.executionAuthorization);
      expect(result.structuredContent).toMatchObject({code:"execution_authorization_not_recoverable",statusChanged:false,
        reason:condition==="ambiguous-credential" ? "identity_ambiguous" : condition==="old-round" ? "round_changed" : condition==="revoked" ? "revoked" : "claim_not_found"});
      expect(f.snapshot()).toEqual(before);
    });

  it.each(["external", "dispatch"] as const)("permanently fences %s credentials during Builder handover", async kind => {
    const f = await fixture(), dispatch = kind === "dispatch" ? f.launch().dispatch : undefined;
    const original = await f.claim(dispatch ? { dispatchId: dispatch.id } : { session: f.identity });
    new BuilderHandovers(f.store).start(f.item.key, config.id, f.other.id, f.owner.id, "Transfer execution");
    const before = f.snapshot();
    refused(await f.recover(dispatch ? { dispatchId: dispatch.id } : { session: f.identity }), original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(["verification_failed", "cancelled", "reopened"] as const)("cannot recover after %s", async reason => {
    const f = await fixture(), original = await f.claim();
    const move = (to: "pending_verification" | "done" | "ready" | "cancelled", why: TransitionWorkItemInput["reason"]) =>
      f.store.transitionWorkItem({ itemKey: f.item.key, to, reason: why, actor: "human", executionDisposition: "keep_running",
        note: "Synthetic transition", attribution: { accountId: config.id } });
    if (reason === "cancelled") move("cancelled", "manual_override");
    else {
      move("pending_verification", "manual_override");
      if (reason === "reopened") move("done", "verification_passed");
      move("ready", reason);
    }
    const before = f.snapshot();
    refused(await f.recover({ session: f.identity }), original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it("preserves the original execution after an ordinary manual move to ready", async () => {
    const f = await fixture(), original = await f.claim();
    f.store.transitionWorkItem({ itemKey: f.item.key, to: "ready", reason: "released", actor: "human",
      note: "Card organization", attribution: { accountId: config.id } });
    const before = f.snapshot(), recovered = await f.recover({ session: f.identity });
    expect(recovered.structuredContent?.executionAuthorization).toBe(original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it("gives different guidance for missing and revoked credentials", async () => {
    const f = await fixture(), original = await f.claim();
    const assert = (credential?: string) => assertExecutionAuthorization(f.store.database, f.item.id, f.owner.id, "original-client", credential);
    expect(() => assert()).toThrow(/recover_execution_authorization/);
    expect(() => assert(randomUUID())).toThrow(/已失效/);
    expect(() => assert(original.executionAuthorization)).not.toThrow();
  });

  it("recovers an old tracking receipt after its identity was upgraded to native", async () => {
    const f = await fixture(), original = await f.claim({ session: { ...f.identity, refKind: "tracking" } });
    const sessions = new ExternalAgentSessionStore(f.store);
    sessions.register({ accountId: f.owner.id, clientId: "original-client" }, f.identity, f.item.key, original.sessionId);
    const before = f.snapshot();
    expect((await f.recover({ session: f.identity })).structuredContent?.executionAuthorization).toBe(original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it("does not recover one item's credential for another item in the same session", async () => {
    const f = await fixture(), original = await f.claim();
    const item = f.store.createWorkItem({ productId: f.product.id, title: "Another item", description: "Unclaimed",
      type: "task", priority: "normal", status: "ready", environment: { platform: "shared" } });
    refused(await f.recover({ itemKey: item.key, session: f.identity }), original.executionAuthorization);
    expect(f.store.getWorkItem(item.key).status).toBe("ready");
  });

  it("does not revive the old round when the same account claims again with a new session", async () => {
    const f = await fixture(), original = await f.claim();
    new ExternalAgentSessionStore(f.store).report({ accountId: f.owner.id, clientId: "original-client" },
      original.sessionId!, f.item.key, "completed", "Old execution finished", "completed-old-execution");
    f.store.transitionWorkItem({ itemKey: f.item.key, to: "ready", reason: "released", actor: "human",
      note: "New handling round", attribution: { accountId: config.id } });
    const identity = { ...f.identity, sessionRef: randomUUID() };
    const next = await f.claim({ session: identity });
    const before = f.snapshot();
    refused(await f.recover({ session: f.identity }), original.executionAuthorization);
    expect((await f.recover({ session: identity })).structuredContent?.executionAuthorization).toBe(next.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });

  it("refuses an ambiguous native identity and still permits the exact original dispatch", async () => {
    const f = await fixture(), { dispatch } = f.launch(), original = await f.claim({ dispatchId: dispatch.id });
    await f.call("register_agent_session", { itemKey: f.item.key, session: f.identity });
    const before = f.snapshot();
    refused(await f.recover({ session: f.identity }), original.executionAuthorization);
    expect((await f.recover({ dispatchId: dispatch.id })).structuredContent?.executionAuthorization).toBe(original.executionAuthorization);
    expect(f.snapshot()).toEqual(before);
  });
});

it("explains a missing own claim or broken receipt without diagnosing foreign identities",async()=>{
  const f=await fixture();
  const original=await f.claim();
  const registration=await f.call("register_agent_session",{itemKey:f.item.key,session:{...f.identity,sessionRef:randomUUID()}});
  const sessionId=registration.structuredContent!.sessionId;
  const before=f.snapshot();
  expect((await f.recover({sessionId})).structuredContent).toMatchObject({reason:"claim_not_found",statusChanged:false});
  expect((await f.recover({sessionId},{clientId:"other-client"})).structuredContent).toBeUndefined();
  expect((await f.recover({sessionId:randomUUID()})).structuredContent).toBeUndefined();
  expect(f.snapshot()).toEqual(before);
  f.db.prepare("DELETE FROM builder_execution_authorizations").run();
  const broken=f.snapshot();
  const result=await f.recover({sessionId:original.sessionId});
  refused(result,original.executionAuthorization);
  expect(result.structuredContent).toMatchObject({reason:"records_missing"});
  expect(f.snapshot()).toEqual(broken);
});

it("does not disclose native-ref ambiguity until every mapping has this client's verifiable claim",async()=>{
  const f=await fixture(),first=f.launch().dispatch,second=f.launch().dispatch;
  const original=await f.claim({dispatchId:first.id});
  const input={session:f.identity,authorizationMode:"conversation"};
  const before=f.snapshot();
  const wrongClient=await f.recover(input,{clientId:"different-client"});
  refused(wrongClient,original.executionAuthorization);
  expect(wrongClient.structuredContent).toBeUndefined();
  const missingAssociation=await f.recover(input);
  refused(missingAssociation,original.executionAuthorization);
  expect(missingAssociation.structuredContent).toBeUndefined();
  expect(f.snapshot()).toEqual(before);
  expect((await f.recover({dispatchId:first.id})).structuredContent?.executionAuthorization).toBe(original.executionAuthorization);
  const otherClaim=await f.claim({dispatchId:second.id});
  const claimed=f.snapshot();
  const ambiguous=await f.recover(input);
  refused(ambiguous,original.executionAuthorization);refused(ambiguous,otherClaim.executionAuthorization);
  expect(ambiguous.structuredContent).toMatchObject({reason:"identity_ambiguous",statusChanged:false});
  expect((await f.recover(input,{clientId:"different-client"})).structuredContent).toBeUndefined();
  expect(f.snapshot()).toEqual(claimed);
});
