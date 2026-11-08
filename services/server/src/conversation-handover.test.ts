import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { BuilderHandovers } from "./builder-handovers.js";
import { DispatchStore } from "./dispatch-store.js";

const config = { id: "conversation-admin", username: "admin@example.test", passwordScrypt: hashPassword("synthetic password"),
  sessionSecret: "synthetic-conversation-handover-secret", cookieSecure: false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

type Identity = { dispatchId?: string; sessionId?: string; session?: { agentKind: string; refKind: string; sessionRef: string } };
type Result = { isError?: boolean; error?: unknown; content?: { type: string; text?: string }[];
  structuredContent?: { executionAuthorization?: string; executionIdentity?: Identity; sessionId?: string; [key: string]: unknown } };
const text = (result: Result) => (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
// Mimic the affected client: only content text reaches the caller, not structuredContent.
const textIdentity = (result: Result): Identity => JSON.parse(text(result).split("\n").at(-1)!).executionIdentity;
const completion = { kind: "commit", commit: "a".repeat(40), targetBranch: "main" };
const release = { releases: [{ artifact: "web", version: "synthetic-1", sourceCommit: "a".repeat(40) }],
  deployedCommit: "a".repeat(40), receiptDigest: "b".repeat(64) };

async function fixture() {
  const app = buildApp({ databasePath: ":memory:", adminAccount: config, writeTools: "comments", statusCheckTime: false });
  apps.push(app);
  const store = app.missionGoStore, accounts = app.missionGoAccounts, db = store.database.connection;
  const owner = accounts.createAccount({ email: "owner@example.test", password: "synthetic password", role: "member" });
  const other = accounts.createAccount({ email: "other@example.test", password: "synthetic password", role: "member" });
  const product = store.createProduct({ name: "Conversation handover", keyPrefix: "CON", createdByAccountId: config.id });
  const grant = (canOperate = true, canUseAi = true) => accounts.replacePermissions(owner.id,
    [{ productId: product.id, canView: true, canOperate, canUseAi }]);
  grant();
  accounts.replacePermissions(other.id, [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }]);
  const item = store.createWorkItem({ productId: product.id, title: "Synthetic handover", description: "Protocol regression only",
    type: "task", priority: "normal", status: "ready", environment: { platform: "shared" } });
  const session = { agentKind: "opencode", refKind: "native", sessionRef: randomUUID() };
  const call = async (name: string, input: Record<string, unknown>, options: { accountId?: string; clientId?: string; scopes?: string[] } = {}): Promise<Result> => {
    const account = accounts.getAccount(options.accountId ?? owner.id);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), options.clientId ?? "original-client", options.scopes ?? ["missiongo:read", "missiongo:write"]).token;
    // No automatic credential injection and no seeded plan decision.
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } } });
    const raw = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const parsed = JSON.parse(raw);
    return parsed.result ?? { error: parsed.error ?? parsed };
  };
  const launch = (projectKind?: "codex" | "claude_code" | "opencode") => {
    const kind = projectKind ?? "opencode";
    const dispatches = new DispatchStore(store.database);
    const node = dispatches.registerNode({ accountId: owner.id, installationId: randomUUID(), name: "Synthetic node" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind, planApprovalProtocol: 1, ready: true }]);
    dispatches.replaceOwnRepos(node.nodeId, [{ productId: product.id, repoPath: "/synthetic/conversation" }]);
    const dispatch = dispatches.createDispatch({ accountId: owner.id, nodeId: node.nodeId, agentKind: kind, mode: "default", itemKeys: [item.key] });
    dispatches.claimNextDispatch(node.nodeId);
    dispatches.recordDispatchResult({ nodeId: node.nodeId, dispatchId: dispatch.id, status: "launched" });
    if (projectKind) db.prepare(`INSERT INTO free_session_starts(dispatch_id,account_id,request_key,product_id,initial_text,config_json,ready)
      VALUES (?,?,?,?,?,'{}',1)`).run(dispatch.id, owner.id, randomUUID(), product.id, "Synthetic project conversation");
    const projectSessionId = new AgentSessionStore(store.database).createForDispatch({ dispatchId: dispatch.id, nodeId: node.nodeId, sessionRef: session.sessionRef });
    return { dispatch, node, projectSessionId };
  };
  const claimInput = { itemKey: item.key, agentId: "Synthetic OpenCode", session, authorizationMode: "conversation", idempotencyKey: "claim" };
  const complete = (identity: Identity) => call("submit_development_complete", { itemKey: item.key, ...identity, completion,
    requiredArtifacts: ["web"], idempotencyKey: "complete" });
  const snapshot = () => ({ item: store.getWorkItem(item.key), timeline: store.getTimeline(item.key),
    claims: db.prepare("SELECT * FROM mcp_agent_claim_receipts").all(),
    credentials: db.prepare("SELECT * FROM builder_execution_authorizations").all() });
  const safe = (result: Result) => {
    expect(result.error ?? result.isError, JSON.stringify(result)).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain("executionAuthorization");
    for (const credential of db.prepare("SELECT id FROM builder_execution_authorizations").all() as { id: string }[]) {
      expect(JSON.stringify(result)).not.toContain(credential.id);
    }
  };
  return { app, store, accounts, db, owner, other, grant, item, session, call, launch, claimInput, complete, snapshot, safe };
}

