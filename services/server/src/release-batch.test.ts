import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";

const config = { id: "batch-admin", username: "admin@example.test", passwordScrypt: hashPassword("synthetic password"),
  sessionSecret: "synthetic-release-batch-secret", cookieSecure: false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const commit = "a".repeat(40), receiptDigest = "b".repeat(64);
const completion = { kind: "commit", commit, targetBranch: "main" } as const;
const releases = [{ artifact: "web", version: "1.0", sourceCommit: commit }];

async function fixture() {
  const app = buildApp({ databasePath: ":memory:", adminAccount: config, writeTools: "comments", statusCheckTime: false });
  apps.push(app);
  const store = app.missionGoStore, accounts = app.missionGoAccounts;
  const developer = accounts.createAccount({ email: "developer@example.test", password: "synthetic password", role: "member" });
  const publisher = accounts.createAccount({ email: "publisher@example.test", password: "synthetic password", role: "member" });
  const product = store.createProduct({ name: "Release batch", keyPrefix: "BAT", createdByAccountId: config.id });
  const grant = (canOperate = true, canUseAi = true) => accounts.replacePermissions(publisher.id,
    [{ productId: product.id, canView: true, canOperate, canUseAi }]);
  grant();
  accounts.replacePermissions(developer.id, [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }]);
  const call = async (name: string, args: Record<string, unknown>, accountId = publisher.id, scopes = ["missiongo:read", "missiongo:write"]) => {
    const account = accounts.getAccount(accountId);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), accountId, scopes).token;
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const raw = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const parsed = JSON.parse(raw);
    return parsed.result ?? { error: parsed.error ?? parsed };
  };
  const add = async (requiredArtifacts = ["web"], manual = false) => {
    const item = store.createWorkItem({ productId: product.id, title: "Batch fixture", description: "Synthetic release regression",
      type: "task", priority: "normal", status: "ready", environment: { platform: "server" } });
    const claim = await call("claim_item", { itemKey: item.key, agentId: "Synthetic developer", session: {
      agentKind: "codex", refKind: "tracking", sessionRef: randomUUID() }, idempotencyKey: randomUUID() }, developer.id);
    expect(claim.isError, JSON.stringify(claim)).toBeFalsy();
    if (manual) {
      store.transitionWorkItem({itemKey:item.key,actor:"human",to:"development_complete",reason:"resolution_submitted",attribution:{accountId:config.id}});
      return item;
    }
    const result = await call("submit_development_complete", { itemKey: item.key, completion, requiredArtifacts,
      executionAuthorization: claim.structuredContent.executionAuthorization, idempotencyKey: randomUUID() }, developer.id);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return item;
  };
  const batch = async () => {
    const result = await call("list_release_candidates", { productId: product.id, includeUnscoped: true });
    return { productId: product.id, idempotencyKey: randomUUID(), deployedCommit: commit, receiptDigest,
      items: result.structuredContent.candidates.map((row: {itemKey: string; expectedRevision: number; developmentEventId: string; roundKey: string}) => ({
        itemKey: row.itemKey, expectedRevision: row.expectedRevision, developmentEventId: row.developmentEventId, roundKey: row.roundKey,
        completion, releases,
      })) };
  };
  return { app, store, accounts, developer, publisher, product, grant, call, add, batch };
}

