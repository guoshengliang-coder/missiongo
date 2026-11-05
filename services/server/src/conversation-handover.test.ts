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
      expect((await f.call("claim_item", { ...claimInput, idempotencyKey: "second-claim" })).isError).toBe(true);
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