describe("AND-413 conversation-based handover", () => {
  it("announces conversation support separately from this connection's write permission", async () => {
    const f = await fixture();
    for (const scopes of [["missiongo:read"], ["missiongo:read", "missiongo:write"]]) {
      const result = await f.call("get_current_account", {}, { scopes });
      expect(result.structuredContent).toMatchObject({ capabilities: { supportsConversationAuthorization: true,
        canComment: scopes.includes("missiongo:write") } });
    }
  });

  it.each(["codex", "claude_code", "opencode"] as const)("keeps the %s project identity usable in text without a duplicate external session", async kind => {
    const f = await fixture(), { dispatch, projectSessionId } = f.launch(kind);
    const claimed = await f.call("claim_item", { ...f.claimInput, session: { ...f.session, agentKind: kind } });
    f.safe(claimed);
    expect(claimed.structuredContent).toMatchObject({ projectSessionId, dispatchId: dispatch.id, sessionSource: "dispatch" });
    expect(textIdentity(claimed)).toEqual({ dispatchId: dispatch.id });
    expect(text(claimed)).toContain("do not register or report an external session");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_sessions").get()).toMatchObject({ n: 0 });
    f.safe(await f.complete(textIdentity(claimed)));
  });

  it.each(["dispatch", "dispatch-native", "external", "external-native", "tracking", "legacy-tracking"])(
    "completes the text-only %s lifecycle without disclosing credentials", async kind => {
      const f = await fixture();
      const dispatch = kind.startsWith("dispatch") ? f.launch().dispatch : undefined;
      const claimInput: Record<string, unknown> = { ...f.claimInput };
      if (dispatch) { delete claimInput.session; claimInput.dispatchId = dispatch.id; }
      if (kind === "tracking") claimInput.session = { ...f.session, refKind: "tracking" };
      if (kind === "legacy-tracking") delete claimInput.session;
      const claimed = await f.call("claim_item", claimInput);
      f.safe(claimed);
      const before = f.snapshot();
      expect(await f.call("claim_item", claimInput)).toEqual(claimed);
      expect(f.snapshot()).toEqual(before);
      expect((await f.call("claim_item", { ...claimInput, idempotencyKey: "second-claim" })).isError).not.toBe(true);
      const identity = kind === "dispatch-native" || kind === "external-native" ? { session: f.session } : textIdentity(claimed);
      const recovered = await f.call("recover_execution_authorization", { itemKey: f.item.key, ...identity, authorizationMode: "conversation" });
      f.safe(recovered);
      expect(f.snapshot()).toEqual(before);
      const usableIdentity = textIdentity(recovered);
      const completed = await f.complete(usableIdentity);
      f.safe(completed);
      expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
      f.safe(await f.complete(usableIdentity));
      const published = await f.call("submit_for_verification", { itemKey: f.item.key, ...usableIdentity, completion, ...release, idempotencyKey: "publish" });
      f.safe(published);
      expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    });

  it.each(["submit_development_complete", "submit_for_verification"])("rejects invalid identities at %s without changing data", async tool => {
    const f = await fixture();
    const claimed = await f.call("claim_item", f.claimInput), identity = textIdentity(claimed);
    if (tool === "submit_for_verification") f.safe(await f.complete(identity));
    const credential = (f.db.prepare("SELECT id FROM builder_execution_authorizations").get() as { id: string }).id;
    const before = f.snapshot();
    for (const invalid of [{}, { dispatchId: randomUUID() }, { sessionId: randomUUID() },
      { session: { ...f.session, sessionRef: randomUUID() } },
      { ...identity, executionAuthorization: credential }, { ...identity, dispatchId: randomUUID() },
      { sessionId: "" }, { session: { ...f.session, refKind: "tracking" } }]) {
      const result = await f.call(tool, { itemKey: f.item.key, ...invalid, completion,
        requiredArtifacts: ["web"], ...release, idempotencyKey: randomUUID() });
      expect(result.error || result.isError, JSON.stringify(result)).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(f.snapshot()).toEqual(before);
    }
  });

  it.each(["wrong-account", "wrong-client", "read-only", "operation-revoked", "ai-revoked", "product-revoked", "revoked", "old-round", "receipt-missing", "receipt-mismatch", "ambiguous"])(
    "keeps both handovers behind the existing %s authorization check", async condition => {
      for (const tool of ["submit_development_complete", "submit_for_verification"]) {
        const f = await fixture(), claimed = await f.call("claim_item", f.claimInput), identity = textIdentity(claimed);
        if (tool === "submit_for_verification") f.safe(await f.complete(identity));
        if (condition === "operation-revoked") f.grant(false, true);
        if (condition === "ai-revoked") f.grant(true, false);
        if (condition === "product-revoked") f.accounts.replacePermissions(f.owner.id, [], "none");
        if (condition === "revoked") f.db.prepare("UPDATE builder_execution_authorizations SET revoked=1").run();
        if (condition === "old-round") f.db.prepare("UPDATE builder_execution_authorizations SET round_key=?").run(randomUUID());
        if (condition === "receipt-missing") f.db.prepare("DELETE FROM mcp_agent_claim_receipts").run();
        if (condition === "receipt-mismatch") f.db.prepare("UPDATE mcp_agent_claim_receipts SET result_json=json_set(result_json,'$.item.id',?)").run(randomUUID());
        if (condition === "ambiguous") {
          const id = randomUUID();
          f.db.prepare(`INSERT INTO builder_execution_authorizations(id,item_id,account_id,client_id,dispatch_id,created_at,round_key)
            SELECT ?,item_id,account_id,client_id,dispatch_id,created_at,round_key FROM builder_execution_authorizations`).run(id);
          f.db.prepare(`INSERT INTO mcp_agent_claim_receipts(account_id,client_id,idempotency_key,digest,result_json)
            SELECT account_id,client_id,'ambiguous',digest,json_set(result_json,'$.executionAuthorization',?) FROM mcp_agent_claim_receipts`).run(id);
        }
        const before = f.snapshot();
        const result = await f.call(tool, { itemKey: f.item.key, ...identity, completion, requiredArtifacts: ["web"], ...release, idempotencyKey: "denied" }, {
          ...(condition === "wrong-account" ? { accountId: f.other.id } : {}),
          ...(condition === "wrong-client" ? { clientId: "another-client" } : {}),
          ...(condition === "read-only" ? { scopes: ["missiongo:read"] } : {}),
        });
        expect(result.error || result.isError, JSON.stringify(result)).toBeTruthy();
        for (const credential of before.credentials as { id: string }[]) expect(JSON.stringify(result)).not.toContain(credential.id);
        expect(f.snapshot()).toEqual(before);
      }
    });

  it.each(["dispatch", "external"])("rejects %s identity after Builder handover and does not revive it", async kind => {
    const f = await fixture(), dispatch = kind === "dispatch" ? f.launch().dispatch : undefined;
    const claimed = await f.call("claim_item", dispatch
      ? { itemKey: f.item.key, dispatchId: dispatch.id, authorizationMode: "conversation", agentId: "Synthetic", idempotencyKey: "claim" } : f.claimInput);
    const identity = textIdentity(claimed);
    new BuilderHandovers(f.store).start(f.item.key, config.id, f.other.id, f.owner.id, "Synthetic transfer");
    const before = f.snapshot();
    expect((await f.complete(identity)).isError).toBe(true);
    expect((await f.call("recover_execution_authorization", { itemKey: f.item.key, ...identity, authorizationMode: "conversation" })).isError).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });

  it("cannot substitute a later registered session or a different item", async () => {
    const f = await fixture(), claimed = await f.call("claim_item", f.claimInput);
    const registered = await f.call("register_agent_session", { itemKey: f.item.key, session: { ...f.session, sessionRef: randomUUID() } });
    expect((await f.complete({ sessionId: registered.structuredContent!.sessionId! })).isError).toBe(true);
    const item = f.store.createWorkItem({ productId: f.item.productId, title: "Other item", description: "Unclaimed", type: "task", priority: "normal", status: "ready", environment: { platform: "shared" } });
    expect((await f.call("submit_development_complete", { itemKey: item.key, ...textIdentity(claimed), completion, requiredArtifacts: ["web"], idempotencyKey: "other" })).isError).toBe(true);
    expect(f.store.getWorkItem(item.key).status).toBe("ready");
  });

  it("can use a legacy claim without returning its credential again", async () => {
    const f = await fixture(), { authorizationMode: _mode, ...input } = f.claimInput;
    const legacy = await f.call("claim_item", input);
    expect(legacy.structuredContent!.executionAuthorization).toEqual(expect.any(String));
    const recovered = await f.call("recover_execution_authorization", { itemKey: f.item.key, session: f.session, authorizationMode: "conversation" });
    f.safe(recovered);
    f.safe(await f.complete(textIdentity(recovered)));
  });

  it("cannot change a text-only claim replay into a credential disclosure", async () => {
    const f = await fixture(), claimed = await f.call("claim_item", f.claimInput);
    f.safe(claimed);
    const before = f.snapshot();
    const changed = await f.call("claim_item", { ...f.claimInput, authorizationMode: "credential" });
    expect(changed.isError).toBe(true);
    for (const credential of before.credentials as { id: string }[]) expect(JSON.stringify(changed)).not.toContain(credential.id);
    expect(f.snapshot()).toEqual(before);
  });
});