describe("AND-415 release batch", () => {
  it("publishes multiple developer sessions through a different publisher, with audit and stable replay", async () => {
    const f = await fixture(), a = await f.add(), b = await f.add();
    const request = await f.batch();
    // Normal original-conversation handover remains isolated.
    expect((await f.call("submit_for_verification", { itemKey: a.key, completion, releases, deployedCommit: commit,
      receiptDigest, sessionId: randomUUID(), idempotencyKey: "wrong-session" })).isError).toBe(true);
    const result = await f.call("submit_release_batch", request);
    expect(result.structuredContent.results.map((row: {outcome: string}) => row.outcome)).toEqual(["submitted", "submitted"]);
    for (const item of [a, b]) {
      expect(f.store.getWorkItem(item.key)).toMatchObject({ status: "pending_verification", builderAccountId: f.developer.id });
      expect(f.store.getTimeline(item.key).at(-1)).toMatchObject({ actorKind: "agent", accountId: f.publisher.id,
        payload: { authorizationBasis: "product_release_batch", receiptDigest, releaseBatchId: result.structuredContent.batchId } });
    }
    const count = f.store.getTimeline(a.key).length;
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].outcome).toBe("already_submitted");
    expect(f.store.getTimeline(a.key)).toHaveLength(count);
    expect((await f.call("submit_release_batch", { ...request, receiptDigest: "c".repeat(64) })).isError).toBe(true);
  });

  it("skips incomplete artifacts independently and allows a newly verified batch to repair the omission", async () => {
    const f = await fixture(), incomplete = await f.add(["web", "macosApp"]), eligible = await f.add();
    const request = await f.batch();
    const result = await f.call("submit_release_batch", request);
    expect(result.structuredContent.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemKey: incomplete.key, outcome: "skipped" }),
      expect.objectContaining({ itemKey: eligible.key, outcome: "submitted" }),
    ]));
    expect(f.store.getWorkItem(incomplete.key).status).toBe("development_complete");
    const repair = await f.batch();
    repair.items[0].releases = [...releases, { artifact: "macosApp", version: "1.0", sourceCommit: commit }];
    expect((await f.call("submit_release_batch", repair)).structuredContent.results[0].outcome).toBe("submitted");
  });

  it.each(["revision", "event", "round", "held", "returned"])("does not overwrite a changed candidate: %s", async kind => {
    const f = await fixture(), item = await f.add(), request = await f.batch();
    if (kind === "revision") request.items[0].expectedRevision--;
    if (kind === "event") request.items[0].developmentEventId = randomUUID();
    if (kind === "round") request.items[0].roundKey = randomUUID();
    if (kind === "held" || kind === "returned") f.store.transitionWorkItem({ itemKey: item.key, actor: "human",
      to: "ready", reason: "released", attribution: { accountId: config.id }, note: "Synthetic decision" });
    if (kind === "held") f.store.transitionWorkItem({ itemKey: item.key, actor: "human", to: "on_hold", reason: "request_human_input", attribution: { accountId: config.id }, note: "Synthetic hold", executionDisposition: "keep_running" });
    const before = f.store.getWorkItem(item.key);
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].outcome).toBe("skipped");
    expect(f.store.getWorkItem(item.key)).toEqual(before);
  });

  it("does not heal a rejected delivery when a successful batch is replayed", async () => {
    const f = await fixture(), item = await f.add(), request = await f.batch();
    await f.call("submit_release_batch", request);
    f.store.transitionWorkItem({ itemKey: item.key, actor: "human", to: "ready", reason: "verification_failed", note: "Synthetic rejection", attribution: { accountId: config.id } });
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0]).toMatchObject({ outcome: "already_submitted", currentStatus: "ready" });
    expect(f.store.getWorkItem(item.key).status).toBe("ready");
  });

  it.each(["read-only", "operation", "ai"])("requires current %s authorization even on replay", async kind => {
    const f = await fixture(); await f.add(); const request = await f.batch();
    await f.call("submit_release_batch", request);
    if (kind === "operation") f.grant(false, true);
    if (kind === "ai") f.grant(true, false);
    const result = await f.call("submit_release_batch", request, f.publisher.id, kind === "read-only" ? ["missiongo:read"] : undefined);
    expect(result.isError || result.error).toBeTruthy();
  });

  it("rechecks archived projects and safely retries an unchanged candidate after the project reopens", async () => {
    const f = await fixture(), item = await f.add(), request = await f.batch();
    f.store.createProduct({ name: "Keep active", keyPrefix: "ACT" });
    f.store.updateProduct(f.product.id, { archived: true });
    const archived = await f.call("submit_release_batch", request);
    expect(archived.isError || archived.error).toBeTruthy();
    expect(f.store.getWorkItem(item.key).status).toBe("development_complete");
    f.store.updateProduct(f.product.id, { archived: false });
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].outcome).toBe("submitted");
  });

  it("rejects duplicate candidates and developer credentials on the batch API", async () => {
    const f = await fixture(), item = await f.add(), request = await f.batch();
    expect((await f.call("submit_release_batch", { ...request, items: [...request.items, request.items[0]] })).isError).toBe(true);
    expect((await f.call("submit_release_batch", { ...request, executionAuthorization: randomUUID() })).isError).toBe(true);
    expect(f.store.getWorkItem(item.key).status).toBe("development_complete");
  });

  it("rejects a mixed product batch before touching eligible rows", async () => {
    const f = await fixture(), item = await f.add(), request = await f.batch();
    const other = f.store.createProduct({ name: "Other", keyPrefix: "OTH", createdByAccountId: config.id });
    const foreign = f.store.createWorkItem({ productId: other.id, title: "Foreign", description: "Synthetic", type: "task", priority: "normal", status: "ready", environment: { platform: "server" } });
    request.items.push({ ...request.items[0], itemKey: foreign.key });
    expect((await f.call("submit_release_batch", request)).isError).toBe(true);
    expect(f.store.getWorkItem(item.key).status).toBe("development_complete");
  });
});


describe("AND-417/418 current-conversation evidence repair", () => {
  it("atomically supplements a human completion and hands over through an existing client", async () => {
    const f = await fixture(), item = await f.add(["web"], true), request = await f.batch();
    const human = f.store.getDevelopmentEvidence(item.key).handover!;
    const result = await f.call("submit_release_batch", request);
    expect(result.structuredContent.results[0].outcome).toBe("submitted");
    expect(f.store.getTimeline(item.key).find(e => e.id === human.id)).toEqual(human);
    const evidence = f.store.getTimeline(item.key).filter(e => e.eventType === "delivery_evidence_added");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({accountId:f.publisher.id,clientId:f.publisher.id,
      payload:{developmentEventId:human.id,roundKey:request.items[0].roundKey,completion,requiredArtifacts:["web"],authorizationBasis:"product_release_evidence"}});
    expect(evidence[0].payload).not.toHaveProperty("batchId");
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].outcome).toBe("already_submitted");
    expect(f.store.getTimeline(item.key).filter(e => e.eventType === "delivery_evidence_added")).toHaveLength(1);
  });

  it("repairs evidence before deployment without a merge session, then refreshes the candidate", async () => {
    const f = await fixture(), item = await f.add(["web"], true), batch = await f.batch();
    const {releases: _releases, ...row} = batch.items[0];
    const request = {productId:f.product.id,...row,requiredArtifacts:["web"],idempotencyKey:randomUUID()};
    const result = await f.call("supplement_release_evidence", request);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(result.structuredContent.item.status).toBe("development_complete");
    expect(result.structuredContent.item.revision).toBe(row.expectedRevision+1);
    expect((await f.call("supplement_release_evidence", request)).structuredContent.alreadyRecorded).toBe(true);
    expect((await f.call("supplement_release_evidence", {...request,requiredArtifacts:["androidApp"]})).isError).toBe(true);
    expect((await f.call("submit_release_batch", batch)).structuredContent.results[0].code).toBe("release_candidate_changed");
    const candidates = (await f.call("list_release_candidates", {productId:f.product.id,includeUnscoped:true})).structuredContent.candidates;
    expect(candidates[0]).toMatchObject({completion,requiredArtifacts:["web"]});
    expect((await f.call("submit_release_batch", await f.batch())).structuredContent.results[0].outcome).toBe("submitted");
    expect(f.store.getWorkItem(item.key).status).toBe("pending_verification");
  });

  it("rolls evidence back if public release validation fails", async () => {
    const f = await fixture(), item = await f.add(["web"], true), request = await f.batch();
    request.items[0].releases = [releases[0], releases[0]];
    const before = f.store.getWorkItem(item.key), timeline = f.store.getTimeline(item.key);
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].outcome).toBe("skipped");
    expect(f.store.getWorkItem(item.key)).toEqual(before);
    expect(f.store.getTimeline(item.key)).toEqual(timeline);
  });

  it("does not replace recorded integration or shrink known artifact scope", async () => {
    const f = await fixture(), item = await f.add(["web", "androidApp"]), batch = await f.batch();
    const {releases: _releases, ...row} = batch.items[0];
    for (const fields of [{completion:{...completion,commit:"c".repeat(40)},requiredArtifacts:["web","androidApp"]},
      {completion,requiredArtifacts:["web"]}]) {
      expect((await f.call("supplement_release_evidence", {productId:f.product.id,...row,...fields,idempotencyKey:randomUUID()})).isError).toBe(true);
    }
    expect(f.store.getDevelopmentReleaseScope(item.key)).toEqual(["androidApp","web"]);
    expect(f.store.getTimeline(item.key).some(e => e.eventType === "delivery_evidence_added")).toBe(false);
  });

  it("rejects changed content even with a freshly read revision", async () => {
    const f = await fixture(), item = await f.add(["web"], true);
    f.store.updateWorkItem(item.key,{description:"Changed requirement",attribution:{accountId:config.id}});
    const request = await f.batch();
    expect((await f.call("submit_release_batch", request)).structuredContent.results[0].code).toBe("release_candidate_changed");
    expect(f.store.getTimeline(item.key).some(e => e.eventType === "delivery_evidence_added")).toBe(false);
  });

  it.each(["read-only","operate","ai","foreign","event","round","revision"])("refuses unauthorized/stale evidence: %s", async kind => {
    const f = await fixture(), item = await f.add(["web"], true), batch = await f.batch();
    const {releases: _releases, ...row} = batch.items[0];
    const request = {productId:f.product.id,...row,requiredArtifacts:["web"],idempotencyKey:randomUUID()};
    if(kind==="operate")f.grant(false,true);
    if(kind==="ai")f.grant(true,false);
    if(kind==="foreign")request.productId=f.store.createProduct({name:"Other",keyPrefix:"OTH",createdByAccountId:config.id}).id;
    if(kind==="event")request.developmentEventId=randomUUID();
    if(kind==="round")request.roundKey=randomUUID();
    if(kind==="revision")request.expectedRevision--;
    const result=await f.call("supplement_release_evidence",request,f.publisher.id,kind==="read-only"?["missiongo:read"]:undefined);
    expect(result.isError||result.error).toBeTruthy();
    expect(f.store.getWorkItem(item.key).status).toBe("development_complete");
    expect(f.store.getTimeline(item.key).some(e=>e.eventType==="delivery_evidence_added")).toBe(false);
  });
});