const validation = {checks:[{name:"Applied configuration",method:"Compare digest and run the tool",result:"passed" as const,evidence:"Synthetic digest and output verified"}],
  remainingVerification:["A person reviews the result"],limitations:["Not applied to other devices"]};
const localCompletion = {kind:"local_change" as const,evidence:{version:1 as const,target:"Synthetic node shared tools",summary:"Update local tool",rollback:"Restore the verified backup",
  files:[{name:"release-tool.mjs",beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),sizeBytes:23}],validation}};
async function nonReleaseInput(f:Awaited<ReturnType<typeof fixture>>,identity:Identity,ref:unknown=completion) {
  const context=await f.call("get_item_context",{itemKey:f.item.key});
  const evidence=context.structuredContent?.developmentEvidence as Record<string,unknown>;
  return {itemKey:f.item.key,...identity,completion:ref,expectedRevision:evidence.expectedRevision,
    developmentEventId:evidence.developmentEventId,roundKey:evidence.roundKey,evidenceDigest:evidence.evidenceDigest,
    validation,idempotencyKey:"non-release-submit"};
}
describe("AND-466/467 evidence-bound no-release handover",()=>{
  it.each([completion,localCompletion])("submits Git or local work once, records human checks, and cannot accept work",async ref=>{
    const f=await fixture();
    const claimed=await f.call("claim_item",f.claimInput),identity=textIdentity(claimed);
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...identity,completion:ref,requiredArtifacts:[],noReleaseReason:"Synthetic local/CI tool; no distributed artifact",idempotencyKey:"dev"}));
    expect(f.store.getWorkItem(f.item.key)).toMatchObject({status:"development_complete",deliveryBasis:"no_release"});
    const input=await nonReleaseInput(f,identity,ref);
    f.safe(await f.call("submit_non_release_for_verification",input));
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    const events=f.store.getTimeline(f.item.key).filter(e=>e.toStatus === "pending_verification");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({actorKind:"agent",payload:{reason:"non_release_submitted",validation,requiredArtifacts:[]}});
    expect(events[0]!.payload).not.toHaveProperty("deployedCommit");
    expect(events[0]!.payload).not.toHaveProperty("releases");
    f.safe(await f.call("submit_non_release_for_verification",input));
    expect(f.store.getTimeline(f.item.key).filter(e=>e.toStatus === "pending_verification")).toHaveLength(1);
    expect((await f.call("submit_non_release_for_verification",{...input,validation:{...validation,limitations:["changed"]}})).isError).toBe(true);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("rejects wrong identity, revoked rights, stale revision/event/round, wrong digest and changed completion",async()=>{
    const f=await fixture(),identity=textIdentity(await f.call("claim_item",f.claimInput));
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...identity,completion,requiredArtifacts:[],noReleaseReason:"Only internal tools",idempotencyKey:"dev"}));
    const input=await nonReleaseInput(f,identity);
    for(const patch of [{expectedRevision:0},{developmentEventId:randomUUID()},{roundKey:randomUUID()},{evidenceDigest:"0".repeat(64)},
      {completion:{...completion,commit:"c".repeat(40)}},{sessionId:randomUUID(),session:undefined},{validation:{checks:[],remainingVerification:[],limitations:[]}}]) {
      expect((await f.call("submit_non_release_for_verification",{...input,...patch})).isError).toBe(true);
    }
    for(const options of [{accountId:f.other.id},{clientId:"different-client"},{scopes:["missiongo:read"]}]) {
      const response=await f.call("submit_non_release_for_verification",input,options);
      expect(response.isError||response.error).toBeTruthy();
    }
    f.grant(false);
    expect((await f.call("submit_non_release_for_verification",input)).isError).toBe(true);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });
  it("does not let release-required or unknown work bypass publication; local evidence cannot declare artifacts",async()=>{
    for(const requiredArtifacts of [["web"],undefined]) {
      const f=await fixture(),identity=textIdentity(await f.call("claim_item",f.claimInput));
      f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...identity,completion,requiredArtifacts,idempotencyKey:"dev"}));
      expect((await f.call("submit_non_release_for_verification",await nonReleaseInput(f,identity))).isError).toBe(true);
      expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    }
    const f=await fixture(),identity=textIdentity(await f.call("claim_item",f.claimInput));
    for(const requiredArtifacts of [["web"],undefined])expect((await f.call("submit_development_complete",{
      itemKey:f.item.key,...identity,completion:localCompletion,requiredArtifacts,idempotencyKey:"local-dev"})).isError).toBe(true);
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  });
  it("preserves known failed checks in review evidence without claiming they passed",async()=>{
    const f=await fixture(),identity=textIdentity(await f.call("claim_item",f.claimInput));
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...identity,completion,requiredArtifacts:[],noReleaseReason:"Internal data only",idempotencyKey:"dev"}));
    const input=await nonReleaseInput(f,identity);
    const actual={...validation,checks:[{...validation.checks[0]!,result:"failed",evidence:"Metric exceeds the original target; requires human decision"}]};
    f.safe(await f.call("submit_non_release_for_verification",{...input,validation:actual}));
    expect(f.store.getTimeline(f.item.key).at(-1)?.payload.validation).toEqual(actual);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("retries do not restore a human-rejected item, and old evidence cannot enter a new round",async()=>{
    const f=await fixture(),identity=textIdentity(await f.call("claim_item",f.claimInput));
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...identity,completion,requiredArtifacts:[],noReleaseReason:"Only internal tools",idempotencyKey:"dev"}));
    const input=await nonReleaseInput(f,identity);
    f.safe(await f.call("submit_non_release_for_verification",input));
    f.store.transitionWorkItem({itemKey:f.item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Needs further work",attribution:{accountId:config.id}});
    expect((await f.call("submit_non_release_for_verification",input)).isError).toBe(true);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  });
});

it("keeps two client claims independent through verification and lists an appended unpublished delivery",async()=>{
 const f=await fixture();
 const first=await f.call("claim_item",f.claimInput);f.safe(first);const firstIdentity=textIdentity(first);
 const secondSession={...f.session,sessionRef:randomUUID()};
 const second=await f.call("claim_item",{...f.claimInput,session:secondSession,idempotencyKey:"second-claim"},{clientId:"second-client"});f.safe(second);
 const secondIdentity=textIdentity(second);
 expect(secondIdentity).not.toEqual(firstIdentity);
 expect(f.db.prepare("SELECT revoked FROM builder_execution_authorizations").all()).toEqual([{revoked:0},{revoked:0}]);
 f.safe(await f.complete(firstIdentity));
 f.safe(await f.call("submit_for_verification",{itemKey:f.item.key,...firstIdentity,completion,...release,idempotencyKey:"publish-first"}));
 f.safe(await f.call("recover_execution_authorization",{itemKey:f.item.key,...secondIdentity,authorizationMode:"conversation"},{clientId:"second-client"}));
 expect((await f.call("recover_execution_authorization",{itemKey:f.item.key,...secondIdentity,authorizationMode:"conversation"})).isError).toBe(true);
 expect((await f.call("claim_item",{...f.claimInput,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:"too-late"})).isError).toBe(true);
 const appended=await f.call("submit_development_complete",{itemKey:f.item.key,...secondIdentity,completion:{...completion,commit:"c".repeat(40)},requiredArtifacts:["web"],idempotencyKey:"second-completion"},{clientId:"second-client"});f.safe(appended);
 expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
 const candidates=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});
 expect(candidates.isError,JSON.stringify(candidates)).toBeFalsy();
 const records=f.store.getDeliveryRecords(f.item.key);
 expect(candidates.structuredContent?.candidates).toMatchObject([{itemKey:f.item.key,developmentEventId:records[1]!.id}]);
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM mcp_agent_claim_receipts").get()).toMatchObject({n:2});
});
