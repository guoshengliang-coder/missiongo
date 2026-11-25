import {previouslyReviewedHistoricalGaps,reviewedHistoricalDeliveries} from "./historical-delivery-review.js";
import { MissionGoError } from "./errors.js";
import { mergeContinuationKey } from "./merge-continuation.js";
import {AgentHistory} from "./agent-history.js";
import {AgentArtifacts} from "./agent-artifacts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyIntegratorPrompt } from "./legacy-merge-authorization.js";
import { recoveryDetailPrefix } from "./merge-recovery-transport.js";
import { releaseCandidatePage } from "./release-candidate-page.js";
import { prerequisitesActionSchema, prerequisiteObservation, type PrerequisiteBatch } from "./merge-prerequisites.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { MergeDeliveries, type DeliveryInput } from "./merge-deliveries.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { FreeSessionStore } from "./free-session-store.js";
import { DispatchStore } from "./dispatch-store.js";
import { recordDevelopmentReviews } from "./development-reviews.js";

const config = { id: "conversation-admin", username: "admin@example.test", passwordScrypt: hashPassword("synthetic password"),
  sessionSecret: "synthetic-conversation-handover-secret", cookieSecure: false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map(app => app.close())); });

type Identity = { dispatchId?: string; sessionId?: string; session?: { agentKind: string; refKind: string; sessionRef: string } };
type Result = { resultType?:string; requestState?:string; inputRequests?:unknown; isError?: boolean; error?: unknown; content?: { type: string; text?: string }[];
  structuredContent?: { executionAuthorization?: string; executionIdentity?: Identity; sessionId?: string; [key: string]: unknown } };
const completion = { kind: "commit", commit: "a".repeat(40), targetBranch: "main" };

async function fixture(databasePath=":memory:") {
  const app = buildApp({ databasePath, adminAccount: config, writeTools: "comments", statusCheckTime: false });
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
  const call = async (name: string, input: Record<string, unknown>, options: { accountId?: string; clientId?: string; scopes?: string[]; native?:Record<string,unknown> } = {}): Promise<Result> => {
    const account = accounts.getAccount(options.accountId ?? owner.id);
    const token = createAiAccessToken(config, { id: account.id, username: account.email, role: account.role },
      accounts.credentialsStamp(account), options.clientId ?? "original-client", options.scopes ?? ["missiongo:read", "missiongo:write"]).token;
    // No automatic credential injection and no seeded plan decision.
    const response = await app.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream",...(options.native?{"mcp-method":"tools/call","mcp-name":name}:{}) },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input,...options.native } } });
    const raw = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : response.body;
    const parsed = JSON.parse(raw);
    return parsed.result ?? { error: parsed.error ?? parsed };
  };
  const launch = (projectKind?: "codex" | "claude_code" | "opencode") => {
    const kind = projectKind ?? "opencode";
    const dispatches = new DispatchStore(store.database);
    const node = dispatches.registerNode({ accountId: owner.id, installationId: randomUUID(), name: "Synthetic node" });
    dispatches.recordHeartbeat(node.nodeId, [{ kind, planApprovalProtocol: 1, ready: true }], [], "*", { supportsFreeSessions: true });
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


const proposal = (key: string): DeliveryInput => ({itemKeys:[key],repository:"https://github.com/example/project",pullRequest:12,
  head:"a".repeat(40),targetBranch:"main",summary:"Verified change",validation:"Synthetic regression passed",requiredArtifacts:["web"],
  evidence:{head:"a".repeat(40),base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"passed",mergeable:"clean",source:"synthetic Git fixture"}});

describe("integration directly in the original conversation",()=>{
  const human=(f:Awaited<ReturnType<typeof prepared>>,text:string)=>{
    f.db.prepare("UPDATE agent_sessions SET applied_settings_revision=settings_revision WHERE id=?").run(f.projectSessionId);
    if(!f.db.prepare("SELECT 1 FROM agent_session_messages WHERE session_id=? AND role='agent'").get(f.projectSessionId))
      new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"completed-change",role:"agent",phase:"final_answer",text:`Completed PR #${f.input.pullRequest} at ${f.input.head}`,occurredAt:new Date(Date.now()-1).toISOString()}]});
    const command=new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,text,[]);
    f.db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE id=?").run(command.id);
    return command;
  };
  const scope=(f:Awaited<ReturnType<typeof prepared>>)=>({productId:f.item.productId,repository:f.input.repository,operation:"merge_only" as const,deliveries:[f.input]});
  it.each(["codex","claude_code","opencode"] as const)("binds %s to its original dispatch with no new session or item",async kind=>{
    const f=await fixture(),launched=f.launch(kind);
    f.safe(await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:launched.dispatch.id}));
    const merges=new MergeDeliveries(f.store),input=proposal(f.item.key),identity={dispatchId:launched.dispatch.id};
    const ff={...f,...launched,merges,input,identity};human(ff as never,"执行合并");
    const before=f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get();
    const p=merges.prepareConversation(f.owner.id,"original-client",identity,"direct",{productId:f.item.productId,repository:input.repository,operation:"merge_only",deliveries:[input]});
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_deliveries").get()).toMatchObject({n:0});
    const b=merges.startConversation(f.owner.id,"original-client",identity,p.id);
    expect(b.sessionId).toBe(launched.projectSessionId);expect(b.dispatchId).toBe(launched.dispatch.id);expect(b.publish).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toEqual(before);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toMatchObject({n:1});
    expect(merges.startConversation(f.owner.id,"original-client",identity,p.id).id).toBe(b.id);
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBeUndefined();
    expect(merges.queue(f.item.productId,f.owner.id).occupancy).toMatchObject({active:true,sessionId:b.sessionId});
    expect(()=>merges.finish(f.owner.id,launched.dispatch.id,b.id)).toThrow(/结果未核实/);
  });
  it("keeps preparation read-only with respect to offers, and rejects scope mutation and missing human sources",async()=>{
    const f=await prepared();
    expect(()=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"no-source",scope(f))).toThrow(/可信/);
    human(f,"执行合并");const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"same",scope(f));
    expect(f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"same",scope(f)).id).toBe(p.id);
    expect(()=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"same",{...scope(f),operation:"merge_and_publish"})).toThrow();
    expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
    expect(()=>f.merges.startConversation(f.other.id,"original-client",f.identity,p.id)).toThrow();
    expect(()=>f.merges.startConversation(f.owner.id,"different-client",f.identity,p.id)).toThrow();
  });
  it("does not use a queue instruction, negation or mismatched operation as execution authority",async()=>{
    for(const text of ["添加到待集成","先别合并","是否应该合并","执行发布"]){
      const f=await prepared();human(f,text);const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
      expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
      expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
    }
  });
  it.each(["same-scope", "status-before-prepare", "changed-head", "different-base", "different-artifact", "unclocked", "stopped", "competing-pr", "quoted", "added-item", "claimed-item", "merge-only-unclocked", "merge-only-blockquote", "merge-only-same-scope"] as const)(
    "binds a new PR to the reviewed local commit: %s", async scenario => {
      vi.useFakeTimers({toFake:["Date"]});
      vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
      const f=await prepared(),sessions=new AgentSessionStore(f.store.database);
      f.db.prepare("DELETE FROM merge_deliveries WHERE id=?").run(f.d.id);
      f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
      const marker=`本次待交付提交 ${f.input.repository}/commit/${f.input.head} → main · web${scenario==="claimed-item"?" · "+f.item.key:""}`;
      const context=scenario==="competing-pr"?marker+"\n另外处理 other/repo#99"
        :scenario==="quoted"?"```text\n"+marker+"\n```":scenario==="merge-only-blockquote"?"> "+marker:marker;
      sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[
        {sourceId:"local-handoff",role:"agent",phase:"final_answer",
          text:context,occurredAt:new Date().toISOString()},
      ]});
      if(scenario==="unclocked"||scenario==="merge-only-unclocked")f.db.prepare("DELETE FROM session_message_times WHERE source_id='native:local-handoff'").run();
      vi.setSystemTime(Date.now()+10);
      const mergeOnly=scenario.startsWith("merge-only");
      human(f,mergeOnly?"合并":"合并和发布");
      const head=scenario==="changed-head"?"e".repeat(40):f.input.head;
      const delivery={...f.input,head,evidence:{...f.input.evidence,head},
        ...(scenario==="added-item"||scenario==="claimed-item"?{}:{itemKeys:[],productId:f.item.productId}),
        targetBranch:scenario==="different-base"?"other":"main",
        requiredArtifacts:scenario==="different-artifact"?["androidApp"]:["web"]};
      const input={...scope(f),operation:mergeOnly?"merge_only" as const:"merge_and_publish" as const,deliveries:[delivery]};
      const prepare=(scope=input)=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),scope);
      const start=(id:string)=>f.merges.startConversation(f.owner.id,"original-client",f.identity,id);
      const initial=scenario==="status-before-prepare"?undefined:prepare();
      if(scenario==="merge-only-unclocked"||scenario==="merge-only-blockquote")expect(()=>start(initial!.id)).toThrow();
      vi.setSystemTime(Date.now()+600001);
      if(scenario==="stopped"){
        human(f,"停止");
        vi.setSystemTime(Date.now()+10);
      }
      human(f,"发布进度如何？");
      if(initial)expect(()=>start(initial.id)).toThrow(/过期/);
      const refreshed=prepare();
      if(scenario!=="same-scope" && scenario!=="merge-only-same-scope" && scenario!=="status-before-prepare" && scenario!=="claimed-item"){
        expect(()=>start(refreshed.id)).toThrow();
        expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
        return;
      }
      const batch=start(refreshed.id);
      expect(batch.conversation?.authorization.text).toBe(mergeOnly?"合并":"合并和发布");
      expect(batch.conversation?.direct).toBe(true);
      vi.setSystemTime(Date.now()+10);
      human(f,"重试");
      expect(start(prepare().id).id).toBe(batch.id);
      expect(()=>start(prepare({...input,deliveries:[{...delivery,pullRequest:99}]}).id)).toThrow();
      if(scenario!=="status-before-prepare")return;
      const deliveryId=batch.deliveries[0]!;
      const check=(revision:number,checks:"passed"|"failed")=>f.merges.integrate(f.owner.id,f.dispatch.id,batch.id,revision,`ci-${checks}`,{
        kind:"check",deliveryId,expectedHead:head,base:delivery.evidence.base,checkedAt:new Date().toISOString(),
        checks,local:"passed",mergeable:"clean",source:"Synthetic GitHub CI",validation:"Same exact PR",
      });
      const failed=check(batch.integration!.revision,"failed");
      expect(failed.entries[0]?.mergeReady).toBe(false);
      vi.setSystemTime(Date.now()+10);
      human(f,"重新试一下");
      const passed=check(failed.integration!.revision,"passed");
      expect(passed.entries[0]?.mergeReady).toBe(true);

      const commit="c".repeat(40);
      f.merges.report(f.owner.id,f.dispatch.id,batch.id,deliveryId,{status:"merged",head,commit,detail:"Synthetic exact GitHub merge"});
      const merged=f.merges.batch(f.owner.id,f.dispatch.id,batch.id);
      const validated=f.merges.integrate(f.owner.id,f.dispatch.id,batch.id,merged.integration!.revision,"main-ci",{
        kind:"final_validation",head:commit,checkedAt:new Date().toISOString(),source:"Synthetic main CI",validation:"Passed",
      });
      expect(validated.publicationPrerequisiteGate.blockers).toEqual([]);
      const publishing=f.merges.integrate(f.owner.id,f.dispatch.id,batch.id,validated.integration!.revision,"publish-web",{
        kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),
        resultsDigest:validated.resultsDigest,detail:"Synthetic Web publication start",
      });
      expect(publishing.integration?.publication?.state).toBe("publishing");
    });
  it.each(["批准", "授权", "确认。", "可以执行", "确认吗？", "不批准", "mixed confirmation"] as const)(
    "recognizes scoped decisions without requiring particular wording: %s", async reply => {
      vi.useFakeTimers({toFake:["Date"]});
      vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
      const f=await prepared();
      human(f,"请核对执行范围");
      const prepare=()=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),scope(f));
      const shown=prepare();
      vi.setSystemTime(Date.now()+10);
      new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[
        {sourceId:"decision-scope",role:"agent",phase:"final_answer",text:reply==="mixed confirmation"?shown.reviewText+"\n另一个请求也确认吗？":shown.reviewText,occurredAt:new Date().toISOString()},
      ]});
      vi.setSystemTime(Date.now()+10);
      human(f,reply==="mixed confirmation"?"确认":reply);
      const start=()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,prepare().id);
      if(reply.endsWith("吗？")||reply.startsWith("不")||reply==="mixed confirmation"){
        expect(start).toThrow();
        return;
      }
      expect(start().conversation?.authorization.text).toBe(reply);
    });
  it.each(["matching", "persisted association", "unassociated", "changed head", "question", "prior stop"] as const)("direct one-PR integration from the original context: %s", async scenario => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared();
    const input = { ...scope(f), operation: "merge_and_publish" as const };
    const head = scenario === "changed head" ? "e".repeat(40) : f.input.head;
    if (scenario === "unassociated") f.db.prepare("DELETE FROM merge_deliveries WHERE id=?").run(f.d.id);
    new AgentSessionStore(f.store.database).recordSnapshot({ nodeId: f.node.nodeId, sessionId: f.projectSessionId, status: "idle", messages: [
      { sourceId: "ready-single-pr", role: "agent", phase: "final_answer", text: scenario === "persisted association" ? "代码验证已通过。" : `PR ${f.input.repository}/pull/${f.input.pullRequest} 已就绪，提交 ${head}。`, occurredAt: new Date().toISOString() },
    ] });
    vi.setSystemTime(Date.now() + 10);
    if (scenario === "prior stop") {
      human(f, "停止执行");
      vi.setSystemTime(Date.now() + 10);
    }
    human(f, scenario === "question" ? "能否合并并发布？" : "合并并发布");
    const preparation = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "direct", input);
    const start = () => f.merges.startConversation(f.owner.id, "original-client", f.identity, preparation.id);
    if (scenario !== "matching" && scenario !== "persisted association") {
      expect(start).toThrow();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 0 });
      return;
    }
    const batch = start();
    expect(batch.conversation?.direct).toBe(true);
    expect(batch.prerequisiteGate).toMatchObject({ required: false, ready: true });
    expect(batch.entries[0]?.mergeReady).toBe(false);
    if (scenario === "persisted association") {
      vi.setSystemTime(Date.now() + 10);
      human(f, "重试");
      const retry = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "direct-retry", input);
      expect(f.merges.startConversation(f.owner.id, "original-client", f.identity, retry.id).id).toBe(batch.id);
    }
    vi.setSystemTime(Date.now() + 10);
    human(f, "进度如何");
    expect(() => f.merges.integrate(f.owner.id, f.dispatch.id, batch.id, batch.integration!.revision, "progress",
      { kind: "progress", deliveryId: batch.deliveries[0]!, phase: "investigating", expectedHead: f.input.head, detail: "Existing batch still authorized" })).not.toThrow();
    vi.setSystemTime(Date.now() + 10);
    human(f, "停止执行");
    human(f, "进度如何");
    expect(() => f.merges.integrate(f.owner.id, f.dispatch.id, batch.id, batch.integration!.revision + 1, "stopped",
      { kind: "progress", deliveryId: batch.deliveries[0]!, phase: "investigating", expectedHead: f.input.head, detail: "Stop still applies" })).toThrow();
  });

  it("does not restore an original batch by asking for status after the Stop command", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared();
    human(f,"执行合并");
    const preparation=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"stop-batch",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,preparation.id);
    vi.setSystemTime(Date.now()+10);
    const stopped=human(f,"native Stop fixture");
    f.db.prepare("UPDATE agent_session_commands SET kind='interrupt' WHERE id=?").run(stopped.id);
    vi.setSystemTime(Date.now()+10);
    human(f,"进度如何");
    expect(()=>f.merges.integrate(f.owner.id,f.dispatch.id,b.id,b.integration!.revision,"after-stop",{
      kind:"progress",deliveryId:b.deliveries[0]!,expectedHead:f.input.head,phase:"investigating",detail:"Should remain stopped",
    })).toThrow();
  });

  it.each(["重试", "继续", "请继续处理"])("starts the first batch after a saved Web decision and %s", async reply => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared();
    human(f, "准备发布范围");
    const preparation = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "web-status",
      { ...scope(f), operation: "merge_and_publish" });
    vi.setSystemTime(Date.now() + 10);
    human(f, "能否合并并发布？");
    expect(f.merges.confirmConversationReview(f.owner.id, preparation.id, preparation.reviewDigest)).toEqual({ confirmed: true });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 0 });
    vi.setSystemTime(Date.now() + 10);
    human(f, "进度如何");
    expect(f.merges.conversationReview(f.owner.id, preparation.id).confirmed).toBe(true);
    vi.setSystemTime(Date.now() + 600001);
    human(f, reply);
    expect(f.merges.conversationReview(f.owner.id, preparation.id).confirmed).toBe(true);
    const retry = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "after-status",
      { ...scope(f), operation: "merge_and_publish" });
    expect(f.merges.startConversation(f.owner.id, "original-client", f.identity, retry.id).sessionId).toBe(f.projectSessionId);
  });

  it("requires complete publication scope display and handles only historical candidates without a selection",async()=>{
    const f=await prepared();await f.complete(f.identity);human(f,"执行发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"publish",{...scope(f),operation:"publish_only",deliveries:[]});
    expect(p.selection).toEqual([]);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/完整发布范围/);
    // This synthetic completion is a commit, not GitHub: a product publication may not silently discard it.
    expect(p.publicationScope?.blockers.length).toBeGreaterThan(0);
  });
  it("does not steal an active batch and rolls back internal draft registration",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false);
    human(f,"执行合并");const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"other",scope(f));
    const before=f.db.prepare("SELECT COUNT(*) AS n FROM merge_deliveries").get();
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/批次/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_deliveries").get()).toEqual(before);
    expect(f.merges.recomputeBatches(f.item.productId,f.owner.id)[0]?.id).toBe(b.id);
  });
  it("publishes existing item evidence without inventing a delivery selection or merging it again",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database);
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...f.identity,completion:{kind:"github",url:`${f.input.repository}/pull/${f.input.pullRequest}`},requiredArtifacts:["web"],idempotencyKey:"already-integrated"}));
    human(f,"准备发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"publication",{...scope(f),operation:"publish_only",deliveries:[]});
    expect(p.publicationScope?.blockers).toEqual([]);
    vi.setSystemTime(Date.now()+10);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"publication-scope",role:"agent",phase:"final_answer",text:p.reviewText,occurredAt:new Date(Date.now()-1).toISOString()}]});
    human(f,"批准");
    let b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    expect(b.deliveries).toEqual([]);expect(b.operation).toBe("publish_only");
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>{b=f.merges.integrate(f.owner.id,f.dispatch.id,b.id,b.integration!.revision,randomUUID(),action);};
    expect(()=>f.merges.report(f.owner.id,f.dispatch.id,b.id,f.d.id,{status:"merged",head:f.input.head,commit:"c".repeat(40),detail:"not allowed"})).toThrow();
    act({kind:"plan",base:"b".repeat(40),summary:"Verify existing integrated candidates",validation:"No new merges",entries:[]});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target ancestry",validation:"Verified integrated target"});
    act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Controlled publication adapter"});
    expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/发布/);
    act({kind:"publication_progress",state:"ended",checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Controlled adapter ended"});
    expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/凭据/);
    const candidate=f.store.getDeliveryRecords(f.item.key)[0]!;
    const published=await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"synthetic-publication",deployedCommit:"c".repeat(40),receiptDigest:"d".repeat(64),items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:candidate.id,roundKey:candidate.roundKey,completion:candidate.completion,releases:[{artifact:"web",version:"test",sourceCommit:"c".repeat(40)}]}]});f.safe(published);expect(published.structuredContent?.results,JSON.stringify(published)).toMatchObject([{outcome:"submitted"}]);
    expect(f.merges.finish(f.owner.id,f.dispatch.id,b.id).state).toBe("finished");
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it.each(["test","wrong"])("checks reviewed version constraints again before publish-only execution: %s",async receiptVersion=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database);
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...f.identity,completion:{kind:"github",url:`${f.input.repository}/pull/${f.input.pullRequest}`},requiredArtifacts:["web"],idempotencyKey:"already-integrated"}));
    human(f,"准备发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"publication",{...scope(f),operation:"publish_only",deliveries:[],publicationTargets:[{artifact:"web",version:"test"}]});
    expect(p.publicationScope?.blockers).toEqual([]);
    vi.setSystemTime(Date.now()+10);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"publication-scope",role:"agent",phase:"final_answer",text:p.reviewText,occurredAt:new Date(Date.now()-1).toISOString()}]});
    human(f,"发布 Web");
    let b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    expect(b.deliveries).toEqual([]);expect(b.operation).toBe("publish_only");
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>{b=f.merges.integrate(f.owner.id,f.dispatch.id,b.id,b.integration!.revision,randomUUID(),action);};
    expect(()=>f.merges.report(f.owner.id,f.dispatch.id,b.id,f.d.id,{status:"merged",head:f.input.head,commit:"c".repeat(40),detail:"not allowed"})).toThrow();
    act({kind:"plan",base:"b".repeat(40),summary:"Verify existing integrated candidates",validation:"No new merges",entries:[]});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target ancestry",validation:"Verified integrated target"});
    const publishing={kind:"publication_progress" as const,state:"publishing" as const,checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Synthetic verified repository manifest"};
    expect(()=>act(publishing)).toThrow(/版本/);
    expect(()=>act({...publishing,publicationVersions:[{artifact:"web",version:"wrong"}]})).toThrow(/版本/);
    act({...publishing,publicationVersions:[{artifact:"web",version:"test"}]});
    expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/发布/);
    act({kind:"publication_progress",state:"ended",checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Controlled adapter ended"});
    expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/凭据/);
    const candidate=f.store.getDeliveryRecords(f.item.key)[0]!;
    const published=await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"synthetic-publication",deployedCommit:"c".repeat(40),receiptDigest:"d".repeat(64),items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:candidate.id,roundKey:candidate.roundKey,completion:candidate.completion,releases:[{artifact:"web",version:receiptVersion,sourceCommit:"c".repeat(40)}]}]});f.safe(published);expect(published.structuredContent?.results,JSON.stringify(published)).toMatchObject([{outcome:"submitted"}]);
    if(receiptVersion==="wrong")expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/版本/);
    else expect(f.merges.finish(f.owner.id,f.dispatch.id,b.id).state).toBe("finished");
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("uses current node-authenticated native-only messages and stops on interruption or settings changes",async()=>{
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database),at=new Date().toISOString();
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"active",settingsRevision:1,messages:[{sourceId:"completed",role:"agent",phase:"final_answer",text:`Completed PR #12 at ${f.input.head}`,occurredAt:new Date(Date.parse(at)-1000).toISOString()},{sourceId:"native-order",role:"user",text:"执行合并",occurredAt:at}]});
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"native",scope(f));
    expect(p.source.sourceId).toBe("native:native-order");
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    sessions.enqueueInterrupt(f.owner.id,f.projectSessionId);
    expect(f.merges.batch(f.owner.id,f.dispatch.id,b.id).entries.every(d=>!d.mergeReady)).toBe(true);
    expect(()=>f.merges.integrate(f.owner.id,f.dispatch.id,b.id,0,"after-stop",{kind:"plan",base:"b".repeat(40),summary:"not allowed",validation:"stopped",entries:[]})).toThrow();
    f.db.prepare("UPDATE agent_sessions SET settings_revision=settings_revision+1 WHERE id=?").run(f.projectSessionId);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/可信|变化/);
  });
  it("supports a verified external project identity without fabricating a dispatch",async()=>{
    const f=await fixture(),launched=f.launch("codex");
    const nativeSession={agentKind:"codex",refKind:"native",sessionRef:randomUUID(),autoConnect:true};
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session:nativeSession});f.safe(registered);
    const id=registered.structuredContent!.sessionId!,native=new ExternalNativeSessionStore(f.store);
    const listed=native.listForNode(f.owner.id,launched.node.nodeId,"worker",()=>{},true);
    const binding=listed.find(s=>s.id===id)!;
    expect(binding).toBeDefined();
    native.recordSnapshot({accountId:f.owner.id,nodeId:launched.node.nodeId,sessionId:id,workerId:"worker",generation:binding.externalBindingGeneration,autoConnect:true,nativeSessionRef:nativeSession.sessionRef,status:"active",turnState:{turnActive:true},mode:"full-access",messages:[{sourceId:"completed",role:"agent",phase:"final_answer",text:"Completed PR #12",occurredAt:new Date(Date.now()-1).toISOString()},{sourceId:"native-command",role:"user",text:"执行合并",occurredAt:new Date().toISOString()}]},()=>{});
    const identity={sessionId:id},merges=new MergeDeliveries(f.store),input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const p=merges.prepareConversation(f.owner.id,"original-client",identity,"external-prepare",{productId:f.item.productId,repository:input.repository,operation:"merge_only",deliveries:[input]});
    const b=merges.startConversation(f.owner.id,"original-client",identity,p.id);
    expect(b.dispatchId).toBeUndefined();expect(b.sessionId).toBe(id);expect(b.config.mode).toBe("full-access");
    f.safe(await f.call("get_merge_batch",{sessionId:id,batchId:b.id}));
    expect((await f.call("get_merge_batch",{sessionId:id,batchId:b.id},{clientId:"wrong"})).isError).toBe(true);
    expect((await f.call("get_merge_batch",{dispatchId:id,batchId:b.id})).isError).toBe(true);
    const snapshot=merges.preview(f.owner.id,b.id).snapshot,key=randomUUID();
    merges.requestReconciliation(f.owner.id,id,b.id,key,snapshot,{kind:"retry_blocked",deliveryId:b.deliveries[0]!,reason:"Verified external retry scope"});
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"synthetic password"}});
    const headers={cookie:login.headers['set-cookie']!.toString().split(';')[0]!},url=`/api/v1/merge-batches/${b.id}/reconciliation`;
    const send=()=>f.app.inject({method:"POST",url:`${url}/${key}/decision`,headers,payload:{snapshot,decision:"approved",reviewConfirmed:true,continueInSession:true}});
    const read=()=>f.app.inject({method:"GET",url,headers});
    // A previous version mistook a real external conversation for a missing internal one.
    f.db.prepare("INSERT INTO idempotency_keys(key,operation,result_json,created_at) VALUES (?,'merge_continuation',?,?)")
      .run(`merge-continuation:${JSON.stringify([f.owner.id,id,mergeContinuationKey(b.id,key)])}`,JSON.stringify({state:"failed",reason:"unavailable"}),new Date().toISOString());
    native.disconnect(f.owner.id,id);
    expect((await send()).json().continuation).toMatchObject({state:"failed",reason:"not_ready"});
    native.connect(f.owner.id,id,launched.node.nodeId);
    const current=native.listForNode(f.owner.id,launched.node.nodeId,"worker",()=>{},true).find(s=>s.id===id)!;
    const report=(commandId?:string,commandStatus:"delivering"|"delivery_unknown"|"delivered"="delivered")=>native.recordSnapshot({accountId:f.owner.id,nodeId:launched.node.nodeId,sessionId:id,workerId:"worker",generation:current.externalBindingGeneration,
      nativeSessionRef:nativeSession.sessionRef,status:"idle",turnState:{turnActive:false},mode:"full-access",messages:[],...(commandId?{commandId,commandStatus}:{})},()=>{});
    report();
    const pending=native.enqueue(f.owner.id,id,"Existing external message",[],randomUUID());
    expect((await send()).json().continuation).toMatchObject({state:"failed",reason:"pending"});native.cancel(f.owner.id,id,pending.id);
    const accepted=await send();expect(accepted.statusCode,accepted.body).toBe(200);
    expect(accepted.json().continuation).toMatchObject({state:"queued",queued:true});const commandId=accepted.json().continuation.commandId;
    expect((await send()).json().continuation.commandId).toBe(commandId);
    report(commandId,"delivering");report(commandId,"delivery_unknown");
    expect((await read()).json().continuations[key]).toMatchObject({state:"delivery_unknown",commandId});
    report(commandId);expect((await read()).json().continuations[key]).toMatchObject({state:"delivered",commandId});
    expect((await send()).json().continuation.commandId).toBe(commandId);
    expect(f.db.prepare("SELECT count(*) AS n FROM external_native_commands WHERE session_id=? AND text LIKE '本次集成决定已批准%'").get(id)).toEqual({n:1});
    expect(f.db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE id=?").get(id)).toEqual({n:0});
  });
  it("freezes on a newer input, resumes an unchanged status query and never turns stop into continuation",async()=>{
    const f=await prepared();human(f,"执行合并");const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    human(f,"进度如何");
    expect(()=>f.merges.integrate(f.owner.id,f.dispatch.id,b.id,0,"new-work",{kind:"progress",deliveryId:b.deliveries[0]!,detail:"must freeze"})).toThrow();
    const r=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"resume",{...scope(f),deliveries:[],resumeBatchId:b.id});
    const resumed=f.merges.startConversation(f.owner.id,"original-client",f.identity,r.id);
    expect(resumed.id).toBe(b.id);expect(resumed.conversation?.authorization.text).toBe("执行合并");expect(resumed.conversation?.input.text).toBe("进度如何");
    human(f,"停止执行");
    const stop=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"stop",{...scope(f),deliveries:[],resumeBatchId:b.id});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,stop.id)).toThrow();
    human(f,"进度如何");
    const afterStop=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"after-stop",{...scope(f),deliveries:[],resumeBatchId:b.id});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,afterStop.id)).toThrow();
    human(f,"执行合并");
    const explicit=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"explicit",{...scope(f),deliveries:[],resumeBatchId:b.id});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,explicit.id)).toThrow(/变化/);
    // A stop without a previously clocked full review needs a current review;
    // a generic execution verb cannot silently revive the old authority.
    const reviewAt=Date.now()+10;vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(reviewAt);
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"explicit-renewal-review",role:"agent",phase:"final_answer",text:explicit.reviewText,occurredAt:new Date(reviewAt).toISOString()}]});
    vi.setSystemTime(reviewAt+10);human(f,"合并 PR #12");
    const renewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"renewed",{...scope(f),deliveries:[],resumeBatchId:b.id});
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,renewed.id).id).toBe(b.id);
  });
  it.each([false,true])("records Web recovery approval separately from delivery and later stop (%s)",async stop=>{
    const f=await prepared();human(f,"执行合并");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id),id=b.deliveries[0]!;
    f.merges.report(f.owner.id,f.dispatch.id,b.id,id,{status:"blocked",head:f.input.head,detail:"Resolved obstacle"});
    const snapshot=f.merges.preview(f.owner.id,b.id).snapshot,key="retry";
    f.merges.requestReconciliation(f.owner.id,f.dispatch.id,b.id,key,snapshot,{kind:"retry_blocked",deliveryId:id,reason:"Obstacle resolved"});
    f.merges.reviewReconciliation(f.owner.id,b.id,key,snapshot);
    const sessions=new AgentSessionStore(f.store.database);
    const c=f.merges.conversationReply(f.owner.id,b.sessionId," 批准 ",[],()=>sessions.enqueue(f.owner.id,b.sessionId," 批准 ",[]));
    expect(f.merges.preview(f.owner.id,b.id).reconciliation!.requests[0]!.decision).toBe("approved");
    expect(()=>f.merges.applyReconciliation(f.owner.id,f.dispatch.id,b.id,key)).toThrow();
    f.db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE id=?").run(c.id);
    if(stop){human(f,"停止执行");expect(()=>f.merges.applyReconciliation(f.owner.id,f.dispatch.id,b.id,key)).toThrow();}
    else expect(f.merges.applyReconciliation(f.owner.id,f.dispatch.id,b.id,key).entries[0]!.result).toBeUndefined();
  });
  it.each(["interrupt","missing-prior"])("never shortcuts status recovery across %s",async gap=>{
    const f=await prepared();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));const initial=human(f,"执行合并");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    if(gap==="interrupt"){
      new AgentSessionStore(f.store.database).enqueueInterrupt(f.owner.id,b.sessionId);
      f.db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE session_id=? AND kind='interrupt'").run(b.sessionId);
    }
    else f.db.prepare("DELETE FROM agent_session_commands WHERE id=?").run(initial.id);
    vi.useRealTimers();
    human(f,"进度如何");
    const resume=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"status",{...scope(f),deliveries:[],resumeBatchId:b.id});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,resume.id)).toThrow();
  });
  it.each(["no-milliseconds","offset"])("preserves a native stop with %s timestamps",async format=>{
    const f=await prepared(),at=Math.floor(Date.now()/1000)*1000-1000;
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at-2000));human(f,"执行合并");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);vi.useRealTimers();
    const occurredAt=format==="no-milliseconds"?new Date(at).toISOString().replace(".000Z","Z")
      :new Date(at+8*3600000).toISOString().replace("Z","+08:00");
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:b.sessionId,status:"idle",messages:[{sourceId:"native-stop",role:"user",text:"停止执行",occurredAt}]});
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at+1));human(f,"进度如何");
    const resume=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"status",{...scope(f),deliveries:[],resumeBatchId:b.id});vi.useRealTimers();
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,resume.id)).toThrow();
  });
  it("selects only chronologically prior native review context across ISO formats",async()=>{
    const f=await prepared(),at=Math.floor(Date.now()/1000)*1000-2000;
    const prior=`Completed PR #12 at ${f.input.head}`;
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",settingsRevision:1,messages:[
      {sourceId:"prior-review",role:"agent",phase:"final_answer",text:prior,occurredAt:new Date(at-1000).toISOString()},
      {sourceId:"native-command",role:"user",text:"执行合并",occurredAt:new Date(at).toISOString().replace(".000Z","Z")},
      {sourceId:"future-review",role:"agent",phase:"final_answer",text:"Later unrelated PR #99",occurredAt:new Date(at+1).toISOString()}]});
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"context",scope(f));
    expect(p.source.context).toBe(prior);
  });
  it("rebinds project delivery configuration only after exact new configuration approval",async()=>{
    const f=await fixture(),launched=f.launch("opencode"),merges=new MergeDeliveries(f.store);
    const identity={dispatchId:launched.dispatch.id},input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const ff={...f,...launched,input};human(ff as never,"执行合并");
    const s={productId:f.item.productId,repository:input.repository,operation:"merge_only" as const,deliveries:[input]};
    const p=merges.prepareConversation(f.owner.id,"original-client",identity,"initial",s),b=merges.startConversation(f.owner.id,"original-client",identity,p.id);
    f.db.prepare("UPDATE agent_sessions SET settings_revision=settings_revision+1,applied_settings_revision=settings_revision+1,mode='auto' WHERE id=?").run(b.sessionId);
    const r=merges.prepareConversation(f.owner.id,"original-client",identity,"new-config",{...s,deliveries:[],resumeBatchId:b.id});
    const at=Date.now()-1000;
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:launched.node.nodeId,sessionId:b.sessionId,status:"idle",messages:[{sourceId:"new-review",role:"agent",phase:"final_answer",text:r.reviewText,occurredAt:new Date(at).toISOString()}]});
    human(ff as never,"批准");
    const resumed=merges.startConversation(f.owner.id,"original-client",identity,r.id);
    expect(resumed.conversation!.configurationChanges).toHaveLength(1);
    expect(resumed.entries[0]!.blocker).toBeUndefined();
  });
  it.each([false,true])("restores exact native recovery consent including command mirrors (%s)",async mirror=>{
    const f=await prepared();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));human(f,"执行合并");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"prepare",scope(f));
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id),id=b.deliveries[0]!;
    f.merges.report(f.owner.id,f.dispatch.id,b.id,id,{status:"blocked",head:f.input.head,detail:"Resolved obstacle"});
    const snapshot=f.merges.preview(f.owner.id,b.id).snapshot,key="native-retry";
    f.merges.requestReconciliation(f.owner.id,f.dispatch.id,b.id,key,snapshot,{kind:"retry_blocked",deliveryId:id,reason:"Obstacle resolved"});
    const text=f.merges.preview(f.owner.id,b.id).reconciliation!.requests[0]!.reviewText!;vi.useRealTimers();const at=Date.now()-1000;
    let commandId:string|undefined;
    if(mirror){vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at+1));commandId=human(f,"批准").id;vi.useRealTimers();}
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:b.sessionId,status:"idle",messages:[
      {sourceId:"recovery-review",role:"agent",phase:"final_answer",text,occurredAt:new Date(at).toISOString()},
      {sourceId:"recovery-consent",role:"user",text:"批准",...(commandId?{clientMessageId:commandId}:{}),occurredAt:new Date(at+1).toISOString()}]});
    new AgentHistory(f.store.database,new AgentArtifacts(f.store.database,"")).observe(f.owner.id,f.node.nodeId,b.sessionId,{complete:true});
    expect(f.merges.recoverConversationDecision(f.owner.id,f.dispatch.id,b.id,key)).toMatchObject({code:"restored",decision:"approved"});
    expect(f.merges.applyReconciliation(f.owner.id,f.dispatch.id,b.id,key).entries[0]!.result).toBeUndefined();
  });
  it("completes the same merge validation and handoff gates in the original conversation",async()=>{
    const f=await prepared();human(f,"执行合并");const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"complete-original",scope(f));
    let b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id),id=b.deliveries[0]!;
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>{b=f.merges.integrate(f.owner.id,f.dispatch.id,b.id,b.integration!.revision,randomUUID(),action);};
    expect(b.entries[0]!.mergeReady).toBe(false);
    act({kind:"plan",base:"b".repeat(40),summary:"Integrate the original task",validation:"Verify behavior",entries:[{deliveryId:id,head:f.input.head,dependsOn:[],group:"one",reason:"Original task",validation:"Regression"}]});
    act({kind:"check",deliveryId:id,expectedHead:f.input.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic exact-head Git/CI",checks:"passed",mergeable:"clean",local:"passed",validation:"Passed original gates"});
    expect(b.entries[0]!.mergeReady).toBe(true);
    human(f,"进度如何");
    b=f.merges.report(f.owner.id,f.dispatch.id,b.id,id,{status:"merged",head:f.input.head,commit:"c".repeat(40),detail:"Verified exact target ancestry"}) as typeof b;
    expect(b.results[id]?.status).toBe("merged");
    const resumed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"late-handoff",{...scope(f),deliveries:[],resumeBatchId:b.id});
    b=f.merges.startConversation(f.owner.id,"original-client",f.identity,resumed.id);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(()=>f.merges.finish(f.owner.id,f.dispatch.id,b.id)).toThrow(/组合验证/);
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target",validation:"Merged combination passed"});
    expect(f.merges.finish(f.owner.id,f.dispatch.id,b.id).state).toBe("finished");
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);
    expect(f.store.getWorkItem(f.item.key).status).not.toBe("done");
  });
  it("rejects unknown changed heads, stale preparations and publication scope changes atomically",async()=>{
    const f=await prepared();human(f,"执行合并");
    const unknown=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"unknown-head",{...scope(f),deliveries:[{...f.input,head:"e".repeat(40),pullRequest:99,evidence:{...f.input.evidence,head:"e".repeat(40)}}]});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,unknown.id)).toThrow(/审阅依据/);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"expire",scope(f));
    vi.useFakeTimers();vi.setSystemTime(Date.now()+601000);
    try{expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/过期/);}finally{vi.useRealTimers();}
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("retains exact scope review across unrelated final answers and refreshed preparations",async()=>{
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database);
    human(f,"合并和发布");
    const input={...scope(f),operation:"merge_and_publish" as const};
    const first=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"cross-turn-first",input);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[
      {sourceId:"cross-turn-review",role:"agent",phase:"final_answer",text:first.reviewText,occurredAt:new Date(Date.now()-4).toISOString()},
      {sourceId:"cross-turn-progress",role:"agent",phase:"final_answer",text:"CI 仍在运行，尚未执行。",occurredAt:new Date(Date.now()-2).toISOString()},
    ]});
    human(f,"合并和发布");
    const next=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"cross-turn-next",input);
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,next.id);
    expect(b.sessionId).toBe(f.projectSessionId);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,next.id).id).toBe(b.id);
    const stored=JSON.parse((f.db.prepare("SELECT data_json FROM conversation_integration_preparations WHERE id=?").get(next.id) as {data_json:string}).data_json);
    expect(stored.reviewEvidence).toMatchObject({sourceId:"cross-turn-review",reviewDigest:next.reviewDigest});
    expect(b.conversation?.authorization.text).toBe("合并和发布");
    expect(b.entries[0]!.mergeReady).toBe(false);
  });
  const acrossTurns=async(kind:"codex"|"claude_code"|"opencode"="opencode",path=":memory:",repository?:string)=>{
    const f=await prepared(path,kind),sessions=new AgentSessionStore(f.store.database);
    human(f,"合并和发布");
    const input={...scope(f),repository:repository??f.input.repository,operation:"merge_and_publish" as const,deliveries:[{...f.input,repository:repository??f.input.repository}]};
    const first=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    const at=Date.now()-20;
    const record=(sourceId:string,text:string,offset=0)=>sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId,role:"agent",phase:"final_answer",text,occurredAt:new Date(at+offset).toISOString()}]});
    record("retained-review",first.reviewText);
    record("retained-progress","CI 仍在运行，尚未执行。",5);
    return {...f,sessions,input,first,record,at};
  };
  it.each(["confirmed", "clocked-mirror", "persisted-pr", "retried", "stopped", "changed-version", "changed-head", "other-pr", "other-repository", "extra-release-candidate", "mixed-confirmation", "unrelated-confirmation"] as const)(
    "binds version confirmation to the original scoped action: %s", async scenario => {
      vi.useFakeTimers({toFake:["Date"]});
      vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
      const f=await acrossTurns();
      f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
      const original=f.input.deliveries[0]!;
      vi.setSystemTime(Date.now()+10);
      const context=scenario==="persisted-pr"?"准备发布已登记的改动。"
        :scenario==="other-repository"?`other/repo#${original.pullRequest} at ${original.head}`
        :`Completed ${original.repository}/pull/${original.pullRequest} at ${original.head}`;
      f.record("completed-pr",context,25);
      vi.setSystemTime(Date.now()+20);
      const command=human(f,"合并和发布");
      const head=scenario==="changed-head"?"e".repeat(40):original.head;
      const pullRequest=scenario==="other-pr"?99:original.pullRequest;
      if(scenario==="extra-release-candidate")
        f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...f.identity,completion:{kind:"github",url:`${f.input.repository}/pull/13`},requiredArtifacts:["web"],idempotencyKey:"extra-release-candidate"}));
      const delivery={...original,head,pullRequest,evidence:{...original.evidence,head}};
      const input={...f.input,deliveries:[scenario==="extra-release-candidate"?{...delivery,itemKeys:[],productId:f.item.productId}:delivery],publicationTargets:[{artifact:"web",version:"1.2.3"}]};
      const prepare=(scope=input)=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),scope);
      const offered=prepare();
      const prompt=f.merges.conversationVersionPrompt(offered);
      if(scenario==="changed-head"||scenario==="other-pr"||scenario==="other-repository"||scenario==="extra-release-candidate"){
        expect(prompt).toBeUndefined();
        return;
      }
      expect(prompt).toBeDefined();
      vi.setSystemTime(Date.now()+10);
      f.record("version-offer",scenario==="mixed-confirmation"?prompt+"\n确认要创建条目吗？":prompt!,55);
      if(scenario==="unrelated-confirmation")f.record("unrelated-question","确认要创建条目吗？",56);
      vi.setSystemTime(Date.now()+20);
      if(scenario==="clocked-mirror")f.sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[
        {sourceId:`answer-${command.id}`,clientMessageId:command.id,role:"user",text:command.text,occurredAt:new Date(Date.parse(command.createdAt)+1).toISOString()},
      ]});
      if(scenario==="stopped")human(f,"停止");
      vi.setSystemTime(Date.now()+20);
      human(f,"确认");
      if(scenario==="retried"){
        vi.setSystemTime(Date.now()+20);
        human(f,"进度如何");
        vi.setSystemTime(Date.now()+20);
        human(f,"重试");
      }
      const start=()=>{
        const fresh=prepare(scenario==="changed-version"?{...input,publicationTargets:[{artifact:"web",version:"2.0.0"}]}:input);
        return f.merges.startConversation(f.owner.id,"original-client",f.identity,fresh.id);
      };
      if(scenario==="confirmed"||scenario==="clocked-mirror"||scenario==="persisted-pr"||scenario==="retried"){
        const batch=start();
        expect(batch.conversation?.authorization.text).toBe("合并和发布");
        expect(batch.conversation?.versionConfirmation?.text).toBe("确认");
        expect(batch.publicationTargets).toEqual(input.publicationTargets);
        expect(start().id).toBe(batch.id);
      }else{
        expect(start).toThrow();
        expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
      }
    });
  it("accepts exact reviewed artifact/version instruction without expanding publication",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
    const input={...f.input,publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("version-reviewed",reviewed.reviewText,10);
    human(f,"合并 PR #12 并发布 Web 1.2.3");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).sessionId).toBe(f.projectSessionId);
  });
  it.each(["codex","claude_code","opencode"] as const)("accepts screenshot-shaped Android/Web instruction for %s",async kind=>{
    const f=await acrossTurns(kind);f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
    const input={...f.input,deliveries:[{...f.input.deliveries[0]!,requiredArtifacts:["androidApp","web"]}],publicationTargets:[{artifact:"androidApp",version:"0.1.204"},{artifact:"web"}]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("android-web-review",reviewed.reviewText,10);
    human(f,"合并 PR #12 并发布 Android 0.1.204 和 Web");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    expect(b.publicationTargets).toEqual(input.publicationTargets);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).id).toBe(b.id);
  });
  it.each([
    ["合并 PR #12 并发布 Web 9.9.9","version_mismatch"],
    ["合并 PR #12 并发布 Web 和 Android","artifact_mismatch"],
  ])("does not authorize mismatched explicit targets: %s",async(instruction,reason)=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);const input={...f.input,publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);f.record("exact-version",reviewed.reviewText,10);
    human(f,instruction!);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrowError(expect.objectContaining({code:`conversation_integration_${reason}`}));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("keeps version constraints bound to review and refuses unreviewed replacements",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);human(f,"合并 PR #12 并发布 Web 1.2.3");
    const input={...f.input,publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/完整发布范围/);
  });
  it("reports missing version constraints rather than silently stripping a user version",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);human(f,"合并 PR #12 并发布 Web 1.2.3");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrowError(expect.objectContaining({code:"conversation_integration_version_evidence_missing"}));
  });
  it("renews a stopped same scope only with explicit complete PR and artifacts",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);vi.setSystemTime(Date.now()+10);human(f,"停止");vi.setSystemTime(Date.now()+10);human(f,"合并 PR #12 并发布 Web");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).sessionId).toBe(f.projectSessionId);
  });
  it.each(["合并和发布","合并 PR #12 并发布","合并并发布 Web"])("does not clear a stop through incomplete reauthorization: %s",async instruction=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);human(f,"暂停");human(f,instruction);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/停止、范围变化或歧义/);
  });
  it("cannot clear a changed artifact scope by naming the former complete scope",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);human(f,"改成只发布 Android");human(f,"合并 PR #12 并发布 Web");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/范围/);
  });
  it("preserves version constraints and rejects an artifact mismatch on active-batch resume",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
    const input={...f.input,publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const first=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);f.record("resume-target-review",first.reviewText,10);
    human(f,"合并 PR #12 并发布 Web 1.2.3");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    human(f,"合并 PR #12 并发布 Android");
    const resume=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{productId:f.item.productId,repository:f.input.repository,operation:"merge_and_publish",resumeBatchId:b.id});
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,resume.id)).toThrowError(expect.objectContaining({code:"conversation_integration_artifact_mismatch"}));
    expect(()=>f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{productId:f.item.productId,repository:f.input.repository,operation:"merge_and_publish",resumeBatchId:b.id,publicationTargets:[{artifact:"web",version:"2.0.0"}]})).toThrow(/变化/);
  });
  it("renews a stopped active batch without creating a second batch",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web"]);
    human(f,"合并 PR #12 并发布 Web");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    vi.setSystemTime(Date.now()+10);human(f,"暂停");vi.setSystemTime(Date.now()+10);human(f,"合并 PR #12 并发布 Web");
    const resume=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{productId:f.item.productId,repository:f.input.repository,operation:"merge_and_publish",resumeBatchId:b.id});
    expect(resume.reviewDigest).toBe(p.reviewDigest);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,resume.id).id).toBe(b.id);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:1});
  });
  it.each(["合并 PR #12 并发布 Web","合并 PR #12 并发布"])("does not broaden an intervening PR subset through a later generic instruction: %s",async instruction=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web"]);
    const other={...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId,pullRequest:13,head:"b".repeat(40),evidence:{...f.input.deliveries[0]!.evidence,head:"b".repeat(40)}};
    const input={...f.input,deliveries:[...f.input.deliveries,other]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);f.record("middle-subset-review",reviewed.reviewText,10);
    human(f,instruction);human(f,"合并和发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrowError(expect.objectContaining({code:"conversation_integration_reference_subset"}));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("rejects a version token identical to the PR short SHA before reference matching",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web"]);
    const head="1234567"+"a".repeat(33),input={...f.input,deliveries:[{...f.input.deliveries[0]!,head,evidence:{...f.input.deliveries[0]!.evidence,head}}],publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);f.record("sha-version-reviewed",reviewed.reviewText,10);
    human(f,"合并 PR #12 并发布 Web 1234567");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrowError(expect.objectContaining({code:"conversation_integration_version_mismatch"}));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("accepts the same target set in a different order on active-batch resume",async()=>{
    const f=await acrossTurns();f.store.recordProductReleaseArtifacts(f.item.productId,["web","androidApp"]);
    const targets=[{artifact:"web"},{artifact:"androidApp",version:"0.1.204"}];
    const input={...f.input,deliveries:[{...f.input.deliveries[0]!,requiredArtifacts:["web","androidApp"]}],publicationTargets:targets};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);f.record("unordered-target-review",reviewed.reviewText,10);
    human(f,"合并 PR #12 并发布 Web 和 Android 0.1.204");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    human(f,"进度如何");
    const resume=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{productId:f.item.productId,repository:f.input.repository,operation:"merge_and_publish",resumeBatchId:b.id,publicationTargets:targets});
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,resume.id).id).toBe(b.id);
  });
  it.each(["codex","claude_code","opencode"] as const)("reuses clocked cross-turn review for %s including item-creation replies",async kind=>{
    const f=await acrossTurns(kind);
    human(f,"那你提交一个条目给missiongo");human(f,"提交");
    f.sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"created-item-report",role:"agent",phase:"final_answer",text:"问题已登记为独立条目。",occurredAt:new Date(Date.now()-1).toISOString()}]});
    human(f,`合并和发布 ${f.input.deliveries[0]!.repository}/pull/12 ${f.input.deliveries[0]!.head.slice(0,12)}`);
    const next=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{...f.input,deliveries:[{...f.input.deliveries[0]!,evidence:{...f.input.deliveries[0]!.evidence,checkedAt:new Date().toISOString()}}]});
    expect(next.reviewDigest).toBe(f.first.reviewDigest);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,next.id).sessionId).toBe(f.projectSessionId);
  });
  it.each(["https://github.com/abcdef123/project","https://github.com/example/123abcde"])("accepts hex repository names and exact commit URLs: %s",async repository=>{
    const f=await acrossTurns("codex",":memory:",repository),head=f.input.deliveries[0]!.head;
    human(f,`合并和发布 ${repository}/pull/12 ${repository}/commit/${head.slice(0,12)}`);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).sessionId).toBe(f.projectSessionId);
  });
  it.each(["https://github.com/example/project/commit/"+"e".repeat(40),"https://github.com/other/project/commit/"+"a".repeat(40)])("rejects mismatched commit URL: %s",async url=>{
    const f=await acrossTurns();human(f,`合并和发布 ${url}`);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/范围/);
  });
  it.each(["PR #12","https://github.com/example/project/pull/12","a".repeat(12),"PR #12，排除 PR #13","PR #12，忽略 PR #13","PR #12 except PR #13","PR #12，PR #13 只发布 Web","PR #12 PR #13 Android","PR #12 PR #13，去掉 Web"])("rejects explicit subset of a two-delivery scope: %s",async reference=>{
    const f=await acrossTurns();
    const other={...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId,pullRequest:13,head:"b".repeat(40),evidence:{...f.input.deliveries[0]!.evidence,head:"b".repeat(40)}};
    const input={...f.input,deliveries:[...f.input.deliveries,other]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("two-reviewed",reviewed.reviewText,6);f.record("two-progress","CI 仍在运行。",7);
    human(f,`合并和发布 ${reference}`);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/范围/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it.each(["PR #12 PR #13","a".repeat(12)+" "+"b".repeat(12),"","全部"])("accepts complete or generic two-delivery instruction: %s",async reference=>{
    const f=await acrossTurns();
    const other={...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId,pullRequest:13,head:"b".repeat(40),evidence:{...f.input.deliveries[0]!.evidence,head:"b".repeat(40)}};
    const input={...f.input,deliveries:[...f.input.deliveries,other]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("all-reviewed",reviewed.reviewText,6);f.record("all-progress","CI 仍在运行。",7);
    human(f,reference==="全部"?"全部合并和发布":`合并和发布 ${reference}`.trim());
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(p.reviewText).toBe(reviewed.reviewText);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).entries).toHaveLength(2);
  });
  it.each(["全部合并的 PR #12","全部合并","全部合并，不发布"])("blocks unreviewed merge scope: %s",async reply=>{
    const f=await prepared();
    human(f,reply);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),scope(f));
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow();
  });
  it("continues a reviewed command with a separately clocked mirror",async()=>{
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    const f=await acrossTurns();
    vi.setSystemTime(Date.now()+20);
    const command=human(f,"全部合并和发布");
    vi.setSystemTime(Date.now()+20);
    f.sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[
      {sourceId:`answer-${command.id}`,clientMessageId:command.id,role:"user",text:command.text,occurredAt:new Date(Date.parse(command.createdAt)+1).toISOString()},
    ]});
    human(f,"继续");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).conversation?.authorization.text).toBe(command.text);
  });
  it.each(["合并和发布 PR #12","全部合并和发布"])("binds only the disclosed scope with an added publication candidate: %s",async instruction=>{
    const f=await acrossTurns();
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,...f.identity,completion:{kind:"github",url:`${f.input.repository}/pull/13`},requiredArtifacts:["web"],idempotencyKey:"additional-candidate"}));
    const input={...f.input,deliveries:[{...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId}]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(reviewed.publicationScope?.candidates).toHaveLength(2);
    f.record("additional-candidate-reviewed",reviewed.reviewText.split("\n执行配置 ")[0]!.replaceAll(" · ", "  ·  "),6);
    human(f,instruction);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    const start=()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    if(instruction==="全部合并和发布"){
      const batch=start();
      expect(batch.entries).toHaveLength(1);
      expect(batch.publicationScope?.candidates).toHaveLength(2);
      return;
    }
    expect(start).toThrow(/范围/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it.each(["merge and publish PR #12 except PR #13","merge and publish PR #12 ignore PR #13","merge and publish Android"])("rejects qualified intervening action inside a reviewed two-PR scope: %s",async instruction=>{
    const f=await acrossTurns();
    const other={...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId,pullRequest:13,head:"b".repeat(40),evidence:{...f.input.deliveries[0]!.evidence,head:"b".repeat(40)}};
    const input={...f.input,deliveries:[...f.input.deliveries,other]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("qualified-two-reviewed",reviewed.reviewText,6);f.record("qualified-two-progress","CI 仍在运行。",7);
    human(f,instruction);human(f,"合并和发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(p.reviewText).toBe(reviewed.reviewText);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/范围/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("rejects ambiguous short SHA shared by different PRs",async()=>{
    const f=await acrossTurns();
    const head="a".repeat(7)+"b".repeat(33),other={...f.input.deliveries[0]!,itemKeys:[],productId:f.item.productId,pullRequest:13,head,evidence:{...f.input.deliveries[0]!.evidence,head}};
    const input={...f.input,deliveries:[...f.input.deliveries,other]};
    const reviewed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    f.record("ambiguous-sha-reviewed",reviewed.reviewText,6);
    human(f,"合并和发布 aaaaaaa");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/范围/);
  });
  it.each(["请继续合并和发布","把这个PR合并和发布","merge this PR and release","merge and publish #12"])("accepts complete bounded current instruction: %s",async instruction=>{
    const f=await acrossTurns();human(f,instruction);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).sessionId).toBe(f.projectSessionId);
  });
  it.each(["仅合并，不发布","only merge, do not publish"])("preserves operation-only exclusions: %s",async instruction=>{
    const f=await prepared();human(f,instruction);
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),scope(f));
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id).publish).toBe(false);
  });
  it.each(["停止","改成只发布 Web","合并 PR #99","调整一下","不要发布","合并和发布 https://github.com/example/project/pull/99","合并和发布 https://github.com/other/project/pull/12","合并和发布 "+"e".repeat(40),"merge and publish PR #12 except PR #13","merge and publish PR #12 ignore PR #13","merge and publish Android"])("does not skip intervening stop, scope change or ambiguous input: %s",async text=>{
    const f=await acrossTurns();human(f,text);human(f,"合并和发布");
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id)).toThrow(/停止、范围变化或歧义/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it.each(["newer-scope","multiple-scopes","missing-clock","changed-clock","missing-user-clock","new-head","new-artifact","current-other-pr","current-other-url","current-other-repo","current-other-sha","current-unparsed-url","bare-approval","interrupt"])("rejects invalid retained review: %s",async scenario=>{
    const f=await acrossTurns();
    if(scenario==="newer-scope")f.record("replacement",f.first.reviewText.replace(f.input.deliveries[0]!.head,"e".repeat(40)),10);
    if(scenario==="multiple-scopes")f.record("ambiguous",f.first.reviewText+"\n"+f.first.reviewText,10);
    if(scenario==="missing-clock")f.db.prepare("DELETE FROM session_message_times WHERE source_id=?").run("native:retained-review");
    if(scenario==="changed-clock")f.db.prepare("UPDATE session_message_times SET occurred_at=? WHERE source_id=?").run(new Date(f.at-1000).toISOString(),"native:retained-review");
    if(scenario==="missing-user-clock")f.sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"missing-user",role:"user",text:"进度如何"}]});
    if(scenario==="interrupt"){f.sessions.enqueueInterrupt(f.owner.id,f.projectSessionId);f.db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE session_id=? AND kind='interrupt'").run(f.projectSessionId);}
    const instruction=scenario==="current-unparsed-url"?"合并和发布 https://github.com/other/project/tree/main":scenario==="current-other-url"?"合并和发布 https://github.com/example/project/pull/99":scenario==="current-other-repo"?"合并和发布 https://github.com/other/project/pull/12":scenario==="current-other-sha"?"合并和发布 "+"e".repeat(40):undefined;
    human(f,instruction??(scenario==="bare-approval"?"批准":scenario==="current-other-pr"?"合并和发布 PR #99":"合并和发布"));
    const deliveries=scenario==="new-head"?[{...f.input.deliveries[0]!,head:"e".repeat(40),evidence:{...f.input.deliveries[0]!.evidence,head:"e".repeat(40)}}]:scenario==="new-artifact"?[{...f.input.deliveries[0]!,requiredArtifacts:["web","androidApp"]}]:f.input.deliveries;
    expect(()=>{
      const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),{...f.input,deliveries});
      f.merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
    }).toThrow();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
  });
  it("reconstructs retained review after database reopen without a new session",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"scope-review-")),path=join(dir,"state.sqlite");
    try {
      const f=await acrossTurns("codex",path);human(f,"合并和发布");
      const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,randomUUID(),f.input);
      await f.app.close();apps.splice(apps.indexOf(f.app),1);
      const reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});apps.push(reopened);
      const merges=new MergeDeliveries(reopened.missionGoStore);
      const b=merges.startConversation(f.owner.id,"original-client",f.identity,p.id);
      expect(b.sessionId).toBe(f.projectSessionId);
      expect(merges.startConversation(f.owner.id,"original-client",f.identity,p.id).id).toBe(b.id);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:1});
      await reopened.close();apps.splice(apps.indexOf(reopened),1);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it.each(["codex","claude_code","opencode"] as const)("verifies retained scope from %s external native clocks",async kind=>{
    const f=await fixture(),launched=f.launch(kind);
    f.store.recordProductReleaseArtifacts(f.item.productId,["web"]);
    const nativeSession={agentKind:kind,refKind:"native",sessionRef:randomUUID(),autoConnect:true};
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session:nativeSession});f.safe(registered);
    const id=registered.structuredContent!.sessionId!,native=new ExternalNativeSessionStore(f.store);
    const binding=native.listForNode(f.owner.id,launched.node.nodeId,"worker",()=>{},true).find(s=>s.id===id)!;
    const at=Date.now();
    const sync=(messages:Parameters<typeof native.recordSnapshot>[0]["messages"])=>native.recordSnapshot({accountId:f.owner.id,nodeId:launched.node.nodeId,sessionId:id,workerId:"worker",generation:binding.externalBindingGeneration,autoConnect:true,nativeSessionRef:nativeSession.sessionRef,status:"active",turnState:{turnActive:true},mode:"full-access",messages},()=>{});
    sync([{sourceId:"external-start",role:"user",text:"合并和发布",occurredAt:new Date(at).toISOString()}]);
    const identity={sessionId:id},merges=new MergeDeliveries(f.store),delivery={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const input={productId:f.item.productId,repository:delivery.repository,operation:"merge_and_publish" as const,deliveries:[delivery],publicationTargets:[{artifact:"web",version:"1.2.3"}]};
    const first=merges.prepareConversation(f.owner.id,"original-client",identity,randomUUID(),input);
    sync([
      {sourceId:"external-review",role:"agent",phase:"final_answer",text:first.reviewText,occurredAt:new Date(at+1).toISOString()},
      {sourceId:"external-progress",role:"agent",phase:"final_answer",text:"CI 仍在运行。",occurredAt:new Date(at+2).toISOString()},
      {sourceId:"external-execute",role:"user",text:"合并 PR #12 并发布 Web 1.2.3",occurredAt:new Date(at+3).toISOString()},
    ]);
    const p=merges.prepareConversation(f.owner.id,"original-client",identity,randomUUID(),input);
    const b=merges.startConversation(f.owner.id,"original-client",identity,p.id);
    expect(b.sessionId).toBe(id);expect(b.dispatchId).toBeUndefined();
    expect((await f.call("get_merge_batch",{sessionId:id,batchId:b.id},{clientId:"wrong"})).isError).toBe(true);
  });
  it("AND-540 accepts a current continuation after reviewing and refreshing the exact publication scope",async()=>{
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database);
    human(f,"合并和发布");
    const input={...scope(f),operation:"merge_and_publish" as const};
    const first=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"and540-first",input);
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,first.id)).toThrow(/完整发布范围/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:0});
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{
      sourceId:"and540-reviewed",role:"agent",phase:"final_answer",text:first.reviewText,
      occurredAt:new Date(Date.now()-1).toISOString(),
    }]});
    human(f,"继续合并和发布");
    const refreshed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"and540-refresh",{
      ...input,deliveries:[{...f.input,evidence:{...f.input.evidence,checkedAt:new Date().toISOString()}}],
    });
    expect(refreshed.source.text).toBe("继续合并和发布");
    expect(refreshed.reviewText).toBe(first.reviewText);
    const changed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"and540-changed",{
      ...input,deliveries:[{...f.input,requiredArtifacts:["web","androidApp"]}],
    });
    expect(()=>f.merges.startConversation(f.owner.id,"original-client",f.identity,changed.id)).toThrow(/完整发布范围/);
    const before=f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get();
    const b=f.merges.startConversation(f.owner.id,"original-client",f.identity,refreshed.id);
    expect(b.sessionId).toBe(f.projectSessionId);
    expect(b.conversation!.authorization.text).toBe("继续合并和发布");
    expect(f.merges.startConversation(f.owner.id,"original-client",f.identity,refreshed.id).id).toBe(b.id);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toEqual(before);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({n:1});
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]!.mergeReady).toBe(false);
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  });
  it("binds a Web decision to one exact scope across fresh preparations and explicit retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared();
    human(f, "看看发布范围");
    const input = { ...scope(f), operation: "merge_and_publish" as const };
    const prepare = (key: string, next = input) => f.merges.prepareConversation(f.owner.id, "original-client", f.identity, key, next);
    const initial = prepare("web-decision-first");
    expect(f.merges.conversationReview(f.owner.id, initial.id)).toMatchObject({ confirmed: false });
    expect(() => f.merges.confirmConversationReview(f.owner.id, initial.id, "a".repeat(64))).toThrow();
    expect(f.merges.confirmConversationReview(f.owner.id, initial.id, initial.reviewDigest)).toEqual({ confirmed: true });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 0 });
    vi.setSystemTime(Date.now() + 10);
    human(f, "你再试下");
    const changed = prepare("web-decision-changed", { ...input, deliveries: [{ ...f.input, requiredArtifacts: ["web", "androidApp"] }] });
    expect(() => f.merges.startConversation(f.owner.id, "original-client", f.identity, changed.id)).toThrow();
    const refreshed = prepare("web-decision-refresh");
    const batch = f.merges.startConversation(f.owner.id, "original-client", f.identity, refreshed.id);
    const replay = prepare("web-decision-replay");
    expect(f.merges.conversationReview(f.owner.id, replay.id)).toMatchObject({ confirmed: true });
    expect(f.merges.confirmConversationReview(f.owner.id, replay.id, replay.reviewDigest)).toEqual({ confirmed: true });
    expect(f.merges.startConversation(f.owner.id, "original-client", f.identity, replay.id).id).toBe(batch.id);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 1 });
  });

  it("rejects a structured retry when a stop shares the retry clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared();
    human(f, "看看发布范围");
    const input = { ...scope(f), operation: "merge_and_publish" as const };
    const prepare = (key: string) => f.merges.prepareConversation(f.owner.id, "original-client", f.identity, key, input);
    const initial = prepare("web-stop-first");
    f.merges.confirmConversationReview(f.owner.id, initial.id, initial.reviewDigest);
    vi.setSystemTime(Date.now() + 10);
    human(f, "停止");
    human(f, "你再试下");
    const retry = prepare("web-stop-retry");
    expect(() => f.merges.startConversation(f.owner.id, "original-client", f.identity, retry.id)).toThrow(/不同输入/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 0 });
  });

  it("accepts a structured confirmation made after the retry input", async () => {
    const f = await prepared();
    human(f, "你再试下");
    const p = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "confirmed-retry",
      { ...scope(f), operation: "merge_and_publish" });
    expect(f.merges.conversationReview(f.owner.id, p.id).targetBranches).toEqual([f.input.targetBranch]);
    f.merges.confirmConversationReview(f.owner.id, p.id, p.reviewDigest);
    expect(f.merges.startConversation(f.owner.id, "original-client", f.identity, p.id).sessionId).toBe(f.projectSessionId);
  });

  it.each([false, true])("retries an unstarted reviewed scope only without intervening stop (%s)", async stopped => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f = await prepared(), sessions = new AgentSessionStore(f.store.database);
    const input = { ...scope(f), operation: "merge_and_publish" as const };
    human(f, "合并和发布");
    const first = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "retry-first", input);
    vi.setSystemTime(Date.now() + 10);
    sessions.recordSnapshot({ nodeId: f.node.nodeId, sessionId: f.projectSessionId, status: "idle", messages: [
      { sourceId: "retry-review", role: "agent", phase: "final_answer", text: first.reviewText, occurredAt: new Date().toISOString() },
    ] });
    vi.setSystemTime(Date.now() + 10);
    human(f, "合并和发布");
    if (stopped) {
      vi.setSystemTime(Date.now() + 10);
      human(f, "停止");
    }
    vi.setSystemTime(Date.now() + 10);
    human(f, "你再试下");
    const retry = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "retry-refreshed", input);
    const start = () => f.merges.startConversation(f.owner.id, "original-client", f.identity, retry.id);
    if (stopped) {
      expect(start).toThrow();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM merge_batches").get()).toMatchObject({ n: 0 });
    } else {
      const batch = start();
      expect(batch.conversation?.authorization.text).toBe("合并和发布");
      expect(batch.conversation?.input.text).toBe("你再试下");
      expect(start().id).toBe(batch.id);
      const fresh = f.merges.prepareConversation(f.owner.id, "original-client", f.identity, "legacy-replay", input);
      expect(f.merges.startConversation(f.owner.id, "original-client", f.identity, fresh.id).id).toBe(batch.id);
    }
  });
  it("refreshes identical reviewed scope without another approval and completes merge-and-publish gates",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f=await prepared(),sessions=new AgentSessionStore(f.store.database);human(f,"准备合并和发布");
    const input={...scope(f),operation:"merge_and_publish" as const};
    const first=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"first-review",input);
    vi.setSystemTime(Date.now()+10);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"whole-scope",role:"agent",phase:"final_answer",text:first.reviewText,occurredAt:new Date(Date.now()-1).toISOString()}]});
    human(f,"批准");
    const refreshed=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"refreshed-checks",{...input,deliveries:[{...f.input,validation:"Reran same checks",evidence:{...f.input.evidence,checkedAt:new Date().toISOString()}}]});
    expect(refreshed.reviewDigest).toBe(first.reviewDigest);expect(refreshed.reviewText).toBe(first.reviewText);
    let b=f.merges.startConversation(f.owner.id,"original-client",f.identity,refreshed.id),id=b.deliveries[0]!;
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>{b=f.merges.integrate(f.owner.id,f.dispatch.id,b.id,b.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Integrated publication",validation:"Combined target",entries:[{deliveryId:id,head:f.input.head,dependsOn:[],group:"one",reason:"Approved scope",validation:"Regression"}]});
    expect(b.entries[0]!.mergeReady).toBe(false);
    act(syntheticPrerequisites(b));
    act({kind:"check",deliveryId:id,expectedHead:f.input.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live Git",checks:"passed",mergeable:"clean",local:"passed",validation:"Passed"});
    expect(b.entries[0]!.mergeReady).toBe(true);
    b=f.merges.report(f.owner.id,f.dispatch.id,b.id,id,{status:"merged",head:f.input.head,commit:"c".repeat(40),detail:"Verified merge"}) as typeof b;
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target",validation:"Combination passed"});
    act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Synthetic adapter"});
    act({kind:"publication_progress",state:"ended",checkedAt:new Date().toISOString(),resultsDigest:b.resultsDigest,detail:"Synthetic adapter ended"});
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    const result=await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"integrated-release",deployedCommit:"c".repeat(40),receiptDigest:"d".repeat(64),items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:event.id,roundKey:event.roundKey,completion:event.completion,releases:[{artifact:"web",version:"test",sourceCommit:"c".repeat(40)}]}]});
    f.safe(result);expect(result.structuredContent?.results,JSON.stringify(result)).toMatchObject([{outcome:"submitted"}]);
    expect(f.merges.finish(f.owner.id,f.dispatch.id,b.id).state).toBe("finished");
  });
  it("checks MCP read/write scope, product access, strict inputs and the original identity",async()=>{
    const f=await prepared();human(f,"执行合并");
    const input={identity:f.identity,idempotencyKey:"mcp-direct",scope:scope(f)};
    f.safe(await f.call("prepare_conversation_integration",input));
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}]){
      const result=await f.call("prepare_conversation_integration",input,options);expect(result.error??result.isError).toBeTruthy();
    }
    const p=f.merges.prepareConversation(f.owner.id,"original-client",f.identity,"mcp-start",scope(f));
    const result=await f.call("start_conversation_integration",{identity:f.identity,preparationId:p.id});f.safe(result);
    const batch=result.structuredContent?.batch as {id:string};
    f.safe(await f.call("get_merge_batch",{dispatchId:f.dispatch.id,batchId:batch.id}));
    expect((await f.call("start_conversation_integration",{identity:f.identity,preparationId:p.id,approved:true})).error??(await f.call("start_conversation_integration",{identity:f.identity,preparationId:p.id,approved:true})).isError).toBeTruthy();
    f.grant(false,true);expect((await f.call("start_conversation_integration",{identity:f.identity,preparationId:p.id})).isError).toBeTruthy();
  });
});
const protectedVerification=(d:{repository:string;targetBranch:string})=>({repository:d.repository,targetBranch:d.targetBranch,rulesSource:"Observed project and platform requirements",rulesDigest:"f".repeat(64),ci:"required" as const,local:"required" as const,reason:"Live required checks cover the pending job",platformRead:"complete" as const,requiredChecks:["build"],observedChecks:["build"],autoMerge:true,protectedChecks:true,mergeMethod:"merge" as const});
const syntheticPrerequisites=(batch:PrerequisiteBatch)=>prerequisitesActionSchema.parse({kind:"prerequisites",checkedAt:new Date().toISOString(),source:"Synthetic bounded publication preflight",
  observation:prerequisiteObservation(batch),context:{base:"b".repeat(40),candidates:"c".repeat(64),tools:"d".repeat(64),capabilities:"e".repeat(64)},
  conditions:["main","installation_integrity","required_capability","authorization","scope"].map(kind=>({id:kind,kind,category:"fact",stage:"pre_merge",required:true,state:"satisfied",
    reason:"Synthetic required facts verified",owner:"Executor",resumeWhen:"Refresh evidence in original batch",dependencies:["base","heads","scope","candidates","tools","capabilities"],
    ...(kind==="authorization"?{authorizationRef:"Synthetic original permission receipt"}:{})}))});
async function prepared(databasePath=":memory:",kind:"codex"|"claude_code"|"opencode"="opencode") {
  const f=await fixture(databasePath), launched=f.launch(kind);
  const claimed=await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:launched.dispatch.id});
  f.safe(claimed);
  const merges=new MergeDeliveries(f.store), input=proposal(f.item.key), identity={dispatchId:launched.dispatch.id};
  const d=merges.propose(f.owner.id,"original-client",identity,"offer",input);
  const config={productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"opencode" as const,mode:"default"};
  return {...f,...launched,merges,input,identity,d,config};
}
describe("AND-423 explicit merge deliveries",()=>{
  it("uses verified no-CI evidence through offer, refresh, batch check and merged handoff",async()=>{
    const {verification:template}=await import("./project-verification-fixture.js");
    const f=await prepared();
    const verification={...template,repository:f.input.repository,targetBranch:f.input.targetBranch};
    f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checks:"not_applicable",verification});
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBeUndefined();
    expect(()=>f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checks:"not_applicable",verification:{...verification,targetBranch:"other"}})).toThrow();
    const current=f.merges.list(f.item.productId,f.owner.id)[0]!;f.merges.decide(f.owner.id,current.id,current.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:current.id,revision:current.revision}],f.config,false,1);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const plan={kind:"plan" as const,base:f.input.evidence.base,summary:"Native workflow",validation:"Smoke",entries:[{deliveryId:current.id,head:current.head,dependsOn:[],group:"one",reason:"Independent",validation:"Smoke"}]};
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"plan",plan);
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,1,"check",{kind:"check",deliveryId:current.id,expectedHead:current.head,base:f.input.evidence.base,checkedAt:new Date().toISOString(),checks:"not_applicable",local:"not_applicable",mergeable:"clean",verification,validation:"Existing manual smoke verified",source:"Live Git fixture"});
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).entries[0]?.mergeReady).toBe(true);
    f.merges.report(f.owner.id,b.dispatchId,b.id,current.id,{status:"merged",head:current.head,commit:"d".repeat(40),detail:"Verified squash merge"});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });

  it("refreshes persisted review blockers on node evidence and expires the earlier quality proof",async()=>{
    const f=await prepared(), now=Date.now();
    vi.useFakeTimers();vi.setSystemTime(now);
    try {
      recordDevelopmentReviews(f.store.database,f.node.nodeId,f.projectSessionId,[],true);
      expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("review_missing");
      const review={version:1,taskId:"review-task",agentKind:"opencode",sessionRef:f.session.sessionRef,requestId:"human",scopeDigest:"c".repeat(64),revision:1,generation:2,
        status:"passed",round:1,base:f.input.evidence.base,repository:f.input.repository,candidateDigest:"d".repeat(64),checksPassed:true,blockingFindings:0,limitations:[],findings:[],requiredChecks:["behavior"],checks:[{name:"behavior",method:"node test",result:"passed",evidence:"exit=0"}],
        reviewer:{sessionRef:"readonly-child",model:"model",provider:"provider",readOnly:true},
        proof:{head:f.input.head,base:f.input.evidence.base,candidateDigest:"d".repeat(64),clean:true,valid:true,checkedAt:new Date(now-240000).toISOString()}};
      recordDevelopmentReviews(f.store.database,f.node.nodeId,f.projectSessionId,[review],true,review.taskId,1);
      expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBeUndefined();
      vi.setSystemTime(now+61000);
      expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("stale");
      recordDevelopmentReviews(f.store.database,f.node.nodeId,f.projectSessionId,[{...review,revision:2,status:"incomplete"}],true,review.taskId,1);
      expect(f.merges.recomputeList(f.item.productId,f.owner.id)[0]?.blocker).toBe("review_incomplete");
    } finally {vi.useRealTimers();}
  });
  it("keeps item status unchanged until verified merge and binds confirmation to its revision",async()=>{
    const f=await prepared();
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    expect(f.d.blocker).toBeUndefined();
    expect(()=>f.merges.decide(f.owner.id,f.d.id,"wrong","confirm")).toThrow();
    expect(()=>f.merges.decide(f.other.id,f.d.id,f.d.revision,"confirm")).toThrow();
    expect(f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm").state).toBe("confirmed");
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  });
  it("invalidates a human confirmation when development continues or head changes",async()=>{
    const f=await prepared();
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Continue changing this feature",[]);
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(()=>f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false)).toThrow();
    const g=await prepared();
    g.merges.decide(g.owner.id,g.d.id,g.d.revision,"confirm");
    expect(g.merges.refresh(g.owner.id,"original-client",g.identity,g.d.id,{...g.input.evidence,head:"c".repeat(40)}).state).toBe("withdrawn");
  });
  it("AND-446 preserves declined attention only for its input turn and reoffers explicitly",async()=>{
    const f=await prepared();
    expect(f.d.reconfirmation).toBe(false);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([f.projectSessionId]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.other.id)).toEqual([]);
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"withdraw");
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([f.projectSessionId]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Ordinary conversation",[]);
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual([]);
    const again=f.merges.propose(f.owner.id,"original-client",f.identity,"offer-again",f.input);
    expect(again).toMatchObject({state:"proposed",reconfirmation:true});
    expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
    expect(()=>f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm")).toThrow();
    expect(f.merges.decide(f.owner.id,again.id,again.revision,"confirm").state).toBe("confirmed");
  });
  it("AND-446 leaves a confirmed offer intact when a new message is rejected",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    expect(()=>new AgentSessionStore(f.store.database).enqueue(f.other.id,f.projectSessionId,"Rejected input",[])).toThrow();
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.state).toBe("confirmed");
  });
  it("serializes batches, retries the same reservation, and never unlocks missing outcomes",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    expect(new AgentSessionStore(f.store.database).listForAccount(f.owner.id).find(row=>row.id===b.sessionId)?.sessionPurpose).toBe("integration");
    // The conversation is named after the integrated work, not its instructions (AND-449).
    expect(f.db.prepare("SELECT session_title FROM free_session_starts WHERE dispatch_id=?").get(b.dispatchId))
      .toMatchObject({session_title:`集成 · ${f.item.key}`});
    expect(f.merges.start(f.owner.id,key,selection,f.config,false).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,key,[{id:f.d.id,revision:"wrong"}],f.config,false)).toThrow();
    expect(()=>f.merges.start(f.owner.id,randomUUID(),selection,f.config,false)).toThrow();
    const dispatches=new DispatchStore(f.store.database);
    dispatches.claimNextDispatch(f.node.nodeId);
    dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow();
    expect(()=>f.merges.report(f.owner.id,f.dispatch.id,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Merged"})).toThrow();
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Verified merge"});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.merges.finish(f.owner.id,b.dispatchId,b.id).state).toBe("finished");
    expect(new AgentSessionStore(f.store.database).getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM dispatch_items WHERE dispatch_id=?").get(b.dispatchId)).toMatchObject({n:0});
  });
  it.each([false,true])("dispatches project-specific workflows and preserves publication boundaries (%s)",async publish=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,publish,1);
    const prompt=(f.db.prepare("SELECT initial_text FROM free_session_starts WHERE dispatch_id=?").get(b.dispatchId) as {initial_text:string}).initial_text;
    for(const text of ["不要求新增配置文件","未开启 auto-merge","项目专用发布前条件","失败","not_applicable","unknown","不得 --admin","精确 executionHead","不手填或补写 authorizationRef","不重复合并","对象/结果/证据与验证缺口/下一步责任","人工验收由人决定"])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain("missiongo-release readiness --candidates");
    expect(prompt).not.toContain("不要逐项等待 CI 通知或手动合并");
    expect(b.publish).toBe(publish);expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const read=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(read.projectWorkflowInstructions).toContain("不要求新增配置文件");
    expect(read.prerequisiteObservation.batchId).toBe(b.id);
  });
  it("preserves confirmation when only same-head evidence refreshes",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checkedAt:new Date(Date.now()-360_000).toISOString()});
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("stale");
    const refreshed=f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,checkedAt:new Date().toISOString()});
    expect(refreshed.state).toBe("confirmed");expect(refreshed.revision).toBe(f.d.revision);
  });
  it.each(["stale", "pending", "failed", "conflicting", "unknown"] as const)("delegates %s evidence to the frozen merge batch",async(reason)=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.refresh(f.owner.id,"original-client",f.identity,f.d.id,{...f.input.evidence,
      ...(reason==="stale"?{checkedAt:new Date(Date.now()-360_000).toISOString()}:reason==="conflicting"?{mergeable:"conflicting" as const}:{checks:reason})});
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe(reason);
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database);
    dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const entry=f.merges.batch(f.owner.id,b.dispatchId,b.id).entries[0]!;
    expect(entry.head).toBe(f.d.head);expect(entry.revision).toBe(f.d.revision);expect(entry.blocker).toBeUndefined();
    expect(()=>f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:"b".repeat(40),commit:"c".repeat(40),detail:"Wrong head"})).toThrow();
  });
  it("keeps the batch usable after safe pre-launch retry changes only its dispatch",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:f.d.id,revision:f.d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database),sessions=new AgentSessionStore(f.store.database);
    const free=new FreeSessionStore(f.store.database,dispatches,sessions);
    free.stop(f.owner.id,b.dispatchId);
    const next=free.retry(f.owner.id,b.dispatchId);
    expect(next.agentSessionId).toBe(b.sessionId);
    expect(sessions.getForAccount(f.owner.id,b.sessionId).sessionPurpose).toBe("integration");
    dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:next.id,status:"launched"});
    expect(f.merges.batch(f.owner.id,next.id,b.id).id).toBe(b.id);
    expect(()=>f.merges.batch(f.owner.id,b.dispatchId,b.id)).toThrow();
  });
  it("reconciles partial success without changing blocked items or repeating completed handoffs",async()=>{
    const f=await prepared();
    const second=f.store.createWorkItem({productId:f.item.productId,title:"Second",description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
    const claim=await f.call("claim_item",{...f.claimInput,itemKey:second.key,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:"second"});f.safe(claim);
    const secondIdentity={sessionId:claim.structuredContent!.sessionId!};
    const d2=f.merges.propose(f.owner.id,"original-client",secondIdentity,"offer-second",{...proposal(second.key),pullRequest:13});
    for(const d of [f.d,d2])f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),[f.d,d2].map(d=>({id:d.id,revision:d.revision})),f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);
    dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const result={status:"merged" as const,head:f.d.head,commit:"c".repeat(40),detail:"Verified integration"};
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,result);
    const events=f.store.getTimeline(f.item.key);
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,result);expect(f.store.getTimeline(f.item.key)).toEqual(events);
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow();
    f.merges.report(f.owner.id,b.dispatchId,b.id,d2.id,{status:"blocked",head:d2.head,detail:"Verified conflict; no merge scheduled"});
    f.merges.finish(f.owner.id,b.dispatchId,b.id);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");expect(f.store.getWorkItem(second.key).status).toBe("in_progress");
  });
  it.each(["operate","ai"])("enforces revoked %s permission at the HTTP and MCP boundaries",async permission=>{
    const f=await prepared();
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
    const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
    f.grant(permission!=="operate",permission!=="ai");
    const response=await f.app.inject({method:"POST",url:`/api/v1/merge-deliveries/${f.d.id}/decision`,headers:{cookie},payload:{revision:f.d.revision,decision:"confirm"}});
    expect(response.statusCode).toBe(404); // Existing product guard hides inaccessible operations.
    const result=await f.call("refresh_merge_delivery",{identity:f.identity,deliveryId:f.d.id,evidence:f.input.evidence});
    expect(result.error || result.isError).toBeTruthy();
    expect(f.merges.list(f.item.productId,f.owner.id)[0]?.state).toBe("proposed");
  });
  it("denies read-only and another client delivery writes",async()=>{
    const f=await prepared();
    for(const options of [{scopes:["missiongo:read"]},{clientId:"other-client"},{accountId:f.other.id}]) {
      const result=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:randomUUID(),delivery:f.input},options);
      expect(result.error || result.isError).toBeTruthy();
    }
  });
  it("confirms immediately on a quoted same-turn instruction and stays idempotent",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"instruction",{...f.input},{quote:"  添加到待合并  "});
    expect(d.state).toBe("confirmed");expect(d.confirmedBy).toBe("session-instruction");expect(d.instructionQuote).toBe("添加到待合并");
    const again=f.merges.propose(f.owner.id,"original-client",f.identity,"instruction",{...f.input},{quote:"添加到待合并"});
    expect(again.state).toBe("confirmed");expect(again.confirmedBy).toBe("session-instruction");
    const b=f.merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],f.config,false);
    expect(b.state).toBe("active");
  });
  it("keeps the confirmation origin explicit and never overwrites it",async()=>{
    const f=await prepared();
    expect(f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm").confirmedBy).toBe("console");
    const g=await prepared();
    const d=g.merges.propose(g.owner.id,"original-client",g.identity,"instruction",{...g.input},{quote:"加入待合并"});
    expect(g.merges.decide(g.owner.id,d.id,d.revision,"confirm").confirmedBy).toBe("session-instruction");
    expect(()=>g.merges.propose(g.owner.id,"original-client",g.identity,"instruction",{...g.input,pullRequest:14},{quote:"加入待合并"})).toThrow();
  });
  // Semantic interpretation remains the Agent's job. These exercise transport and
  // domain effects after a valid current-turn queue instruction has been identified.
  it.each(["添加到待集成", "加入待集成", "提交到待集成", "添加到待合并", "加入待合并", "提交到待合并", "添加到待合成", "添加到待发布"])("queues a current delivery with original wording: %s",async quote=>{
    const f=await prepared();
    const ordered=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-instruction",delivery:f.input,instructionConfirmation:{quote}});
    f.safe(ordered);
    expect(ordered.structuredContent!.delivery).toMatchObject({state:"confirmed",confirmedBy:"session-instruction",instructionQuote:quote});
    const repeated=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-instruction",delivery:f.input,instructionConfirmation:{quote}});
    expect(repeated.structuredContent!.delivery).toMatchObject({id:(ordered.structuredContent!.delivery as {id:string}).id,state:"confirmed",instructionQuote:quote});
    expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    const plain=await f.call("propose_merge_delivery",{identity:f.identity,idempotencyKey:"mcp-plain",delivery:f.input});
    f.safe(plain);
    expect(plain.structuredContent!.delivery).toMatchObject({state:"proposed"});
  });
});

describe("planned integration batches",()=>{
  async function batchFixture(count=1,noRelease=false,publish=false,databasePath=":memory:") {
    const f=await prepared(databasePath),deliveries=[noRelease ? f.merges.propose(f.owner.id,"original-client",f.identity,"no-release-offer",{...f.input,requiredArtifacts:[],noReleaseReason:"Internal merge/CI tools only"}) : f.d];
    for(let i=1;i<count;i++) {
      const item=f.store.createWorkItem({productId:f.item.productId,title:`Related ${i}`,description:"Synthetic integration",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}});
      const claim=await f.call("claim_item",{...f.claimInput,itemKey:item.key,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:`claim-${i}`});f.safe(claim);
      deliveries.push(f.merges.propose(f.owner.id,"original-client",{sessionId:claim.structuredContent!.sessionId!},`offer-${i}`,{...proposal(item.key),pullRequest:12+i}));
    }
    for(const d of deliveries)f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,randomUUID(),deliveries.map(d=>({id:d.id,revision:d.revision})),f.config,publish,1);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const current=()=>new MergeDeliveries(f.store).batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5],key=randomUUID(),revision=current().integration!.revision)=>
      f.merges.integrate(f.owner.id,b.dispatchId,b.id,revision,key,action);
    const plan={kind:"plan" as const,base:"b".repeat(40),summary:"Foundation, dependent feature, independent fix",validation:"Verify the final combined target",entries:deliveries.map((d,i)=>({deliveryId:d.id,head:d.head,dependsOn:i===1?[deliveries[0]!.id]:[],group:i<2?"shared interface":"independent",reason:"Read overlapping changes",validation:"Behavior and compatibility tests"}))};
    const check=(id:string,head="a".repeat(40))=>act({kind:"check",deliveryId:id,expectedHead:head,base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"passed",mergeable:"clean",local:"passed",source:"Synthetic CI",validation:"Local and remote checks passed"});
    const merged=(id:string,head="a".repeat(40))=>f.merges.report(f.owner.id,b.dispatchId,b.id,id,{status:"merged",head,commit:"c".repeat(40),detail:"Verified real merge in synthetic fixture"});
    const finish=()=>{act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Finished original synthetic batch",source:"Synthetic"});return f.merges.finish(f.owner.id,b.dispatchId,b.id);};
    return {...f,b,deliveries,current,act,plan,check,merged,finish};
  }
  it("blocks publishing on registered legacy prerequisites without workflow",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    const action=syntheticPrerequisites(f.current());
    action.conditions.push({id:"legacy-signing",kind:"investigation",category:"blocker",stage:"pre_publish",required:true,state:"unknown",reason:"Signing unavailable",owner:"Original executor",resumeWhen:"Verify signing",dependencies:["scope"]});
    f.act(action);f.merged(d.id);
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Actual target",validation:"Combined smoke passed"});
    expect(f.current().publicationPrerequisiteGate).toMatchObject({required:true,ready:false,blockers:expect.arrayContaining([expect.objectContaining({id:"legacy-signing",code:"pending"})])});
    expect(()=>f.act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Starting existing publisher"})).toThrow(/发布前置/);
  });
  it.each([false,true])("refreshes publication gates in ordinary and cached list responses (large=%s)",async large=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);
    if(large)for(let i=0;i<6;i++)f.act({...f.plan,summary:`Historical plan ${i}: `+"Original evidence history. ".repeat(100)});
    f.check(d.id);
    const action=syntheticPrerequisites(f.current());
    const signing={id:"signing",kind:"investigation" as const,category:"blocker" as const,stage:"pre_publish" as const,required:true,state:"unknown" as const,reason:"Signing unavailable",owner:"Executor",resumeWhen:"Verify signing",dependencies:["scope" as const]};
    action.conditions.push(signing);f.act(action);f.merged(d.id);
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Actual target",validation:"Combined passed"});
    const gates=()=>[f.current().publicationPrerequisiteGate,f.merges.batches(f.item.productId,f.owner.id)[0]!.publicationPrerequisiteGate,
      f.merges.recomputeBatches(f.item.productId,f.owner.id)[0]!.publicationPrerequisiteGate,
      JSON.parse(f.merges.serializeList(f.item.productId,f.owner.id).toString()).batches[0].publicationPrerequisiteGate];
    for(const gate of gates())expect(gate.blockers).toContainEqual(expect.objectContaining({id:"signing",code:"pending"}));
    f.act({...action,observation:f.current().prerequisiteObservation,context:{...action.context,base:"c".repeat(40)},conditions:action.conditions.map(c=>({...c,state:"satisfied"}))});
    for(const gate of gates())expect(gate.ready).toBe(true);
    const raw=JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string}).data_json);
    expect(raw.publicationPrerequisiteGate).toBeUndefined();
    if(large)expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(16*1024);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+301_000);
    try {for(const gate of gates()){expect(gate.ready).toBe(false);expect(gate.blockers).toContainEqual(expect.objectContaining({id:"signing",code:"stale"}));}}
    finally {clock.mockRestore();}
  });
  it("native release tools block publication rather than merge and stay bound to the original repository",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    const old=syntheticPrerequisites(f.current());
    const action=prerequisitesActionSchema.parse({...old,workflow:{tools:"project_native",repositories:[d.repository],source:"Existing project release guide",digest:"f".repeat(64)},context:{base:old.context.base,candidates:old.context.candidates},
      conditions:[...old.conditions.filter(c=>["main","authorization","scope"].includes(c.kind)).map(c=>({...c,dependencies:c.kind==="main"?["base","heads"]:c.kind==="scope"?["scope","candidates"]:["scope"]})),
        {id:"native-tool",kind:"investigation",category:"blocker",stage:"pre_publish",required:true,state:"pending",reason:"Existing publisher unavailable",owner:"Executor",resumeWhen:"Recover existing tool",dependencies:["scope"]}]});
    expect(()=>f.act({...action,workflow:{...action.workflow!,repositories:["https://github.com/other/project"]}})).toThrow();
    f.act(action);expect(f.current().entries[0]!.mergeReady).toBe(true);
    f.merged(d.id);expect(f.current().results[d.id]?.status).toBe("merged");
    expect(f.current().publicationPrerequisiteGate).toMatchObject({required:true,ready:false});
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Actual target",validation:"Combined smoke passed"});
    const publishing=()=>({kind:"publication_progress" as const,state:"publishing" as const,checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Starting native publisher"});
    expect(()=>f.act(publishing())).toThrow(/发布前置/);
    expect(f.current().results[d.id]?.status).toBe("merged");
    f.act({...action,observation:f.current().prerequisiteObservation,context:{...action.context,base:"c".repeat(40)},conditions:[{...action.conditions.at(-1)!,state:"satisfied"}]});

    f.act(publishing());expect(f.current().integration!.publication?.state).toBe("publishing");
  });
  it("records a known exact-head merge after the Git check expires without rechecking publication scope",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    try {
      expect(f.current().entries[0]!.mergeReady).toBe(false);
      f.merged(d.id);
      expect(f.current().results[d.id]?.status).toBe("merged");
    } finally { clock.mockRestore(); }
  });
  it("keeps queue ownership without a duplicated authorization form",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    const queue=()=>f.merges.queue(f.item.productId,f.owner.id);
    expect(queue().deliveries).toEqual([]);
    expect(queue().occupancy).toMatchObject({active:true,sessionId:f.b.sessionId});
    expect(f.current().entries[0]!.mergeReady).toBe(true);
    const wait=syntheticPrerequisites(f.current());
    wait.conditions.find(c=>c.kind==="authorization")!.state="pending";
    f.act(wait);
    expect(f.current().prerequisiteGate.ready).toBe(true);
    expect(queue().deliveries).toEqual([]);
    f.act(syntheticPrerequisites(f.current()));
    expect(f.current().entries[0]!.mergeReady).toBe(true);
    f.merged(d.id);
    expect(queue().deliveries).toEqual([]);
    expect(queue().counts.release??0).toBe(0);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[d.id]!.publication).toBe("pending");
  });
  it("ends derivation fact reuse before permission changes, actions and rollback",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    const publication=()=>f.merges.recomputeBatches(f.item.productId,f.owner.id)[0]!.presentation.entries[d.id]!.publication;
    expect(publication()).toBe("pending");
    f.grant(false);expect(()=>f.merged(d.id)).toThrow();
    f.grant();expect(publication()).toBe("pending");
    expect(()=>f.store.database.transaction(()=>{
      f.db.prepare("UPDATE builder_execution_authorizations SET revoked=1 WHERE item_id=?").run(f.item.id);
      expect(publication()).toBe("unknown");
      expect(()=>f.check(d.id)).toThrow();
      throw new Error("roll back source revocation");
    })).toThrow("roll back source revocation");
    expect(publication()).toBe("pending");
    expect(()=>f.store.database.transaction(()=>{
      f.db.prepare("UPDATE work_items SET builder_account_id=? WHERE item_key=?").run(f.other.id,f.item.key);
      expect(publication()).toBe("unknown");
      expect(()=>f.check(d.id)).toThrow();
      throw new Error("roll back derived facts");
    })).toThrow("roll back derived facts");
    expect(publication()).toBe("pending");
    f.merged(d.id);expect(f.current().results[d.id]!.status).toBe("merged");
  });
  it("keeps account and exact-head CI gates without requiring duplicate authorization",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);
    expect(f.current().entries[0]!.mergeReady).toBe(true);
    const wait=syntheticPrerequisites(f.current());wait.conditions.find(c=>c.kind==="authorization")!.state="pending";
    const before=f.store.getTimeline(f.item.key);
    const input={batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:f.current().integration!.revision,idempotencyKey:"waiting",action:wait};
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}])expect((await f.call("record_merge_integration",input,options)).isError).toBe(true);
    f.safe(await f.call("record_merge_integration",input));f.safe(await f.call("record_merge_integration",input));
    expect(f.current().results).toEqual({});expect(f.store.getTimeline(f.item.key)).toEqual(before);
    expect(f.current().integration!.events.filter(e=>e.id==="waiting")).toHaveLength(1);
    const ready=syntheticPrerequisites(f.current());f.act({...ready,conditions:[ready.conditions.find(c=>c.kind==="authorization")!]});
    expect(f.current().entries[0]!.mergeReady).toBe(true);
    f.act({kind:"check",deliveryId:d.id,expectedHead:d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Actual failed CI",checks:"failed",local:"passed",mergeable:"clean",validation:"Preserve failed check"});
    expect(f.current().prerequisiteGate.ready).toBe(true);expect(f.current().entries[0]!.mergeReady).toBe(false);
    f.check(d.id);f.merged(d.id);expect(f.current().prerequisiteGate.required).toBe(false);
  });
  it("applies a human whole-batch deferral before first merge while retaining merge checks and pending releases",async()=>{
    const f=await batchFixture(2,false,true),first=f.deliveries[0]!,second=f.deliveries[1]!;
    for(const command of f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(f.b.sessionId) as {id:string}[])
      new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"active",messages:[],turnState:{turnActive:true},commandId:command.id,commandStatus:"delivered"});
    f.act(f.plan);f.check(first.id);
    expect(f.current().prerequisiteGate.ready).toBe(true);
    const snapshot=f.merges.preview(f.owner.id,f.b.id).snapshot,key="defer-frozen-batch";
    f.merges.requestReconciliation(f.owner.id,f.b.dispatchId,f.b.id,key,snapshot,{kind:"defer_publication",reason:"Complete the selected integrations; publish later"});
    expect(()=>f.merges.applyReconciliation(f.owner.id,f.b.dispatchId,f.b.id,key)).toThrow(/人工/);
    expect(f.current().publicationPrerequisiteGate.required).toBe(true);
    f.merges.decideReconciliation(f.owner.id,f.b.id,key,snapshot,"approved",true);
    expect(f.current().publicationPrerequisiteGate.required).toBe(true);
    f.merges.applyReconciliation(f.owner.id,f.b.dispatchId,f.b.id,key);
    expect(f.current()).toMatchObject({publish:true,publicationDeferred:true,prerequisiteGate:{required:false,ready:true}});
    f.act({kind:"check",deliveryId:first.id,expectedHead:first.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),
      checks:"failed",local:"passed",mergeable:"clean",source:"Actual failed CI",validation:"A deferral is not permission to merge a failing head"});
    expect(f.current().entries[0]!.mergeReady).toBe(false);expect(()=>f.merged(first.id)).toThrow();
    f.check(first.id);f.grant(false);expect(()=>f.merged(first.id)).toThrow();f.grant();
    f.merged(first.id);f.check(second.id);f.merged(second.id);
    expect(f.current().publicationDeferred).toBe(true);
    f.merges.recordCombinedValidation(f.owner.id,f.b.dispatchId,f.b.id,{head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic actual target",validation:"The merged combination passed"});
    expect(()=>f.act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,
      detail:"Publishing is forbidden after this whole-batch choice"})).toThrow();
    expect(f.finish()).toMatchObject({state:"finished",publish:true,publicationDeferred:true});
    for(const d of f.deliveries)expect(f.store.getWorkItem(d.itemKeys[0]!).status).toBe("development_complete");
    expect(releaseCandidatePage(f.store,f.merges,f.item.productId).candidates).toHaveLength(2);
  });
  it("AND-521 persists waiting across database reopen and replays the original uncertain request",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"and521-resume-")),path=join(dir,"state.sqlite");
    try {
      const f=await batchFixture(1,false,true,path);f.act(f.plan);
      const action=syntheticPrerequisites(f.current());action.conditions[1]!.state="unknown";
      const revision=f.current().integration!.revision;f.act(action,"unknown-response",revision);
      await f.app.close();apps.splice(apps.indexOf(f.app),1);
      const reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});apps.push(reopened);
      const merges=new MergeDeliveries(reopened.missionGoStore),load=()=>merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
      expect(load().integration!.prerequisites!.conditions[1]).toMatchObject({state:"unknown",owner:"Executor",resumeWhen:"Refresh evidence in original batch"});
      merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,revision,"unknown-response",action);
      expect(load().integration!.events.filter(e=>e.id==="unknown-response")).toHaveLength(1);
      expect(load().results).toEqual({});expect(load().state).toBe("active");
      expect(()=>merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,revision,"unknown-response",{...action,source:"Different body"})).toThrow(/idempotencyKey/);
      await reopened.close();apps.splice(apps.indexOf(reopened),1);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("AND-521 leaves pure no-release publication batches free of the publication merge gate",async()=>{
    const f=await batchFixture(1,true,true);f.act(f.plan);f.check(f.deliveries[0]!.id);
    expect(f.current().prerequisiteGate.required).toBe(false);expect(f.current().entries[0]!.mergeReady).toBe(true);
  });
  it("permits a verified no-release row before the batch enters publication",async()=>{
    const f=await batchFixture(2,true,true),first=f.deliveries[0]!;
    f.act(f.plan);f.check(first.id);
    expect(first.requiredArtifacts).toEqual([]);expect(f.current().prerequisiteGate.required).toBe(false);
    expect(f.current().entries.find(e=>e.id===first.id)!.mergeReady).toBe(true);
    f.act(syntheticPrerequisites(f.current()));expect(f.current().entries.find(e=>e.id===first.id)!.mergeReady).toBe(true);
  });
  it("AND-520 owns extra item events exactly and keeps a later offer for the same item independent",async()=>{
    const f=await batchFixture(2);f.act(f.plan);
    for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}f.finish();
    const first=f.deliveries[0]!,extra=f.deliveries[1]!,selection=[{id:first.id,revision:first.revision}];
    const coverageBefore=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(coverageBefore);
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"item-event-ownership",selection,f.config,true,1,false,"publish_only",scope.digest);
    const coverageAfter=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(coverageAfter);expect(coverageAfter.structuredContent!.candidates).toEqual(coverageBefore.structuredContent!.candidates);
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.ownedExtras).toMatchObject([{pendingArtifacts:["web"],publication:"pending"}]);
    const next=f.merges.propose(f.owner.id,"original-client",{sessionId:extra.sessionId},"independent-new-item-delivery",{...proposal(extra.itemKeys[0]!),pullRequest:29});
    f.merges.decide(f.owner.id,next.id,next.revision,"confirm");
    const q=f.merges.queue(f.item.productId,f.owner.id);expect(q.deliveries.map(d=>d.id)).toEqual([next.id]);expect(q.counts.merge).toBe(1);expect(q.counts.release??0).toBe(0);
    expect(q.occupancy).toMatchObject({active:true,sessionId:b.sessionId});
  });
  it("AND-520 audit R1 does not treat a new unmerged offer as the frozen event for the same PR",async()=>{
    const f=await batchFixture(2);f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}f.finish();
    const first=f.deliveries[0]!,extra=f.deliveries[1]!,selection=[{id:first.id,revision:first.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    f.merges.start(f.owner.id,"audit-r1-same-pr",selection,f.config,true,1,false,"publish_only",scope.digest);
    const next=f.merges.propose(f.owner.id,"original-client",{sessionId:extra.sessionId},"same-pr-new-head",{...proposal(extra.itemKeys[0]!),pullRequest:extra.pullRequest,head:"d".repeat(40),evidence:{...extra.evidence,head:"d".repeat(40)}});
    f.merges.decide(f.owner.id,next.id,next.revision,"confirm");
    const q=f.merges.queue(f.item.productId,f.owner.id);expect(q.deliveries.map(d=>d.id)).toEqual([next.id]);expect(q.counts.merge).toBe(1);
  });
  it.each(["content","builder","legacy-builder"])("AND-520 audit R1 shows and rejects changed %s on extra item coverage",async change=>{
    const f=await batchFixture(2);f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}f.finish();
    const first=f.deliveries[0]!,extra=f.deliveries[1]!,key=extra.itemKeys[0]!,selection=[{id:first.id,revision:first.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"audit-r1-extra-scope",selection,f.config,true,1,false,"publish_only",scope.digest);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(f.node.nodeId);ds.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Bound scope",validation:"Verify",entries:[{deliveryId:first.id,head:first.head,dependsOn:[],group:"history",reason:"Frozen",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:first.id,expectedHead:first.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Passed",source:"Synthetic"});
    if(change==="legacy-builder") {
      const raw=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(b.id) as {data_json:string},legacy=JSON.parse(raw.data_json);
      for(const row of legacy.publicationScope.candidates)delete row.itemScope;
      f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(legacy),b.id);
    }
    if(change==="content")f.store.updateWorkItem(key,{description:"A new requirement after freezing",attribution:{accountId:f.owner.id}});
    else f.db.prepare("UPDATE work_items SET builder_account_id=? WHERE item_key=?").run(f.other.id,key);
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id).find(row=>row.id===b.id)!.presentation.ownedExtras).toMatchObject([{publication:"unknown",blocker:expect.any(String)}]);
    expect(()=>act({kind:"publication_progress",state:"publishing",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Must reject changed coverage"})).toThrow(/范围|变化/);
  });
  it("AND-520 audit R3 includes extras in the integrator badge without changing each source's own result",async()=>{
    const f=await batchFixture(2);f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}f.finish();
    const first=f.deliveries[0]!,extra=f.deliveries[1]!,selection=[{id:first.id,revision:first.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"audit-r3-session-outcome",selection,f.config,true,1,false,"publish_only",scope.digest);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(f.node.nodeId);ds.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const release=(key:string)=>{const event=f.store.getDeliveryRecords(key)[0]!;f.store.submitForVerification({itemKey:key,developmentEventId:event.id,completion:event.completion!,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:`audit-r3-${key}`});};
    release(first.itemKeys[0]!);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[b.sessionId]).toBe("publication_partial");
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[first.sessionId]).toBe("published");
    release(extra.itemKeys[0]!);expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[b.sessionId]).toBe("published");
  });
  it("AND-520 keeps an extra frozen event with a missing legacy round in the original batch's visible responsibilities",async()=>{
    const f=await batchFixture(2);f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}f.finish();
    const extra=f.deliveries[1]!,key=extra.itemKeys[0]!,event=f.store.getDeliveryRecords(key)[0]!;
    const first=f.deliveries[0]!,selection=[{id:first.id,revision:first.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"legacy-extra-responsibility",selection,f.config,true,1,false,"publish_only",scope.digest);
    const raw=f.db.prepare("SELECT payload_json FROM work_item_events WHERE id=?").get(event.id) as {payload_json:string},payload=JSON.parse(raw.payload_json);payload.roundKey=null;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(payload),event.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(f.store.workItemId(key));
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id).find(v=>v.id===b.id)!.presentation.ownedExtras).toMatchObject([{publication:"unknown",blocker:expect.stringContaining("已变化")}]);
  });
  it("archives a published old round without borrowing its receipt for rework (AND-501/435)",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    f.store.submitForVerification({itemKey:f.item.key,developmentEventId:event.id,completion:event.completion!,
      releases:[{artifact:"web",version:"old",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:"old-release"});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"Rework",attribution:{accountId:config.id}});
    const before=f.store.getTimeline(f.item.key);
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries[0]!.queue).toMatchObject({stage:"history",resolution:"historical",publishedArtifacts:["web"]});
    expect(f.store.getDeliveryRecords(f.item.key)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
  });
  it("recognizes an exact legacy no-release handover without a development event ID (AND-450)",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
    f.store.submitNonReleaseForVerification({itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,
      developmentEventId:e.handover!.id,roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,
      validation:{checks:[{name:"No release",method:"Synthetic tools",result:"passed",evidence:"Bound event"}],remainingVerification:[],limitations:[]},
      idempotencyKey:"legacy-no-release",attribution:{accountId:f.owner.id}});
    // Reproduce the early persisted receipt shape, using only this isolated fixture DB.
    const receipt=f.store.getTimeline(item.key).find(v=>v.payload.reason==="non_release_submitted")!;
    const legacy={...receipt.payload};delete legacy.developmentEventId;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(item.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(true);
    expect(f.merges.queue(item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(item.productId,f.owner.id,"history").deliveries[0]!.queue).toMatchObject({resolution:"not_required"});
    // The actual AND-450 receipt also lacks a completion reference.
    delete legacy.completion;delete legacy.pullRequestUrl;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(true);
    const validRevision=legacy.revision;
    legacy.revision=-1;
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(false);
    legacy.revision=validRevision;legacy.roundKey="different-round";
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy),receipt.id);
    expect(f.store.getDeliveryRecords(item.key)[0]!.published).toBe(false);
  });
  it("keeps an early human no-release transition in review without inventing formal handover",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"non_release_submitted",attribution:{accountId:config.id}});
    const timeline=f.store.getTimeline(f.item.key),receipt=timeline.find(e=>e.payload.reason==="non_release_submitted")!;
    expect(receipt.actorKind).toBe("human");expect(receipt.payload.developmentEventId).toBeUndefined();
    expect(f.store.getDeliveryRecords(f.item.key)[0]).toMatchObject({id:event.id,published:false});
    const queue=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(queue.counts.review).toBe(1);expect(queue.counts.release??0).toBe(0);
    expect(queue.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:expect.stringContaining("无需发布交接证据")});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
    expect(f.store.getTimeline(f.item.key)).toEqual(timeline);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("separates missing evidence into review and refuses publication selection",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const e=f.store.getDeliveryRecords(f.item.key)[0]!;
    // Simulate a historical import that lost its exact integration identity.
    f.db.prepare("UPDATE work_item_events SET payload_json=json_remove(payload_json,'$.completion','$.pullRequestUrl') WHERE id=?").run(e.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(f.item.id);
    const q=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(q.counts.review).toBe(1);expect(q.counts.release??0).toBe(0);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:expect.any(String)});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
  });
  it.each(["missing","null","unknown"])("keeps %s delivery rounds in review instead of silently archiving",async shape=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const event=f.store.getDeliveryRecords(f.item.key)[0]!;
    const raw=f.db.prepare("SELECT payload_json FROM work_item_events WHERE id=?").get(event.id) as {payload_json:string};
    const payload=JSON.parse(raw.payload_json);
    if(shape==="missing")delete payload.roundKey;else payload.roundKey=shape==="null"?null:"unknown-round";
    f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify(payload),event.id);
    f.db.prepare("INSERT OR IGNORE INTO merge_display_dirty(kind,id) VALUES ('item',?)").run(f.item.id);
    const q=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(q.counts.review).toBe(1);expect(q.counts.history??0).toBe(0);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"review",blocker:"交付处理轮次待核实，请核对原交付。"});
    expect(()=>f.merges.publicationPreview(f.owner.id,f.item.productId,[{id:d.id,revision:d.revision}])).toThrow();
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });
  it("keeps exceptions outside all and starts one scoped read-only investigation across retries",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const before=f.store.getTimeline(f.item.key),status=f.store.getWorkItem(f.item.key).status;
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    const context=f.merges.reviewContext(f.owner.id,d.id),scope=context.queue.review!.scopeDigest;
    const input=()=>f.merges.startReview(f.owner.id,d.id,d.revision,scope,"review-request-stable",f.config);
    const first=input(),sessionId=first.queue.review!.sessionId!;
    expect(input().queue.review!.sessionId).toBe(sessionId);
    expect(()=>f.merges.startReview(f.owner.id,d.id,d.revision,scope,"review-request-stable",{...f.config,mode:"different"})).toThrow();
    expect(f.merges.startReview(f.owner.id,d.id,d.revision,scope,"another-human-click",f.config).queue.review!.sessionId).toBe(sessionId);
    expect(f.db.prepare("SELECT count(*) AS n FROM delivery_reviews").get()).toMatchObject({n:1});
    const start=f.db.prepare("SELECT initial_text,session_title FROM free_session_starts WHERE dispatch_id=(SELECT dispatch_id FROM delivery_reviews WHERE delivery_id=?)").get(d.id) as {initial_text:string;session_title:string};
    expect(start.initial_text).toContain("只读核查");expect(start.initial_text).toContain("不领取或创建条目");expect(start.initial_text).toContain(d.repository);expect(start.session_title).toContain("交付核查");
    expect(()=>f.merges.reviewContext(f.other.id,d.id)).toThrow();
    expect(()=>f.merges.startReview(f.owner.id,d.id,d.revision,"stale","stale-request-key",f.config)).toThrow();
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,first.queue.review!.caseId!,"No further integration")).toThrow(/尚未结束/);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);expect(f.store.getWorkItem(f.item.key).status).toBe(status);
    expect(f.store.getDeliveryRecords(f.item.key)[0]!.published).toBe(false);
  });
  it("requires current project operation/AI grants and original delivery ownership for investigation routes",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const login=async(email:string)=>{const r=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:email,password:"synthetic password"}});return r.headers["set-cookie"]!.toString().split(";")[0]!;};
    const cookie=await login(f.owner.email),otherCookie=await login(f.other.email),path=`/api/v1/merge-deliveries/${d.id}/review`;
    expect((await f.app.inject({method:"GET",url:path,headers:{cookie:otherCookie}})).statusCode).toBe(404);
    const context=f.merges.reviewContext(f.owner.id,d.id);
    const payload={...f.config,revision:d.revision,scopeDigest:context.queue.review!.scopeDigest,requestKey:"route-investigation-key"};
    f.grant(false,true);expect((await f.app.inject({method:"POST",url:path,headers:{cookie},payload})).statusCode).toBe(404);
    f.grant(true,false);expect((await f.app.inject({method:"POST",url:path,headers:{cookie},payload})).statusCode).toBe(404);
    expect(f.db.prepare("SELECT count(*) AS n FROM delivery_reviews").get()).toMatchObject({n:0});
    f.grant();const started=await f.app.inject({method:"POST",url:path,headers:{cookie},payload});expect(started.statusCode).toBe(200);
    expect(started.json().queue.review.sessionId).toBeTypeOf("string");
    const queue=await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue?stage=all`,headers:{cookie}});
    expect(queue.json()).toMatchObject({deliveries:[],counts:{review:1}});
  });
  it("archives only a human-confirmed finished investigation and invalidates closure on scope changes",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;f.act(f.plan);f.check(d.id);f.merged(d.id);f.finish();
    const before=f.store.getTimeline(f.item.key),context=f.merges.reviewContext(f.owner.id,d.id),scope=context.queue.review!.scopeDigest;
    const started=f.merges.startReview(f.owner.id,d.id,d.revision,scope,"finished-review-key",f.config),r=started.queue.review!;
    const dispatchId=(f.db.prepare("SELECT dispatch_id FROM delivery_reviews WHERE id=?").get(r.caseId!) as {dispatch_id:string}).dispatch_id;
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId,status:"launched"});
    const sessions=new AgentSessionStore(f.store.database);sessions.createForDispatch({dispatchId,nodeId:f.node.nodeId,sessionRef:randomUUID()});
    // Synthetic node acknowledgement; no external command is executed.
    f.db.prepare("UPDATE agent_session_commands SET status='delivered',delivered_at=? WHERE session_id=?").run(new Date().toISOString(),r.sessionId!);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:r.sessionId!,status:"idle",turnState:{turnActive:false,waitingForInput:true},messages:[{sourceId:"answer",role:"agent",text:"No product artifact is required. Formal handover is still missing."}]});
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Confirmed no integration work")).toThrow(/尚未结束/);
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:r.sessionId!,status:"idle",turnState:{turnActive:false,waitingForInput:false},messages:[{sourceId:"answer",role:"agent",text:"No product artifact is required. Formal handover is still missing."}]});
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!," ")).toThrow();
    // A settled interrupt must not hide the newer unanswered user message.
    const newerInputAt=new Date(Date.now()+1000).toISOString(),messageId=randomUUID(),stopId=randomUUID();
    f.db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,?,'message','Follow-up','delivered',?)").run(messageId,r.sessionId!,f.owner.id,newerInputAt);
    f.db.prepare("INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at) VALUES (?,?,?,'interrupt','Stop','delivered',?)").run(stopId,r.sessionId!,f.owner.id,new Date(Date.now()+2000).toISOString());
    expect(sessions.getForAccount(f.owner.id,r.sessionId!).command!.kind).toBe("interrupt");
    expect(f.merges.reviewContext(f.owner.id,d.id).latestInputAt).toBe(newerInputAt);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Cannot use an answer from before the follow-up")).toThrow(/尚未结束/);
    f.db.prepare("DELETE FROM agent_session_commands WHERE id IN (?,?)").run(messageId,stopId);

    const closed=f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Confirmed no integration work; preserve missing handover as history");
    expect(closed.queue).toMatchObject({stage:"review",review:{closedAt:expect.any(String),closeNote:expect.any(String)}});
    expect(f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,closed.queue.review!.closeNote!)).toEqual(closed);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Changed conclusion")).toThrow();
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"reviewed").deliveries[0]!.queue.review!.closedAt).toBeTypeOf("string");
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts).toMatchObject({reviewed:1});
    expect(f.store.getDeliveryRecords(f.item.key)[0]!.published).toBe(false);expect(f.store.getTimeline(f.item.key)).toEqual(before);
    // Synthetic delivery revision change keeps the same exception, but expires its conclusion.
    const changedDelivery=JSON.parse((f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(d.id) as {data_json:string}).data_json);
    changedDelivery.revision=randomUUID();
    f.db.prepare("UPDATE merge_deliveries SET data_json=? WHERE id=?").run(JSON.stringify(changedDelivery),d.id);
    expect(f.merges.queue(f.item.productId,f.owner.id,"review").deliveries).toHaveLength(1);
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Old conclusion")).toThrow();
    expect(f.db.prepare("SELECT closed_at FROM delivery_reviews WHERE id=?").get(r.caseId!)).toMatchObject({closed_at:expect.any(String)});
    expect(f.merges.reviewContext(f.owner.id,d.id).previousReviews).toEqual([expect.objectContaining({caseId:r.caseId,closeNote:closed.queue.review!.closeNote})]);
    // A real content edit begins a new delivery round: the obsolete delivery becomes history.
    f.store.updateWorkItem(f.item.key,{title:"Changed item content after exception closure"});
    expect(f.merges.queue(f.item.productId,f.owner.id,"reviewed").deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries[0]!.queue.resolution).toBe("historical");
    expect(()=>f.merges.closeReview(f.owner.id,d.id,scope,r.caseId!,"Old conclusion")).toThrow();
  });
  it("reuses large exact batch templates while returning independent live JSON containers",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string}).data_json);
    raw.integration.plans[0].summary="批次历史：😀 café e\u0301。".repeat(2000);
    raw.integration.events[0].detail=JSON.parse('{"__proto__":{"polluted":true},"constructor":"own","nested":[null,false,4,{"text":"original"}]}');
    const save=()=>f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(raw),f.b.id);
    save();
    const response=(productId=f.item.productId,accountId=f.owner.id,sessionId?:string)=>JSON.parse(f.merges.serializeList(productId,accountId,sessionId).toString("utf8"));
    const expected=()=>JSON.parse(JSON.stringify({deliveries:f.merges.list(f.item.productId,f.owner.id),batches:f.merges.batches(f.item.productId,f.owner.id),
      attentionSessionIds:f.merges.attentionSessionIds(f.item.productId,f.owner.id),sessionProgress:f.merges.sessionProgress(f.item.productId,f.owner.id)}));
    const text=(f.db.prepare("SELECT data_json FROM merge_batch_projection WHERE id=?").get(f.b.id) as {data_json:string}).data_json;
    let parses=0;const parse=JSON.parse,spy=vi.spyOn(JSON,"parse").mockImplementation((input,...args)=>{if(input===text)parses++;return parse(input,...args);});
    try {
      const first=f.merges.batches(f.item.productId,f.owner.id),second=f.merges.batches(f.item.productId,f.owner.id);
      expect(first).toEqual(second);expect(parses).toBe(1);
      expect(first).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
      const detail=first[0]!.integration!.events[0]!.detail as unknown as Record<string,unknown>;
      expect(Object.getPrototypeOf(detail)).toBe(Object.prototype);expect(Object.hasOwn(detail,"__proto__")).toBe(true);
      expect(detail.__proto__).toEqual({polluted:true});expect(({} as Record<string,unknown>).polluted).toBeUndefined();
      first[0]!.integration!.plans[0]!.summary="Caller mutation";
      (detail.nested as unknown[])[3]="Caller nested mutation";
      expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(second);
      expect(response()).toEqual(expected());
      const body=f.merges.serializeList(f.item.productId,f.owner.id);body.fill(0);
      expect(response()).toEqual(expected());
      expect(response(f.item.productId,f.other.id).batches).toEqual([]);
      expect(response("other-product").batches).toEqual([]);
      expect(response(f.item.productId,f.owner.id,f.b.sessionId).batches).toEqual(response().batches);
      expect(f.merges.batches(f.item.productId,f.other.id)).toEqual([]);
      expect(f.merges.batches("other-product",f.owner.id)).toEqual([]);
      expect(f.merges.batches(f.item.productId,f.owner.id,f.b.sessionId)).toEqual(second);
      expect(()=>f.store.database.transaction(()=>{
        raw.integration.plans[0].summary="Synthetic uncommitted history. ".repeat(2000);save();
        // Source projections normally flush at outer commit; explicitly model
        // an in-transaction projection update before rolling the fixture back.
        f.db.prepare("UPDATE merge_batch_projection SET data_json=json_set(data_json,'$.integration.plans[0].summary',?) WHERE id=?").run(raw.integration.plans[0].summary,f.b.id);
        expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.integration!.plans[0]!.summary).toBe(raw.integration.plans[0].summary);
        expect(response()).toEqual(expected());
        throw Error("rollback template input");
      })).toThrow("rollback template input");
      expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(second);
      expect(response()).toEqual(expected());
      save();expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.integration!.plans[0]!.summary).toBe(raw.integration.plans[0].summary);
      // A same-byte-length change must invalidate the template too; neither
      // UTF-8 length nor a row identity is sufficient as a freshness key.
      raw.integration.plans[0].summary="不同历史：😀 café e\u0301。".repeat(2000);save();
      const before=f.merges.batches(f.item.productId,f.owner.id);
      raw.integration.plans[0].summary=raw.integration.plans[0].summary.replace("不","相");save();
      const after=f.merges.batches(f.item.productId,f.owner.id);
      expect(Buffer.byteLength(JSON.stringify(before))).toBe(Buffer.byteLength(JSON.stringify(after)));
      expect(after[0]!.integration!.plans[0]!.summary).toBe(raw.integration.plans[0].summary);
      expect(after).not.toEqual(before);
      expect(response()).toEqual(expected());
    } finally {spy.mockRestore();}
  });
  it("serializes current prerequisite expiry independently of cached large history",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    f.act({...f.plan,summary:"Large history. ".repeat(250),validation:"Verification. ".repeat(250),
      entries:f.plan.entries.map(entry=>({...entry,reason:"Reason. ".repeat(450),validation:"Validation. ".repeat(300)}))});
    f.check(d.id);
    const pre = syntheticPrerequisites(f.current());
    f.act({...pre,conditions:[{...pre.conditions[0]!,id:"project-specific-freeze",kind:"investigation"}]});
    const read=()=>JSON.parse(f.merges.serializeList(f.item.productId,f.owner.id).toString("utf8")).batches[0];
    expect(read().prerequisiteGate.ready).toBe(true);
    const now=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(now+301_000);
    try{expect(read().prerequisiteGate.ready).toBe(false);expect(read().prerequisiteGate.blockers.some((b:{code:string})=>b.code==="stale")).toBe(true);}
    finally{clock.mockRestore();}
    expect(read().prerequisiteGate.ready).toBe(true);
    f.grant(false);
    expect(read()).toEqual(JSON.parse(JSON.stringify(f.merges.batches(f.item.productId,f.owner.id)[0])));
    expect(()=>f.merged(d.id)).toThrow();
    f.grant();expect(read().presentation.entries[d.id].publication).toBe("pending");
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"New input invalidates pending source activity",[]);
    expect(read().presentation.entries[d.id].publication).toBe("unknown");
  });
  it("aggregates session stages with exact expiry, scope and JSON key preservation",async()=>{
    const f=await prepared(),now=Date.now(),session='quoted-"-\\-会话';
    const insert=f.db.prepare("INSERT INTO merge_session_projection VALUES (?,?,?,?,?,?)");
    insert.run(f.item.productId,f.owner.id,session,"publishing",now,"publication_unknown");
    insert.run(f.item.productId,f.owner.id,"future","publishing",now+1000,"publication_partial");
    insert.run(f.item.productId,f.owner.id,"stable","published",null,null);
    insert.run(f.item.productId,f.other.id,"other","merged",null,null);
    insert.run("other-product",f.owner.id,"other-product","merged",null,null);
    const clock=vi.spyOn(Date,"now").mockReturnValue(now);
    try {
      const expected={[session]:"publication_unknown",future:"publishing",stable:"published"};
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(expected);
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id,session)).toEqual({[session]:"publication_unknown"});
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id,"missing")).toEqual({});
      clock.mockReturnValue(now+1000);
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id).future).toBe("publication_partial");
      f.db.prepare("UPDATE merge_session_projection SET stage='merged',expires_at=NULL,expired_stage=NULL WHERE session_id='future'").run();
      expect(f.merges.sessionProgress(f.item.productId,f.owner.id).future).toBe("merged");
    } finally {clock.mockRestore();}
  });
  it("checks live activity only for sensitive pending entries without changing publication semantics",async()=>{
    const f=await batchFixture(2),[pending,published]=f.deliveries;
    f.act(f.plan);for(const d of f.deliveries){f.check(d.id);f.merged(d.id);}
    const release=(d:typeof f.d,key:string)=>{
      const itemKey=d.itemKeys[0]!,event=f.store.getDeliveryRecords(itemKey)[0]!;
      f.store.submitForVerification({itemKey,developmentEventId:event.id,completion:event.completion!,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:key});
    };
    release(published!,"activity-published");
    const queries:string[]=[],prepare=f.db.prepare.bind(f.db);
    const spy=vi.spyOn(f.db,"prepare").mockImplementation(sql=>{if(sql.startsWith("SELECT session_id,activity FROM merge_display_activity"))queries.push(sql);return prepare(sql);});
    try {
      const read=f.merges.batches(f.item.productId,f.owner.id);
      expect(read).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
      expect(queries).toHaveLength(1);expect(queries[0]!.match(/\?/g)).toHaveLength(1);
      new AgentSessionStore(f.store.database).enqueue(f.owner.id,pending!.sessionId,"New pending implementation input",[]);
      const changed=f.merges.batches(f.item.productId,f.owner.id)[0]!;
      expect(changed.presentation.entries[published!.id]!.publication).toBe("published");
      expect(changed.presentation.entries[pending!.id]!.publication).toBe("unknown");
      release(pending!,"activity-complete");queries.length=0;
      const complete=f.merges.batches(f.item.productId,f.owner.id);
      expect(complete[0]!.presentation.entries[pending!.id]!.publication).toBe("published");
      expect(queries).toEqual([]);
      // Every read still returns independent objects; caller changes cannot leak.
      complete[0]!.presentation.entries[published!.id]!.publication="unknown";
      expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[published!.id]!.publication).toBe("published");
    } finally {spy.mockRestore();}
  });
  it("AND-469 shares current stages and preserves history when a new input clears completion",async()=>{
    const f=await batchFixture(), d=f.deliveries[0]!;
    const progress=()=>f.merges.sessionProgress(f.item.productId,f.owner.id);
    expect(progress()).toMatchObject({[d.sessionId]:"merging",[f.b.sessionId]:"merging"});
    expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toContain(d.sessionId);
    f.act(f.plan); f.check(d.id); f.merged(d.id);
    expect(progress()).toMatchObject({[d.sessionId]:"merged",[f.b.sessionId]:"merged"});
    // Repeated reads, new Agent output and a late old human echo do not clear it.
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:d.sessionId,status:"idle",messages:[
      {sourceId:"old-echo",role:"user",text:"Earlier input",occurredAt:"2020-01-01T00:00:00.000Z"},
      {sourceId:"result",role:"agent",text:"Delivery result"}]});
    expect(progress()[f.b.sessionId]).toBe("merged");
    expect(progress()[d.sessionId]).toBe("merged");
    // Saved execution settings clear only that conversation's current label.
    f.db.prepare("UPDATE agent_sessions SET settings_revision=settings_revision+1 WHERE id=?").run(f.b.sessionId);
    expect(progress()[f.b.sessionId]).toBeUndefined();
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]?.results[d.id]?.status).toBe("merged");
    const command=new AgentSessionStore(f.store.database).enqueue(f.owner.id,d.sessionId,"A new adjustment",[]);
    const persisted=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string};
    const boundary=JSON.parse(persisted.data_json).displayBoundaries[d.sessionId];
    f.db.prepare("UPDATE agent_session_commands SET created_at=? WHERE id=?").run(boundary.at,command.id);
    expect(progress()[d.sessionId]).toBeUndefined();
  });
  it("AND-469 reads old completion without inventing a settings baseline or clearing historical facts",async()=>{
    const f=await batchFixture(),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string}).data_json);
    delete raw.displayBoundaries;
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(raw),f.b.id);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("merged");
    f.db.prepare("UPDATE agent_sessions SET settings_revision=2 WHERE id=?").run(d.sessionId);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBeUndefined();
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]?.results[d.id]?.status).toBe("merged");
  });
  it("AND-469 accepts only authorized publication signals, expires them and never treats ended as a receipt",async()=>{
    const f=await batchFixture(1,false,true),d=f.deliveries[0]!;
    const signal=()=>({kind:"publication_progress" as const,state:"publishing" as const,checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Verified release process started"});
    expect(()=>f.act(signal())).toThrow();
    f.act(f.plan);f.check(d.id);f.act(syntheticPrerequisites(f.current()));f.merged(d.id);
    expect(()=>f.act(signal())).toThrow();
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Combination passed",source:"Synthetic actual target"});
    expect(()=>f.act({...signal(),resultsDigest:"0".repeat(64)})).toThrow();
    expect(()=>f.act({...signal(),checkedAt:"2020-01-01T00:00:00.000Z"})).toThrow();
    f.act(signal(),"publication-heartbeat");
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publishing");
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+360_000);
    try { expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publication_unknown"); } finally { clock.mockRestore(); }
    f.act({...signal(),state:"ended"});
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[d.sessionId]).toBe("publication_unknown");
    const g=await batchFixture();g.act(g.plan);g.check(g.deliveries[0]!.id);g.merged(g.deliveries[0]!.id);
    g.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Passed",source:"Fixture"});
    expect(()=>g.act({...signal(),resultsDigest:g.current().resultsDigest})).toThrow();
  });
  it("AND-511 refreshes history when no-release evidence supplements a human pending-verification move",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move without release evidence",attribution:{accountId:config.id}});
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.review??0).toBe(0);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[d.id]!.handover).toMatchObject({pending:true,blocker:expect.stringContaining("无需发布交接证据")});
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release??0).toBe(0);
    const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
    f.store.submitNonReleaseForVerification({itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,
      developmentEventId:e.handover!.id,roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,
      validation:{checks:[{name:"No-release handover",method:"Synthetic merged fixture",result:"passed",evidence:"Exact development event verified"}],remainingVerification:["Human acceptance"],limitations:[]},
      idempotencyKey:"queue-no-release-supplement",attribution:{accountId:f.owner.id}});
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release??0).toBe(0);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toHaveLength(1);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("hands only this active batch's unchanged no-release merged item to verification",async()=>{
    const f=await batchFixture(1,true),d=f.deliveries[0]!;
    const validation={checks:[{name:"Merged target",method:"Verify integration and run checks",result:"passed" as const,evidence:"Synthetic merged Git fixture"}],remainingVerification:["Human review"],limitations:[]};
    const input=()=>{
      const e=f.store.getDevelopmentEvidence(f.item.key),item=f.store.getWorkItem(f.item.key);
      return {itemKey:item.key,completion:e.completion!,expectedRevision:item.revision,developmentEventId:e.handover!.id,
        roundKey:e.roundKey!,evidenceDigest:e.handover!.payload.evidenceDigest as string,validation,idempotencyKey:"batch-no-release",
        attribution:{accountId:f.owner.id,clientId:"original-client"}};
    };
    f.act(f.plan);f.check(d.id);f.merged(d.id);
    const raw=input(),batch={batchId:f.b.id,deliveryId:d.id,expectedRevision:f.current().integration!.revision};
    // An observed merge does not grant a handover whose own development step is blocked.
    const persisted=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id) as {data_json:string};
    const blocked=JSON.parse(persisted.data_json);
    blocked.reconciliation.handoffs[f.item.key].status="blocked";
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(blocked),f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw)).toThrow();
    f.db.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(persisted.data_json,f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.dispatch.id,batch,raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.other.id,f.b.dispatchId,batch,raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,{...batch,expectedRevision:0},raw)).toThrow();
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,{...raw,itemKey:"CON-999"})).toThrow();
    expect(f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw).status).toBe("pending_verification");
    expect(f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,batch,raw).status).toBe("pending_verification");
    const events=f.store.getTimeline(f.item.key).filter(e=>e.toStatus === "pending_verification");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({reason:"non_release_submitted",mergeBatchId:f.b.id,deliveryId:d.id,authorizationBasis:"merge_non_release_handover",validation});
    f.act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic merged target",validation:"Combination verified"});
    f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    expect(()=>f.merges.submitNonRelease(f.owner.id,f.b.dispatchId,{...batch,expectedRevision:f.current().integration!.revision},raw)).toThrow();
  });
  it("plans dependencies, repairs a regression, waits for CI and reconciles the complete combination",async()=>{
    const f=await batchFixture(3),[a,b,c]=f.deliveries;
    expect(()=>f.check(a!.id)).toThrow();
    expect(()=>f.act({...f.plan,entries:f.plan.entries.slice(1)})).toThrow();
    expect(()=>f.act({...f.plan,entries:[f.plan.entries[1]!,f.plan.entries[0]!,f.plan.entries[2]!]})).toThrow();
    f.act(f.plan);f.check(b!.id);expect(()=>f.merged(b!.id)).toThrow();
    f.check(a!.id);f.merged(a!.id);
    expect(f.current().integration!.entries[b!.id]!.check).toBeUndefined();
    const reservation=f.act({kind:"prepare_repair",deliveryId:b!.id,expectedHead:b!.head,base:"c".repeat(40),reason:"Fix shared interface regression"},"repair-reservation");
    expect(reservation.integration!.entries[b!.id]!.repair!.id).toBe("repair-reservation");
    const repair={kind:"repair" as const,deliveryId:b!.id,expectedHead:b!.head,repairId:"repair-reservation",head:"d".repeat(40),commits:["d".repeat(40)],validation:"Regression reproduced then fixed",source:"Synthetic verified commit chain"};
    expect(()=>f.act({...repair,expectedHead:"e".repeat(40)})).toThrow();
    expect(()=>f.act({...repair,repairId:"unrelated"})).toThrow();
    const rev=f.current().integration!.revision;f.act(repair,"repair-result",rev);f.act(repair,"repair-result",rev);
    expect(f.current().integration!.entries[b!.id]!.repairs).toHaveLength(1);
    expect(f.current().entries.find(d=>d.id===b!.id)).toMatchObject({head:b!.head,executionHead:repair.head});
    f.act({kind:"check",deliveryId:b!.id,expectedHead:repair.head,base:"c".repeat(40),checkedAt:new Date().toISOString(),checks:"pending",verification:protectedVerification(b!),mergeable:"clean",local:"passed",source:"CI still running",validation:"Wait for CI"});
    expect(f.current().entries.find(d=>d.id===b!.id)?.mergeReady).toBe(true);
    expect(()=>f.merged(b!.id,repair.head)).toThrow();
    // Independent work can proceed while a dependent repair is waiting.
    f.check(c!.id);f.merged(c!.id);
    f.check(b!.id,repair.head);f.merged(b!.id,repair.head);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    f.act({kind:"final_validation",head:"f".repeat(40),checkedAt:new Date().toISOString(),validation:"Combined behavior and repository checks passed",source:"Target main at verified head"});
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.current().integration!.plans).toHaveLength(1);
    expect(f.current().integration!.finalValidation).toBeDefined();
  });
  it("admits auto-merge with pending CI only when local checks and conflict checks pass, without admitting a merged report",async()=>{
    const f=await batchFixture(1),d=f.deliveries[0]!;
    f.act(f.plan);
    const check={kind:"check" as const,deliveryId:d.id,expectedHead:d.head,base:"c".repeat(40),checkedAt:new Date().toISOString(),checks:"pending" as const,verification:protectedVerification(d),mergeable:"clean" as const,local:"passed" as const,source:"Live CI and local checks",validation:"GitHub required checks own the actual merge"};
    for(const change of [{checks:"failed" as const},{checks:"unknown" as const},{local:"failed" as const},{local:"pending" as const},{mergeable:"conflicting" as const},{mergeable:"unknown" as const}]) {
      f.act({...check,...change});
      expect(f.current().entries.find(e=>e.id===d.id)?.mergeReady).toBe(false);
      expect(()=>f.merged(d.id)).toThrow();
    }
    f.act({...check,verification:undefined});
    expect(f.current().entries.find(e=>e.id===d.id)?.mergeReady).toBe(false);
    f.act(check);
    expect(f.current().entries.find(e=>e.id===d.id)?.mergeReady).toBe(true);
    expect(()=>f.merged(d.id)).toThrow();
    f.check(d.id);
    f.merged(d.id);
    expect(f.current().results[d.id]?.status).toBe("merged");
  });
  it("rejects stale writes, changed source scope, cross-session calls and altered retries",async()=>{
    const f=await batchFixture();f.act(f.plan,"plan");
    // Reusing a key for a different body is reported as a key conflict, not as a
    // changed delivery: the generic code sent integrators to the PR and the item.
    let keyConflict: unknown;
    try { f.act({...f.plan,summary:"Different"},"plan",0); } catch (error) { keyConflict = error; }
    expect((keyConflict as {code?:string})?.code).toBe("merge_integration_idempotency_conflict");
    let staleWrite: unknown;
    try { f.act(f.plan,"stale",0); } catch (error) { staleWrite = error; }
    expect((staleWrite as {code?:string})?.code).toBe("merge_delivery_changed");
    expect(()=>f.merges.integrate(f.other.id,f.b.dispatchId,f.b.id,1,"other",f.plan)).toThrow();
    expect(()=>f.merges.integrate(f.owner.id,f.dispatch.id,f.b.id,1,"source-session",f.plan)).toThrow();
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}]) {
      const result=await f.call("record_merge_integration",{batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:1,idempotencyKey:randomUUID(),action:f.plan},options);
      expect(result.error||result.isError).toBeTruthy();
    }
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Change the delivery",[]);
    expect(()=>f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Repair"})).toThrow();
  });
  it("persists unknown repairs and rejects stale checks without unlocking the batch",async()=>{
    const f=await batchFixture();f.act(f.plan);
    f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Investigate and repair"},"reserved");
    expect(f.current().integration!.entries[f.d.id]!.repair?.id).toBe("reserved");
    expect(()=>f.check(f.d.id)).toThrow();expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    expect(()=>f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Unknown push outcome"})).toThrow();
  });
  it("records a plan through MCP and safely cancels only a proven unpushed repair",async()=>{
    const f=await batchFixture();
    const input={batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:0,idempotencyKey:"mcp-plan",action:f.plan};
    f.safe(await f.call("record_merge_integration",input));f.safe(await f.call("record_merge_integration",input));
    expect(f.current().integration!.plans).toHaveLength(1);
    f.act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Bound investigation"},"reservation");
    const cancel={kind:"cancel_repair" as const,deliveryId:f.d.id,expectedHead:f.d.head,repairId:"reservation",observedHead:f.d.head,noExecutionRemaining:true as const,reason:"No change was pushed",source:"Remote head checked and no process remains"};
    expect(()=>f.act({...cancel,observedHead:"e".repeat(40)})).toThrow();
    f.act(cancel);expect(f.current().integration!.entries[f.d.id]!.repair).toBeUndefined();
    const check={kind:"check" as const,deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),checks:"failed" as const,mergeable:"clean" as const,local:"passed" as const,source:"Synthetic CI",validation:"Actual failure"};
    f.act(check);expect(()=>f.merged(f.d.id)).toThrow();
    expect(()=>f.act({...check,checkedAt:new Date(Date.now()-360_000).toISOString()})).toThrow();
    f.grant(true,false);
    const denied=await f.call("record_merge_integration",{...input,idempotencyKey:"revoked",expectedRevision:f.current().integration!.revision});
    expect(denied.error||denied.isError).toBeTruthy();
  });
  it("recovers exact historical authorization without replacing the batch or changing retry parameters",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const setPrompt=(text:string)=>f.store.database.connection.prepare("UPDATE free_session_starts SET initial_text=? WHERE dispatch_id=?").run(text,b.dispatchId);
    for(const prompt of [legacyIntegratorPrompt("different-batch",false),legacyIntegratorPrompt(b.id,true),legacyIntegratorPrompt(b.id,false)+" extra instructions"]) {
      setPrompt(prompt);expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    }
    setPrompt(legacyIntegratorPrompt(b.id,false));
    f.store.database.connection.prepare("UPDATE free_session_starts SET ready=0 WHERE dispatch_id=?").run(b.dispatchId);
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    f.store.database.connection.prepare("UPDATE free_session_starts SET ready=1 WHERE dispatch_id=?").run(b.dispatchId);
    f.store.database.connection.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify({...b,state:"finished"}),b.id);
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).integration).toBeUndefined();
    f.store.database.connection.prepare("UPDATE merge_batches SET data_json=? WHERE id=?").run(JSON.stringify(b),b.id);
    const restored=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(restored.integration?.recoveredAuthorization?.dispatchId).toBe(b.dispatchId);
    expect(restored.entries[0]!.mergeReady).toBe(false);
    const action={kind:"plan" as const,base:"b".repeat(40),summary:"Recover existing authorization",validation:"Combined verification",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Original scope",validation:"Check repaired head"}]};
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"recover-plan",action);
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"recover-plan",action);
    const loaded=new MergeDeliveries(f.store).batch(f.owner.id,b.dispatchId,b.id);
    expect(loaded.integration!.plans).toHaveLength(1);expect(loaded.integration!.recoveredAuthorization).toEqual(restored.integration!.recoveredAuthorization);
    expect(f.merges.start(f.owner.id,key,selection,f.config,false).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,key,selection,f.config,false,1)).toThrow();
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,1,"recover-repair",{kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Recover verified original-session repair"});
    f.merges.integrate(f.owner.id,b.dispatchId,b.id,2,"recover-head",{kind:"repair",deliveryId:f.d.id,expectedHead:f.d.head,repairId:"recover-repair",head:"e".repeat(40),commits:["e".repeat(40)],validation:"Git chain checked",source:"Synthetic historical recovery"});
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).entries[0]!.executionHead).toBe("e".repeat(40));
  });
  it("does not silently grant repair authority to legacy batches or retries",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const key=randomUUID(),selection=[{id:f.d.id,revision:f.d.revision}];
    const b=f.merges.start(f.owner.id,key,selection,f.config,false);
    expect(()=>f.merges.start(f.owner.id,key,selection,f.config,false,1)).toThrow();
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    expect(()=>f.merges.integrate(f.owner.id,b.dispatchId,b.id,0,"legacy",{kind:"progress",deliveryId:f.d.id,expectedHead:f.d.head,phase:"investigating",detail:"Read"})).toThrow();
  });
});

describe("AND-439 batch reconciliation",()=>{
  async function recoveryFixture(options:{mixed?:boolean;publish?:boolean;protocol?:1;artifacts?:string[];historical?:boolean;agentKind?:"codex"|"claude_code"|"opencode"}={}) {
    const f=await fixture();
    if(options.historical) {
      const admins=f.accounts.projectAdministratorIds(f.item.productId);
      f.accounts.replaceProjectAdministrators(f.item.productId,[...admins,f.owner.id],admins,config.id);
      for(const to of ["in_progress","development_complete","in_progress"] as const)f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to,reason:"manual_override",note:"Historical human state before current development",attribution:{accountId:f.owner.id}});
    }
    const launched=f.launch(options.agentKind??"opencode"),merges=new MergeDeliveries(f.store);
    const keys=[f.item.key];
    if(options.mixed)keys.push(f.store.createWorkItem({productId:f.item.productId,title:"Other row",description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}).key);
    for(const itemKey of keys)f.safe(await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:launched.dispatch.id,itemKey,idempotencyKey:`claim-${itemKey}`}));
    const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"offer",{...proposal(f.item.key),itemKeys:keys,...(options.artifacts?{requiredArtifacts:options.artifacts}:{})});
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:options.agentKind??"opencode",mode:"default"},options.publish??false,options.protocol);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(launched.node.nodeId);ds.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    // Model the node receiving the batch before it can call its recovery tools.
    const batchSessions=new AgentSessionStore(f.store.database);
    for(const command of f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(b.sessionId) as {id:string}[])
      batchSessions.recordSnapshot({nodeId:launched.node.nodeId,sessionId:b.sessionId,status:"idle",messages:[],turnState:{turnActive:false},commandId:command.id,commandStatus:"delivered"});
    const preview=()=>merges.preview(f.owner.id,b.id);
    const request=(action:Parameters<MergeDeliveries["requestReconciliation"]>[5],key=randomUUID())=>{
      const snapshot=preview().snapshot;merges.requestReconciliation(f.owner.id,b.dispatchId,b.id,key,snapshot,action);return {key,snapshot};
    };
    const approve=(r:{key:string;snapshot:string})=>merges.decideReconciliation(f.owner.id,b.id,r.key,r.snapshot,"approved",true,preview().reconciliation?.requests.find(row=>row.id===r.key)?.publicationScope?.digest);
    const apply=(key:string)=>merges.applyReconciliation(f.owner.id,b.dispatchId,b.id,key);
    const merged=()=>{
      if(options.publish)merges.integrate(f.owner.id,b.dispatchId,b.id,0,"preflight",syntheticPrerequisites(merges.batch(f.owner.id,b.dispatchId,b.id)));
      return merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Verified Git fixture"});
    };
    const evidence={head:"e".repeat(40),commit:"c".repeat(40),targetHead:"f".repeat(40),source:d.pullRequestUrl,checkedAt:new Date().toISOString(),checks:"passed" as const,local:"passed" as const,originalIncluded:true as const,targetIncludesMerge:true as const,validation:"Synthetic external merge and local validation"};
    const final=()=>merges.recordCombinedValidation(f.owner.id,b.dispatchId,b.id,{head:"f".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic actual target",validation:"Combined regression passed"});
    return {...f,...launched,merges,d,b,keys,preview,request,approve,apply,merged,evidence,final};
  }
  async function continuationFixture() {
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Continue without publication"});
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"synthetic password"}});
    const headers={cookie:login.headers['set-cookie']!.toString().split(';')[0]!};
    const url=`/api/v1/merge-batches/${f.b.id}/reconciliation`;
    const send=()=>f.app.inject({method:"POST",url:`${url}/${r.key}/decision`,headers,
      payload:{snapshot:r.snapshot,decision:"approved",reviewConfirmed:true,continueInSession:true}});
    const read=()=>f.app.inject({method:"GET",url,headers});
    return {...f,r,send,read};
  }
  it("continues an approved card through a valid durable key exactly once, including after delivery",async()=>{
    const f=await continuationFixture();
    const first=await f.send();expect(first.statusCode,first.body).toBe(200);
    expect(first.json().continuation).toMatchObject({queued:true,state:"queued"});
    const id=first.json().continuation.commandId;
    expect((await f.send()).json().continuation.commandId).toBe(id);
    expect((await f.read()).json().continuations[f.r.key]).toMatchObject({state:"queued",commandId:id});
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],
      turnState:{turnActive:false},commandId:id,commandStatus:"delivered"});
    expect((await f.read()).json().continuations[f.r.key]).toMatchObject({state:"delivered",commandId:id});
    expect((await f.send()).json().continuation).toMatchObject({state:"delivered",commandId:id});
    expect(f.db.prepare("SELECT count(*) AS n FROM agent_session_commands WHERE session_id=? AND text LIKE '本次集成决定已批准%'").get(f.b.sessionId)).toEqual({n:1});
    expect(f.preview().reconciliation!.history.filter(row=>row.action==="approved")).toHaveLength(1);
  });
  it("persists a pending-message reason without losing approval, then retries once the blocker clears",async()=>{
    const f=await continuationFixture(),sessions=new AgentSessionStore(f.store.database);
    const prior=sessions.enqueue(f.owner.id,f.b.sessionId,"An existing reply",[],false,randomUUID());
    expect((await f.send()).json().continuation).toMatchObject({queued:false,state:"failed",reason:"pending"});
    expect(f.preview().reconciliation!.requests[0]?.decision).toBe("approved");
    expect((await f.read()).json().continuations[f.r.key]).toEqual({state:"failed",reason:"pending"});
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],turnState:{turnActive:false},commandId:prior.id,commandStatus:"delivered"});
    expect((await f.send()).json().continuation).toMatchObject({queued:true,state:"queued"});
  });
  it.each(["archived","revoked","failed","cancelled","delivery_unknown"])("preserves a precise %s result across reads",async(kind)=>{
    const f=await continuationFixture();
    if(kind==="archived")f.db.prepare("UPDATE agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(),f.b.sessionId);
    if(kind==="revoked") {
      // Exercise the enqueue authorization guard without changing the human decision scope.
      const guard=vi.spyOn(AgentSessionStore.prototype,"enqueue").mockImplementationOnce(()=>{throw new MissionGoError("builder_execution_revoked","private diagnostic",409);});
      try {expect((await f.send()).json().continuation).toMatchObject({state:"failed",reason:"revoked"});}finally{guard.mockRestore();}
    } else if(kind==="archived")expect((await f.send()).json().continuation).toMatchObject({state:"failed",reason:"archived"});
    else {
      const id=(await f.send()).json().continuation.commandId;
      f.db.prepare("UPDATE agent_session_commands SET status=? WHERE id=?").run(kind,id);
      expect((await f.send()).json().continuation).toMatchObject({state:kind,commandId:id,...(kind==="failed"?{reason:"delivery_failed"}:{})});
    }
    const read=await f.read();expect(read.json().continuations[f.r.key]).toMatchObject({state:["archived","revoked"].includes(kind)?"failed":kind});
    expect(read.body).not.toContain("private diagnostic");
  });
  it("retains an accepted send when execution changes the snapshot, but never sends a new stale request",async()=>{
    for(const accepted of [false,true]) {
      const f=await continuationFixture();f.approve(f.r);
      const id=accepted?(await f.send()).json().continuation.commandId:undefined;
      f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Changed execution observation"});
      const result=(await f.send()).json().continuation;
      const read=(await f.read()).json().continuations[f.r.key];
      if(accepted) {expect(result).toMatchObject({state:"queued",commandId:id});expect(read).toMatchObject({state:"queued",commandId:id});}
      else {expect(result).toMatchObject({state:"failed",reason:"scope_changed"});expect(read).toMatchObject({state:"failed",reason:"scope_changed"});}
    }
  });
  it("exposes a safe generic failure and never leaks internal errors into a continuation",async()=>{
    const f=await continuationFixture(),guard=vi.spyOn(AgentSessionStore.prototype,"enqueue").mockImplementationOnce(()=>{throw new Error("private diagnostic secret");});
    try {
      const response=await f.send();expect(response.json().continuation).toMatchObject({queued:false,state:"failed",reason:"send_failed"});
      expect(response.body).not.toContain("private diagnostic secret");
      expect((await f.read()).json().continuations[f.r.key]).toEqual({state:"failed",reason:"send_failed"});
    } finally {guard.mockRestore();}
  });
  it("does not notify an applied or changed decision and never enqueues from a plain approval",async()=>{
    const f=await continuationFixture();f.approve(f.r);f.apply(f.r.key);
    expect((await f.send()).json().continuation).toMatchObject({queued:false,state:"failed",reason:"scope_changed"});
    expect((await f.read()).json().continuations[f.r.key]).toBeUndefined();
    expect(f.db.prepare("SELECT count(*) AS n FROM agent_session_commands WHERE session_id=? AND text LIKE '本次集成决定已批准%'").get(f.b.sessionId)).toEqual({n:0});
  });
  it("AND-521 lets an old batch record prerequisites without acquiring repair authority",async()=>{
    const f=await recoveryFixture({publish:true}),action=syntheticPrerequisites(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id));
    expect(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id).integration).toBeUndefined();
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"legacy-prerequisites",action);
    const b=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    expect(b.integration!.prerequisitesOnly).toBe(true);expect(b.entries[0]!.mergeReady).toBe(true);
    expect(()=>f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,b.integration!.revision,"legacy-repair",{kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Cannot expand legacy authority"})).toThrow(/未授权/);
    expect(f.merges.start(f.owner.id,f.b.requestKey,f.b.selection,f.b.config,true).id).toBe(f.b.id);
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
  });
  it("keeps actual merge versions and target identity in the human review",async()=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    const text=f.preview().reconciliation!.requests.find(q=>q.id===r.key)!.reviewText!;
    expect(text).toContain(`/?console=agent&session=${encodeURIComponent(f.b.sessionId)}&mergeReview=`);
    for(const value of [f.d.repository,f.d.targetBranch,f.evidence.head,f.evidence.commit,f.evidence.targetHead,f.evidence.validation,f.evidence.source])expect(text).toContain(value);
  });
  it("records one bound native recovery decision without performing recovery or trusting an Agent attestation",async()=>{
    const f=await recoveryFixture();
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    const name="request_merge_reconciliation_approval";
    const input={batchId:f.b.id,requestId:r.key,snapshot:r.snapshot,idempotencyKey:"native-recovery-approval"};
    const nativeMeta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"opencode",version:"fixture"},"io.modelcontextprotocol/clientCapabilities":{elicitation:{form:{}}}};
    const first=await f.call(name,input,{native:{_meta:nativeMeta}});
    expect(first,JSON.stringify(first)).toMatchObject({resultType:"input_required",requestState:expect.any(String)});
    expect(JSON.stringify(first.inputRequests)).toContain("实际恢复前仍由原会话核实");
    expect(f.preview().entries[0]?.result).toBeUndefined();
    const native={_meta:nativeMeta,requestState:first.requestState,inputResponses:{humanConfirmation:{action:"accept",content:{}}}};
    expect((await f.call(name,{...input,noExecutionRemaining:true},{native})).isError).toBe(true);
    expect(await f.call(name,input,{native})).toMatchObject({structuredContent:{approved:true,source:"native"}});
    expect(f.preview().reconciliation?.requests.find(x=>x.id===r.key)?.decision).toBe("approved");
    expect(f.preview().entries[0]?.result).toBeUndefined();
    expect(f.store.getWorkItem(f.item.key).status).toBe("in_progress");
    expect(await f.call(name,input,{native:{_meta:nativeMeta}})).toMatchObject({structuredContent:{approved:true,source:"existing"}});
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM native_human_confirmations").get()).toEqual({n:1});
    f.apply(r.key);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
  });
  it("reads without mutation and requires human authorization bound to the exact snapshot",async()=>{
    const f=await recoveryFixture(),before=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id);
    expect(f.preview().entries[0]).toMatchObject({originalHead:f.d.head,executionHead:f.d.head});
    const read=await f.call("get_review_content",{kind:"recovery",id:f.b.id},{scopes:["missiongo:read"]});
    expect(read.isError,JSON.stringify(read)).not.toBe(true);
    expect(JSON.parse(read.structuredContent!.text as string)).toMatchObject({snapshot:f.preview().snapshot});
    expect((await f.call("get_review_content",{kind:"recovery",id:f.b.id},{accountId:f.other.id,scopes:["missiongo:read"]})).isError).toBe(true);

    expect(f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id)).toEqual(before);
    const action={kind:"accept_merge" as const,deliveryId:f.d.id,evidence:f.evidence},r=f.request(action);
    expect(()=>f.apply(r.key)).toThrow(/人工/);
    expect(()=>f.merges.decideReconciliation(f.other.id,f.b.id,r.key,r.snapshot,"approved",true)).toThrow();
    expect(()=>f.merges.decideReconciliation(f.owner.id,f.b.id,r.key,r.snapshot,"approved",false)).toThrow();
    expect(()=>f.merges.requestReconciliation(f.owner.id,f.b.dispatchId,f.b.id,r.key,r.snapshot,{...action,evidence:{...f.evidence,head:"f".repeat(40)}})).toThrow();
    f.approve(r);f.apply(r.key);const timeline=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(timeline);expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.preview().entries[0]).toMatchObject({originalHead:f.d.head,result:{head:f.evidence.head,commit:f.evidence.commit}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();f.final();
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("keeps blocked history while accepting an externally merged result",async()=>{
    const f=await recoveryFixture();
    const blocked={status:"blocked" as const,head:f.d.head,detail:"Verified dependency failure"};
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,blocked);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);
    expect(f.preview().reconciliation?.history).toContainEqual(expect.objectContaining({action:"accept_merge",previous:blocked}));
    expect(f.preview().entries[0]?.result?.status).toBe("merged");
  });
  it("retries a blocked delivery in the original batch and preserves the old outcome",async()=>{
    const f=await recoveryFixture();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Old obstacle"});
    const r=f.request({kind:"retry_blocked",deliveryId:f.d.id,reason:"Obstacle resolved"});f.approve(r);f.apply(r.key);
    expect(f.preview().entries[0]?.result).toBeUndefined();expect(f.preview().reconciliation?.history.at(-1)?.previous).toMatchObject({status:"blocked"});
    f.merged();f.final();expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it.each(["codex","claude_code","opencode"] as const)("restores %s consent only from authenticated exact source history",async agentKind=>{
    const f=await recoveryFixture({publish:true,agentKind});
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));
    const r=f.request({kind:"defer_publication",reason:"Publish later"});vi.useRealTimers();
    const sessions=new AgentSessionStore(f.store.database);sessions.createForDispatch({dispatchId:f.b.dispatchId,nodeId:f.node.nodeId,sessionRef:"native-integrator"});
    const request=f.preview().reconciliation!.requests.find(q=>q.id===r.key)!,now=Date.now()-3000;
    expect(f.merges.recoverConversationDecision(f.owner.id,f.b.dispatchId,f.b.id,r.key).code).toBe("history_incomplete");
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"active",turnState:{turnActive:true},messages:[
      {sourceId:"review",role:"agent",phase:"final_answer",turnId:"review-turn",text:request.reviewText!,occurredAt:new Date(now+1).toISOString()},
      {sourceId:"consent",role:"user",turnId:"next-turn",text:"同意",occurredAt:new Date(now+2).toISOString()}]});
    new AgentHistory(f.store.database,new AgentArtifacts(f.store.database,"")).observe(f.owner.id,f.node.nodeId,f.b.sessionId,{complete:true});
    expect(f.merges.recoverConversationDecision(f.owner.id,f.b.dispatchId,f.b.id,r.key)).toMatchObject({code:"restored",decision:"approved"});
    expect(f.merges.recoverConversationDecision(f.owner.id,f.b.dispatchId,f.b.id,r.key).code).toBe("already_decided");
    expect(f.preview().reconciliation!.requests[0]?.decisionSource).toEqual({kind:"native_history",sourceId:"consent"});
  });
  it.each(["quoted","same-turn","wrong-review","commentary","missing-clock","oversized-questions"])("keeps native %s evidence unapproved",async change=>{
    const f=await recoveryFixture({publish:true,agentKind:"codex"});
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()-5000));
    const r=f.request({kind:"defer_publication",reason:"Publish later"});vi.useRealTimers();
    const sessions=new AgentSessionStore(f.store.database);sessions.createForDispatch({dispatchId:f.b.dispatchId,nodeId:f.node.nodeId,sessionRef:"native-integrator"});
    const row=f.preview().reconciliation!.requests.find(q=>q.id===r.key)!,now=Date.now()-3000;
    const display={sourceId:"review",role:"agent" as const,phase:change==="commentary"?"commentary":"final_answer",turnId:"one",text:row.reviewText!+(change==="wrong-review"?" additional scope":""),occurredAt:new Date(now+1).toISOString()};
    const user={sourceId:"consent",role:"user" as const,turnId:change==="same-turn"?"one":"two",text:change==="quoted"?"他说同意":"同意",occurredAt:new Date(now+2).toISOString()};
    sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[display,user]});
    new AgentHistory(f.store.database,new AgentArtifacts(f.store.database,"")).observe(f.owner.id,f.node.nodeId,f.b.sessionId,{complete:true});
    if(change==="oversized-questions")f.db.prepare("UPDATE agent_session_messages SET questions_json=CAST(zeroblob(?) AS TEXT) WHERE session_id=? AND source_id='review'").run(32*1024*1024+1,f.b.sessionId);
    if(change==="missing-clock")f.db.prepare("DELETE FROM session_message_times WHERE session_key=?").run(`dispatch:${f.b.dispatchId}`);
    expect(f.merges.recoverConversationDecision(f.owner.id,f.b.dispatchId,f.b.id,r.key).code).toBe(["missing-clock","oversized-questions"].includes(change)?"history_incomplete":"evidence_missing");
    expect(f.preview().reconciliation!.requests[0]?.decision).toBeUndefined();
  });
  it("records a visible Web card decision and its original queued reply atomically through HTTP",async()=>{
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Publish later"});
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"owner@example.test",password:"synthetic password"}});
    const headers={cookie:login.headers['set-cookie']!.toString().split(';')[0]!};
    const reviewed=await f.app.inject({method:"POST",url:`/api/v1/merge-batches/${f.b.id}/reconciliation/${r.key}/review`,headers,payload:{snapshot:r.snapshot}});expect(reviewed.statusCode,reviewed.body).toBe(200);
    const payload={text:"同意",attachmentIds:[],requestKey:randomUUID()};
    const send=()=>f.app.inject({method:"POST",url:`/api/v1/agent-sessions/${f.b.sessionId}/commands`,headers,payload});
    const a=await send();expect(a.statusCode,a.body).toBe(201);const b=await send();expect(b.json().id).toBe(a.json().id);
    expect(f.preview().reconciliation!.requests[0]).toMatchObject({decision:"approved",decisionSource:{kind:"conversation",commandId:a.json().id}});
    const later=f.request({kind:"defer_publication",reason:"A later distinct decision"});
    f.merges.reviewReconciliation(f.owner.id,f.b.id,later.key,later.snapshot);
    const replay=await send();expect(replay.json().id).toBe(a.json().id);
    expect(f.preview().reconciliation!.requests.find(row=>row.id===later.key)?.decision).toBeUndefined();
  });
  it("binds conversation approval to a displayed card and commits it with the human send",async()=>{
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Exact scope"});
    f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot);
    expect(()=>f.merges.conversationReply(f.owner.id,f.b.sessionId,"同意",[],()=>{throw new Error("Queue unavailable");})).toThrow("Queue unavailable");
    expect(f.preview().reconciliation?.requests[0]?.decision).toBeUndefined();
    const c=f.merges.conversationReply(f.owner.id,f.b.sessionId,"同意",[],()=>new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.b.sessionId,"同意",[]));
    expect(f.preview().reconciliation?.requests[0]).toMatchObject({decision:"approved",decisionSource:{kind:"conversation",commandId:c.id}});
    expect(()=>f.apply(r.key)).toThrow(/命令/);
  });
  it("records an explicit refusal without granting approval or applying recovery",async()=>{
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Exact scope"});
    f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot);
    f.merges.conversationReply(f.owner.id,f.b.sessionId,"不同意",[],()=>new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.b.sessionId,"不同意",[]));
    expect(f.preview().reconciliation!.requests[0]?.decision).toBe("rejected");
    expect(()=>f.apply(r.key)).toThrow(/人工/);
  });
  it.each(["如果没问题就同意","他说同意","同意？"])("does not interpret ambiguous or quoted input %s as approval",async text=>{
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Exact scope"});
    f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot);
    f.merges.conversationReply(f.owner.id,f.b.sessionId,text,[],()=>({id:"human-message"}));
    expect(f.preview().reconciliation?.requests[0]?.decision).toBeUndefined();
  });
  it("refuses unseen, stale, ambiguous and revoked conversation approvals",async()=>{
    const f=await recoveryFixture({publish:true}),r=f.request({kind:"defer_publication",reason:"Exact scope"});
    const reply=()=>f.merges.conversationReply(f.owner.id,f.b.sessionId,"同意",[],()=>({id:"human-message"}));
    reply();expect(f.preview().reconciliation?.requests[0]?.decision).toBeUndefined();
    f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.b.sessionId,"Discuss first",[]);
    reply();expect(f.preview().reconciliation?.requests[0]?.decision).toBeUndefined();
    f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot);
    f.request({kind:"defer_publication",reason:"Another decision"});reply();
    expect(f.preview().reconciliation?.requests.every(r=>!r.decision)).toBe(true);
    f.grant(false);expect(()=>f.merges.reviewReconciliation(f.owner.id,f.b.id,r.key,r.snapshot)).toThrow();
  });
  it("recovers a finished original batch only after explicit authorization",async()=>{
    const f=await recoveryFixture();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"Obstacle"});f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.b.sessionId,"Review this recovery",[]);
    expect(()=>f.approve(r)).not.toThrow();
    expect(()=>f.apply(r.key)).toThrow(/命令/);
    const pending=f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(f.b.sessionId) as {id:string}[];
    for(const command of pending)new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],turnState:{turnActive:false},commandId:command.id,commandStatus:"delivered"});
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.b.sessionId,status:"idle",messages:[],turnState:{turnActive:false}});
    f.approve(r);f.apply(r.key);
    expect(f.preview().state).toBe("active");expect(f.preview().batchId).toBe(f.b.id);
  });
  it("persists Git success and independent handoffs, then appends missing evidence for manual completion",async()=>{
    const f=await recoveryFixture({mixed:true,publish:true});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"manual_override",note:"Human advancement",attribution:{accountId:config.id}});
    const human=f.store.getDevelopmentEvidence(f.item.key).handover!;
    f.merged();expect(f.preview().entries[0]?.result?.status).toBe("merged");
    expect(f.store.getWorkItem(f.keys[1]!).status).toBe("development_complete");
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("blocked");
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);f.apply(r.key);
    expect(f.store.getDevelopmentEvidence(f.item.key).handover).toEqual(human);
    expect(f.store.getDevelopmentReleaseScope(f.item.key)).toEqual(["web"]);
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(listing);
    const rows=listing.structuredContent!.candidates as Array<Record<string,unknown>>;
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.completion&&row.developmentEventId)).toBe(true);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const clean=rows.map(({requiredArtifacts:_artifacts,...row})=>({...row,releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}));
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"release-after-evidence",deployedCommit:"f".repeat(40),receiptDigest:"e".repeat(64),items:clean}));
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("preserves held items while completing other rows of the same PR",async()=>{
    const f=await recoveryFixture({mixed:true});f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"on_hold",reason:"request_human_input",note:"Human hold",executionDisposition:"keep_running",attribution:{accountId:config.id}});
    f.merged();expect(f.store.getWorkItem(f.item.key).status).toBe("on_hold");expect(f.store.getWorkItem(f.keys[1]!).status).toBe("development_complete");
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.detail).toMatch(/暂缓/);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/交接/);
  });
  it.each(["before-approval","after-approval"])("rejects concurrent changes %s",async phase=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});
    if(phase==="after-approval")f.approve(r);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"manual_override",note:"Concurrent move",attribution:{accountId:config.id}});
    expect(()=>phase==="after-approval"?f.apply(r.key):f.approve(r)).toThrow();expect(f.preview().entries[0]?.result).toBeUndefined();
  });
  it("rejects scope conflicts and preserves advanced states",async()=>{
    const f=await recoveryFixture();f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human verification",attribution:{accountId:config.id}});
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("rejects replay after permissions are revoked",async()=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.grant(true,false);
    expect(()=>f.apply(r.key)).toThrow();expect(()=>f.merges.recordCombinedValidation(f.owner.id,f.b.dispatchId,f.b.id,{head:"f".repeat(40),checkedAt:new Date().toISOString(),source:"Fixture",validation:"Passed"})).toThrow();
  });
  it("requires a human publication decision and retains the selected publication intent",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const r=f.request({kind:"defer_publication",reason:"Wait for device validation"});expect(()=>f.apply(r.key)).toThrow();f.approve(r);f.apply(r.key);
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toMatchObject({state:"finished",publish:true});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
  });
  async function publicationRefreshFixture() {
    const f=await recoveryFixture({publish:true,protocol:1,historical:true});
    const historical=f.item,old=f.store.getDevelopmentEvidence(f.item.key).handover!.id;
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id).integration!.revision,randomUUID(),action);
    act({kind:"plan",base:"b".repeat(40),summary:"Original merged scope",validation:"Combination",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Original scope",validation:"Regression"}]});
    act(syntheticPrerequisites(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id)));
    act({kind:"check",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),local:"passed",checks:"passed",mergeable:"clean",source:f.d.pullRequestUrl,validation:"Exact head local and CI passed"});
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Verified actual merge"});
    const scope=f.preview().publicationRefresh!;
    const gap=scope.candidates.find(row=>row.developmentEventId===old)!;
    const action={kind:"allow_partial_publication" as const,reason:"Resume the original merged batch; retain historical evidence warnings",publicationRefresh:{scopeDigest:scope.digest,historicalGaps:[{identity:gap.identity,reason:"Earlier manual completion lacks integration and scope; current merged delivery remains included"}]}};
    return {...f,scope,gap,action,historical};
  }
  it("uses applied recovery review for manual acceptance without fabricating historical publication",async()=>{
    const f=await publicationRefreshFixture(),r=f.request(f.action);
    const reviewed=()=>previouslyReviewedHistoricalGaps(f.store.database,f.item.productId,[f.gap],f.owner.id);
    f.approve(r);expect(reviewed().size).toBe(0);
    f.apply(r.key);expect(reviewed().has(f.gap.identity)).toBe(true);
    const record=f.store.getDeliveryRecords(f.item.key).find(row=>row.id!==f.gap.developmentEventId)!;
    expect(f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"recovery-published",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),attribution:{accountId:f.owner.id,clientId:"original-client"},
      items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:record.id,roundKey:record.roundKey!,completion:record.completion!,releases:record.requiredArtifacts!.map(artifact=>({artifact,version:"1",sourceCommit:"e".repeat(40)}))}]}).results[0]?.outcome).toBe("submitted");
    f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",expectedRevision:f.store.getWorkItem(f.item.key).revision,attribution:{accountId:f.owner.id}});
    expect(f.store.getWorkItem(f.item.key).status).toBe("done");
    expect(f.store.getDeliveryRecords(f.item.key).find(row=>row.id===f.gap.developmentEventId)?.published).toBe(false);
  });
  it("refreshes complete publication scope only after exact human approval without rewriting historical evidence",async()=>{
    const f=await publicationRefreshFixture(),before=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id),oldEvidence=f.store.getDevelopmentEvidence(f.historical.key,f.gap.developmentEventId);
    expect(f.scope.candidates).toHaveLength(2);
    expect(()=>f.request({...f.action,publicationRefresh:{...f.action.publicationRefresh,scopeDigest:"0".repeat(64)}})).toThrow();
    expect(()=>f.request({...f.action,publicationRefresh:{...f.action.publicationRefresh,historicalGaps:[...f.action.publicationRefresh.historicalGaps,...f.action.publicationRefresh.historicalGaps]}})).toThrow();
    expect(()=>f.request({...f.action,publicationRefresh:{...f.action.publicationRefresh,historicalGaps:[...f.action.publicationRefresh.historicalGaps,{identity:"unknown-event",reason:"Not part of the snapshot"}]}})).toThrow();
    expect(()=>f.request({...f.action,publicationRefresh:{...f.action.publicationRefresh,historicalGaps:[]}})).toThrow(/历史缺证/);
    const known=f.scope.candidates.find(row=>row.identity!==f.gap.identity)!;
    expect(()=>f.request({...f.action,publicationRefresh:{...f.action.publicationRefresh,historicalGaps:[...f.action.publicationRefresh.historicalGaps,{identity:known.identity,reason:"Cannot hide this"}]}})).toThrow(/不能/);
    const r=f.request(f.action);expect(()=>f.apply(r.key)).toThrow(/人工/);
    const frozen=f.preview().reconciliation!.requests.find(row=>row.id===r.key)!.publicationScope!;
    expect(frozen.candidates.find(row=>row.identity===f.gap.identity)?.historicalGapReason).toBeTruthy();
    expect(()=>f.merges.decideReconciliation(f.owner.id,f.b.id,r.key,r.snapshot,"approved",true)).toThrow(/完整审阅/);
    expect(()=>f.merges.decideReconciliation(f.owner.id,f.b.id,r.key,r.snapshot,"approved",true,"0".repeat(64))).toThrow(/完整审阅/);
    f.approve(r);f.apply(r.key);f.apply(r.key);
    const after=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    expect(after.results).toEqual(before.results);expect(after.selection).toEqual(before.selection);expect(after.deliveries).toEqual(before.deliveries);
    expect(after.publicationScope).toEqual(frozen);
    expect(f.store.getDevelopmentEvidence(f.historical.key,f.gap.developmentEventId)).toEqual(oldEvidence);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    f.final();
    const live=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,live.integration!.revision,"publish-after-scope-refresh",{kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:live.resultsDigest,detail:"Exact scope and current merged result checked"});
    f.final();
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const page=(await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true})).structuredContent!;
    const rows=page.candidates as Array<Record<string,unknown>>;
    const {requiredArtifacts:_artifacts,...current}=rows.find(row=>row.itemKey===f.item.key&&row.developmentEventId!==f.gap.developmentEventId)!;
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"publish-current-only",deployedCommit:"f".repeat(40),receiptDigest:"e".repeat(64),items:[{...current,releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}]}));
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/仍在发布/);
    const ended=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,ended.integration!.revision,"publication-ended",{kind:"publication_progress",state:"ended",checkedAt:new Date().toISOString(),resultsDigest:ended.resultsDigest,detail:"Synthetic publication and handover completed"});
    f.final();expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.store.getDevelopmentEvidence(f.historical.key,f.gap.developmentEventId)).toEqual(oldEvidence);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("requires the displayed frozen scope digest on the authenticated Web recovery route",async()=>{
    const f=await publicationRefreshFixture(),r=f.request(f.action);
    const scope=f.preview().reconciliation!.requests.find(row=>row.id===r.key)!.publicationScope!;
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}}),cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
    const decide=(digest?:string)=>f.app.inject({method:"POST",url:`/api/v1/merge-batches/${f.b.id}/reconciliation/${r.key}/decision`,headers:{cookie},payload:{snapshot:r.snapshot,decision:"approved",noExecutionRemaining:true,...(digest?{publicationScopeDigest:digest}:{})}});
    expect((await decide()).statusCode).toBe(409);expect((await decide("0".repeat(64))).statusCode).toBe(409);
    expect(f.preview().reconciliation!.requests.find(row=>row.id===r.key)!.decision).toBeUndefined();
    const approved=await decide(scope.digest);expect(approved.statusCode,approved.body).toBe(200);
    f.apply(r.key);expect(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id).publicationScope).toEqual(scope);
  });
  it.each(["before-approval","after-approval"])("rejects a changed full candidate snapshot %s",async phase=>{
    const f=await publicationRefreshFixture(),r=f.request(f.action);
    if(phase==="after-approval")f.approve(r);
    const added=f.store.createWorkItem({productId:f.item.productId,title:"New unresolved release candidate",description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
    f.store.transitionWorkItem({itemKey:added.key,actor:"human",to:"development_complete",reason:"manual_override",note:"New candidate",attribution:{accountId:config.id}});
    expect(()=>phase==="after-approval"?f.apply(r.key):f.approve(r)).toThrow();
    expect(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id).publicationScope?.digest).not.toBe(f.preview().reconciliation!.requests.find(row=>row.id===r.key)!.publicationScope!.digest);
  });
  it("exposes scoped MCP recovery without any agent approval tool",async()=>{
    const f=await recoveryFixture(),snapshot=f.preview().snapshot;
    f.safe(await f.call("get_merge_reconciliation",{batchId:f.b.id}));
    const input={batchId:f.b.id,dispatchId:f.b.dispatchId,idempotencyKey:"mcp-recovery",snapshot,action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}};
    f.safe(await f.call("request_merge_reconciliation",input));f.safe(await f.call("request_merge_reconciliation",input));
    expect((await f.call("apply_merge_reconciliation",{batchId:f.b.id,dispatchId:f.b.dispatchId,requestId:input.idempotencyKey})).isError).toBe(true);
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}])expect((await f.call("request_merge_reconciliation",{...input,idempotencyKey:randomUUID()},options)).isError).toBe(true);
    const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}}),cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
    const approved=await f.app.inject({method:"POST",url:`/api/v1/merge-batches/${f.b.id}/reconciliation/${input.idempotencyKey}/decision`,headers:{cookie},payload:{snapshot,decision:"approved",noExecutionRemaining:true}});
    expect(approved.statusCode,approved.body).toBe(200);f.safe(await f.call("apply_merge_reconciliation",{batchId:f.b.id,dispatchId:f.b.dispatchId,requestId:input.idempotencyKey}));
  });
  it("recovers through the old tool catalogue without minting approval or changing ordinary progress",async()=>{
    const f=await recoveryFixture({protocol:1});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"plan",{kind:"plan",base:"b".repeat(40),summary:"Plan",validation:"Combined",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Fixture",validation:"Regression"}]});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,1,"ordinary",{kind:"progress",deliveryId:f.d.id,expectedHead:f.d.head,phase:"investigating",detail:"request recovery after investigation"});
    expect(f.preview().reconciliation?.requests).toBeUndefined();
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"External merged head differs"});
    const snapshot=f.preview().snapshot;
    const transport=(key:string,payload:unknown,head=f.d.head,revision=3)=>({batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:revision,idempotencyKey:key,
      action:{kind:"progress",deliveryId:f.d.id,expectedHead:head,phase:"investigating",detail:recoveryDetailPrefix+JSON.stringify(payload)}});
    const input=transport("old-request",{operation:"request",snapshot,action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}});
    const loaded=await f.call("get_merge_batch",{batchId:f.b.id,dispatchId:f.b.dispatchId});f.safe(loaded);
    expect(loaded.structuredContent!.recovery).toMatchObject({snapshot});expect(loaded.structuredContent!.recoveryTransport).toMatchObject({tool:"record_merge_integration"});
    for(const options of [{scopes:["missiongo:read"]},{accountId:f.other.id}])expect((await f.call("record_merge_integration",input,options)).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,dispatchId:randomUUID()})).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,expectedRevision:1})).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("stale",{operation:"request",snapshot:"0".repeat(64),action:{kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence}}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("other-delivery",{operation:"request",snapshot,action:{kind:"accept_merge",deliveryId:randomUUID(),evidence:f.evidence}}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",{...input,idempotencyKey:"ordinary"})).isError).toBe(true);
    f.safe(await f.call("record_merge_integration",input));f.safe(await f.call("record_merge_integration",input));
    expect(f.preview().snapshot).toBe(snapshot);expect(f.preview().reconciliation?.requests).toHaveLength(1);
    const applying=transport("old-apply",{operation:"apply",requestId:"old-request"});
    expect((await f.call("record_merge_integration",applying)).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("approve",{operation:"approve",requestId:"old-request"}))).isError).toBe(true);
    expect((await f.call("record_merge_integration",transport("bad-json",{operation:"apply",requestId:"old-request",decision:"approved"}))).isError).toBe(true);
    expect(f.preview().entries[0]?.result?.status).toBe("blocked");
    f.approve({key:"old-request",snapshot});f.safe(await f.call("record_merge_integration",applying));
    const after=f.preview(),timeline=f.store.getTimeline(f.item.key);
    f.safe(await f.call("record_merge_integration",applying));
    expect(f.preview()).toEqual(after);expect(f.store.getTimeline(f.item.key)).toEqual(timeline);
    expect((await f.call("record_merge_integration",{...applying,action:{...applying.action,expectedHead:"0".repeat(40)}})).isError).toBe(true);
    f.grant(false);expect((await f.call("record_merge_integration",applying)).isError).toBe(true);f.grant();
    expect(after.entries[0]).toMatchObject({originalHead:f.d.head,executionHead:f.evidence.head,result:{status:"merged"}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow();
    f.safe(await f.call("record_merge_integration",{batchId:f.b.id,dispatchId:f.b.dispatchId,expectedRevision:4,idempotencyKey:"old-final",
      action:{kind:"final_validation",head:f.evidence.targetHead,checkedAt:new Date().toISOString(),source:"Synthetic target checks",validation:"Combined check passed"}}));
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("settles an existing reservation through external evidence without claiming it as a repair",async()=>{
    const f=await recoveryFixture({protocol:1});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"plan",{kind:"plan",base:"b".repeat(40),summary:"Plan",validation:"Combined",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Fixture",validation:"Regression"}]});
    f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,1,"reserved",{kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Original reservation"});
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);
    const current=f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id);
    expect(current.integration?.entries[f.d.id]?.repairs).toEqual([]);expect(current.integration?.entries[f.d.id]?.repair).toBeUndefined();
    expect(f.preview().reconciliation?.history).toContainEqual(expect.objectContaining({action:"external_merge_settled_reservation",previous:expect.objectContaining({id:"reserved"})}));
    f.final();expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("retains exact legacy authorization during read-only preview and staged recovery",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("UPDATE free_session_starts SET initial_text=? WHERE dispatch_id=?").run(legacyIntegratorPrompt(f.b.id,false),f.b.dispatchId);
    const before=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id);
    f.preview();expect(f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(f.b.id)).toEqual(before);
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.final();
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("appends another verified integration without overwriting the earlier completion metadata",async()=>{
    const f=await recoveryFixture();
    f.store.submitDevelopmentComplete({itemKey:f.item.key,completion:{kind:"github",url:"https://github.com/example/project/pull/99"},requiredArtifacts:["androidApp"],idempotencyKey:"different-completion",attribution:{accountId:f.owner.id}});
    f.merged();const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);const before=f.store.getTimeline(f.item.key);f.apply(r.key);
    expect(f.store.getTimeline(f.item.key).slice(0,before.length)).toEqual(before);
    expect(f.store.getDeliveryRecords(f.item.key)).toHaveLength(2);
    expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("completed");
  });
  it("does not treat manual verification without release receipts as published",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move",attribution:{accountId:config.id}});
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布凭据/);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).not.toBe("published");
  });
  it("does not let later conversation input block an independently published unchanged delivery",async()=>{
    const f=await recoveryFixture({publish:true});f.merged();
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});
    const row=(listing.structuredContent!.candidates as Record<string,unknown>[])[0]!;
    const {requiredArtifacts:_scope,...candidate}=row;
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"published",deployedCommit:"f".repeat(40),receiptDigest:"a".repeat(64),
      items:[{...candidate,releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}]}));
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[f.d.sessionId]).toBe("published");
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.d.sessionId,"Discuss next work",[]);
    expect(f.merges.sessionProgress(f.item.productId,f.owner.id)[f.d.sessionId]).toBeUndefined();
    expect(f.preview().entries[0]?.items[0]?.blocker).toBeUndefined();
    const before=f.store.getTimeline(f.item.key);
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"New rework",attribution:{accountId:config.id}});
    expect(f.preview().entries[0]?.items[0]?.blocker).toBeTruthy();
    const display=f.merges.batches(f.item.productId,f.owner.id).find(b=>b.id===f.b.id)!.presentation.entries[f.d.id]!;
    expect(display.publication).toBe("published");
    expect(display.releases).toMatchObject([{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]);
  });
  it("closes the original external-merge batch after supplementing a manually advanced item",async()=>{
    const f=await recoveryFixture({publish:true,artifacts:["web","androidApp"]});
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,{status:"blocked",head:f.d.head,detail:"External head differs"});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"development_complete",reason:"resolution_submitted",attribution:{accountId:config.id}});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"release_verified",attribution:{accountId:config.id}});
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.d.sessionId,"Next discussion",[]);
    const item=f.preview().entries[0]!.items[0]!;
    expect(item.missingPublicationEvidence).toBe(true);expect(item.blocker).toBeTruthy();
    const statuses=f.store.getTimeline(f.item.key).filter(e=>e.eventType==="status_changed");
    f.safe(await f.call("submit_release_batch",{productId:f.item.productId,idempotencyKey:"manual-published",deployedCommit:"f".repeat(40),receiptDigest:"a".repeat(64),
      items:[{itemKey:f.item.key,expectedRevision:item.revision,developmentEventId:item.developmentEventId,roundKey:item.roundKey,
        completion:{kind:"github",url:f.d.pullRequestUrl},releases:[{artifact:"web",version:"test",sourceCommit:"f".repeat(40)}]}]}));
    const r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);f.apply(r.key);f.final();
    expect(f.preview().entries[0]?.items[0]).toMatchObject({status:"pending_verification",missingPublicationEvidence:false,handoff:{status:"completed"}});
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    expect(f.store.getTimeline(f.item.key).filter(e=>e.eventType==="status_changed")).toEqual(statuses);
  });
  it("does not heal a rejected delivery or reuse stale supplement evidence",async()=>{
    const f=await recoveryFixture();f.merged();
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"pending_verification",reason:"manual_override",note:"Human move",attribution:{accountId:config.id}});
    f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to:"ready",reason:"verification_failed",note:"Rejected",attribution:{accountId:config.id}});
    const r=f.request({kind:"retry_handover",deliveryId:f.d.id});f.approve(r);f.apply(r.key);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");expect(f.preview().reconciliation?.handoffs[f.item.key]?.status).toBe("blocked");
  });
  it("refuses recovery when the original batch node is revoked",async()=>{
    const f=await recoveryFixture(),r=f.request({kind:"accept_merge",deliveryId:f.d.id,evidence:f.evidence});f.approve(r);
    f.db.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(),f.node.nodeId);
    expect(()=>f.apply(r.key)).toThrow();expect(f.preview().entries[0]?.result).toBeUndefined();
  });

});

it("reads delivery content on read-only scope without confirming, and denies another account or revoked scope",async()=>{
  const f=await prepared();
  const args={kind:"delivery",id:f.d.id};
  const read=await f.call("get_review_content",args,{scopes:["missiongo:read"]});
  expect(read.isError,JSON.stringify(read)).not.toBe(true);
  expect(JSON.parse(read.structuredContent!.text as string)).toMatchObject({summary:f.input.summary,validation:f.input.validation,state:"proposed"});
  expect((await f.call("get_review_content",args,{accountId:f.other.id,scopes:["missiongo:read"]})).isError).toBe(true);
  f.grant(true,false);
  const denied=await f.call("get_review_content",args,{scopes:["missiongo:read"]});
  expect(denied.isError ?? Boolean(denied.error)).toBe(true);
  expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
});

it("AND-460 projects delivery-only attention consistently and keeps later independent instructions", async () => {
  const f = await prepared(), sessions = new AgentSessionStore(f.store.database);
  const login = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: f.owner.email, password: "synthetic password" } });
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]! };
  const list = async () => (await f.app.inject({ method: "GET", url: "/api/v1/agent-sessions", headers })).json().sessions[0];
  const snapshot = (sourceId: string, text: string) => sessions.recordSnapshot({ nodeId: f.node.nodeId, sessionId: f.projectSessionId,
    status: "idle", messages: [{ sourceId, role: "agent", phase: "final_answer", text }] });
  snapshot("delivery", "代码与检查已完成，请发起合并。");
  const first = sessions.pendingAttention(f.projectSessionId)!;
  expect(sessions.completeAttention(f.projectSessionId, first.messageHash, { needsAttention: true, kind: "instruction", reason: "等待发起合并", model: "synthetic", deliveryOnly: true })).toBe(true);
  expect(await list()).toMatchObject({ needsAttention: false, attention: { state: "needed", handledByDelivery: true, reason: "等待发起合并" } });
  f.merges.decide(f.owner.id, f.d.id, f.d.revision, "confirm");
  expect((await list()).needsAttention).toBe(false);
  f.merges.decide(f.owner.id, f.d.id, f.d.revision, "withdraw");
  expect((await list()).needsAttention).toBe(false);
  snapshot("independent", "请决定另一项独立安排。");
  const second = sessions.pendingAttention(f.projectSessionId)!;
  expect(sessions.completeAttention(f.projectSessionId, second.messageHash, { needsAttention: true, kind: "instruction", reason: "独立安排", model: "synthetic", deliveryOnly: false })).toBe(true);
  expect(await list()).toMatchObject({ needsAttention: true, attention: { reason: "独立安排" } });
  expect((await list()).attention.handledByDelivery).toBeUndefined();
  // A legacy cached verdict has no delivery attribution and remains visible.
  f.db.prepare("UPDATE agent_session_attention SET delivery_only=NULL WHERE session_id=?").run(f.projectSessionId);
  expect((await list()).needsAttention).toBe(true);
  f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  expect(f.merges.attentionSessionIds(f.item.productId, f.owner.id)).toEqual([]);
});

it("keeps parallel merge proposals and accepts an existing claimant's proposal during verification",async()=>{
 const f=await prepared();
 const claim=await f.call("claim_item",{...f.claimInput,session:{...f.session,sessionRef:randomUUID()},idempotencyKey:"parallel-merge-claim"});f.safe(claim);
 const identity={sessionId:claim.structuredContent!.sessionId!};
 const second=f.merges.propose(f.owner.id,"original-client",identity,"parallel-offer",{...f.input,pullRequest:13});
 expect(f.merges.list(f.item.productId,f.owner.id).filter(row=>row.state!=="withdrawn").map(row=>row.id)).toEqual(expect.arrayContaining([f.d.id,second.id]));
 f.store.submitDevelopmentComplete({itemKey:f.item.key,completion,requiredArtifacts:["web"],attribution:{accountId:f.owner.id},idempotencyKey:"first-merge"});
 f.store.submitForVerification({itemKey:f.item.key,completion,releases:[{artifact:"web",version:"1.0",sourceCommit:"a".repeat(40)}],deployedCommit:"a".repeat(40),receiptDigest:"b".repeat(64),attribution:{accountId:f.owner.id},idempotencyKey:"first-publication"});
 const next=f.merges.propose(f.owner.id,"original-client",identity,"verification-offer",{...f.input,pullRequest:14});
 expect(next.state).toBe("proposed");expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
 expect(f.merges.list(f.item.productId,f.owner.id).find(row=>row.id===f.d.id)?.state).toBe("proposed");
});

describe("AND-476 independent integration defaults",()=>{
  it("saves only opted-in accepted batches, isolates dispatch/accounts and does not overwrite newer preferences on replay",async()=>{
    const f=await prepared(), store=new DispatchStore(f.store.database);
    store.setDispatchDefaults(f.owner.id,{nodeId:f.node.nodeId,agentKind:"opencode",agents:{opencode:{mode:"plan"}}});
    store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"auto",model:"kept"}}},"integration");
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const selection=[{id:f.d.id,revision:f.d.revision}];
    const batch=f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,true);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({nodeId:f.node.nodeId,agentKind:"opencode",agents:{codex:{mode:"auto",model:"kept"},opencode:{mode:"default"}}});
    expect(store.getDispatchDefaults(f.owner.id).agents.opencode?.mode).toBe("plan");
    expect(store.getDispatchDefaults(f.other.id,"integration")).toEqual({agents:{}});
    store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"plan"}}},"integration");
    expect(f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,true).id).toBe(batch.id);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({agents:{codex:{mode:"plan"}}});
    expect(()=>f.merges.start(f.owner.id,"integration-default-save",selection,f.config,false,1,false)).toThrow();
  });
  it("keeps existing defaults when not opted in and rolls back the whole batch if saving fails",async()=>{
    const f=await prepared(),store=new DispatchStore(f.store.database);
    f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    f.merges.start(f.owner.id,"without-default",[{id:f.d.id,revision:f.d.revision}],f.config,false,1);
    expect(store.getDispatchDefaults(f.owner.id,"integration")).toEqual({agents:{}});
    const g=await prepared();g.merges.decide(g.owner.id,g.d.id,g.d.revision,"confirm");
    const before=g.db.prepare("SELECT count(*) AS n FROM dispatches").get();
    const original=DispatchStore.prototype.setDispatchDefaults;
    const spy=vi.spyOn(DispatchStore.prototype,"setDispatchDefaults").mockImplementation(function(account,body,scope){
      if(scope==="integration")throw new Error("Synthetic preference write failure");
      return original.call(this,account,body,scope);
    });
    try {
      expect(()=>g.merges.start(g.owner.id,"rollback-default",[{id:g.d.id,revision:g.d.revision}],g.config,false,1,true)).toThrow("Synthetic preference write failure");
      expect(g.db.prepare("SELECT count(*) AS n FROM dispatches").get()).toEqual(before);
      expect(g.db.prepare("SELECT count(*) AS n FROM merge_batches").get()).toEqual({n:0});
      expect(g.merges.list(g.item.productId,g.owner.id)[0]?.state).toBe("confirmed");
    } finally {spy.mockRestore();}
  });
});

it("AND-476 reads only the current account's integration defaults through the authenticated API",async()=>{
  const f=await prepared(),store=new DispatchStore(f.store.database);
  store.setDispatchDefaults(f.owner.id,{agents:{codex:{mode:"auto"}}},"integration");
  store.setDispatchDefaults(f.other.id,{agents:{opencode:{mode:"plan"}}},"integration");
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const raw=login.headers["set-cookie"];
  const cookie=(Array.isArray(raw)?raw[0]:raw)!.split(";")[0]!;
  const read=await f.app.inject({method:"GET",url:"/api/v1/integration-defaults",headers:{cookie}});
  expect(read.statusCode).toBe(200);expect(read.json()).toEqual({agents:{codex:{mode:"auto"}}});
  expect((await f.app.inject({method:"GET",url:"/api/v1/integration-defaults"})).statusCode).toBe(401);
  const invalid=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/merge-batches`,headers:{cookie},payload:{requestKey:"invalid",selection:[],publish:false,saveAsDefault:"true"}});
  expect(invalid.statusCode).toBe(400);
});
describe("standalone project deliveries",()=>{
  async function standalone(artifacts=["web","macosApp"],publish=false) {
    const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
    const identity={dispatchId:launched.dispatch.id},input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId,requiredArtifacts:artifacts,
      ...(!artifacts.length?{noReleaseReason:"Only local verification fixtures"}:{})};
    const offered=await f.call("propose_merge_delivery",{identity,idempotencyKey:"standalone",delivery:input,instructionConfirmation:{quote:"加入待合并"}});f.safe(offered);
    const d=merges.list(f.item.productId,f.owner.id)[0]!;
    const b=merges.start(f.owner.id,randomUUID(),[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex",mode:"default"},publish);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(launched.node.nodeId);ds.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    return {...f,...launched,merges,identity,input,d,b};
  }
  const merged={status:"merged" as const,head:"a".repeat(40),commit:"c".repeat(40),detail:"Verified exact-head integration"};
  const proof={deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64)};
  it("merges without claiming an item and retains release coverage after a merge-only batch finishes",async()=>{
    const f=await standalone(),before=f.snapshot();
    expect(f.d.itemKeys).toEqual([]);expect(f.merges.list(f.item.productId,f.owner.id)[0]!.state).toBe("batched");
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("pending");
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    expect(f.snapshot()).toEqual(before);
    const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true});f.safe(listing);
    expect(listing.structuredContent).toMatchObject({coverageVersion:2,candidates:[{kind:"delivery",deliveryId:f.d.id,expectedRevision:f.d.revision,requiredArtifacts:["web","macosApp"]}]});
    const release={productId:f.item.productId,idempotencyKey:"standalone-release",...proof,deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]};
    const partial=await f.call("submit_release_batch",release);f.safe(partial);
    expect(partial.structuredContent).toMatchObject({deliveries:[{deliveryId:f.d.id,outcome:"submitted"}]});
    f.safe(await f.call("submit_release_batch",release));
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("partial");
    expect((await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true})).structuredContent!.candidates).toHaveLength(1);
    f.safe(await f.call("submit_release_batch",{...release,idempotencyKey:"finish-release",deliveries:[{...release.deliveries[0],releases:[{artifact:"macosApp",version:"2",sourceCommit:"e".repeat(40)}]}]}));
    expect((await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true})).structuredContent!.candidates).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.entries[f.d.id]!.publication).toBe("published");
    expect(f.snapshot()).toEqual(before);
  });
  it("requires complete publication receipts to finish a publish batch, but explicit no-release work needs none",async()=>{
    const f=await standalone(["macosApp"],true);f.merges.integrate(f.owner.id,f.b.dispatchId,f.b.id,0,"preflight",syntheticPrerequisites(f.merges.batch(f.owner.id,f.b.dispatchId,f.b.id)));f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布凭据/);
    const bad={productId:f.item.productId,idempotencyKey:"bad",...proof,deliveries:[{deliveryId:f.d.id,expectedRevision:"0".repeat(64),releases:[{artifact:"macosApp",version:"2",sourceCommit:"e".repeat(40)}]}]};
    expect((await f.call("submit_release_batch",bad)).isError).toBe(true);
    f.safe(await f.call("submit_release_batch",{...bad,idempotencyKey:"valid",deliveries:[{...bad.deliveries[0],expectedRevision:f.d.revision}]}));
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
    const g=await standalone([],true);g.merges.report(g.owner.id,g.b.dispatchId,g.b.id,g.d.id,merged);g.merges.finish(g.owner.id,g.b.dispatchId,g.b.id);
    const listing=await g.call("list_release_candidates",{productId:g.item.productId,includeUnscoped:true});
    expect(listing.structuredContent).toMatchObject({candidates:[],noReleaseDeliveries:[{deliveryId:g.d.id,noReleaseReason:g.input.noReleaseReason}]});
  });
  it("registers external project conversations with ownership and project isolation",async()=>{
    const f=await fixture(),session={agentKind:"codex",refKind:"tracking",sessionRef:randomUUID()};
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session});f.safe(registered);
    const identity={sessionId:registered.structuredContent!.sessionId!},delivery={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const offer=await f.call("propose_merge_delivery",{identity,delivery,idempotencyKey:"external"});f.safe(offer);
    const otherClient=await f.call("propose_merge_delivery",{identity,delivery,idempotencyKey:"foreign"},{clientId:"foreign-client"});expect(otherClient.isError).toBe(true);
    const unrelated=f.store.createProduct({name:"Unrelated",keyPrefix:"OTHER",createdByAccountId:config.id});
    expect((await f.call("propose_merge_delivery",{identity,delivery:{...delivery,productId:unrelated.id},idempotencyKey:"foreign-project"})).isError).toBe(true);
    const merges=new MergeDeliveries(f.store),d=merges.list(f.item.productId,f.owner.id)[0]!;
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    f.db.prepare("UPDATE external_agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(),identity.sessionId);
    expect(merges.list(f.item.productId,f.owner.id)).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("ready");
  });
  it("paginates mixed item and standalone candidates without gaps, including empty no-release pages",async()=>{
    const f=await standalone();f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,merged);f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id);
    f.safe(await f.call("claim_item",f.claimInput));
    const claimed=f.db.prepare("SELECT id FROM external_agent_sessions WHERE session_ref=?").get(f.session.sessionRef) as {id:string};
    f.safe(await f.complete({sessionId:claimed.id}));
    const found:Record<string,unknown>[]=[],cursors:number[]=[];let beforeSequence:number|undefined;
    do {
      const listing=await f.call("list_release_candidates",{productId:f.item.productId,includeUnscoped:true,limit:1,...(beforeSequence?{beforeSequence}:{})});f.safe(listing);
      found.push(...listing.structuredContent!.candidates as Record<string,unknown>[]);
      beforeSequence=listing.structuredContent!.nextBeforeSequence as number|undefined;
      if(beforeSequence){expect(cursors).not.toContain(beforeSequence);cursors.push(beforeSequence);}
    }while(beforeSequence);
    expect(found).toHaveLength(2);expect(found.some(c=>c.deliveryId===f.d.id)).toBe(true);expect(found.some(c=>c.itemKey===f.item.key)).toBe(true);
  });
  it("checks project permissions for external node discovery and standalone release handover",async()=>{
    const f=await fixture(),node=f.launch("codex").node;
    const registered=await f.call("register_agent_session",{productId:f.item.productId,session:{agentKind:"codex",refKind:"native",sessionRef:randomUUID(),autoConnect:true}});f.safe(registered);
    const id=registered.structuredContent!.sessionId!,native=new ExternalNativeSessionStore(f.store),authorized:string[]=[];
    const discovery=native.listForNode(f.owner.id,node.nodeId,"worker",product=>{authorized.push(product);},true);
    expect(discovery.some(s=>s.id===id)).toBe(true);expect(authorized).toContain(f.item.productId);
    expect(native.listForNode(f.owner.id,node.nodeId,"worker",()=>{throw new Error("Permission revoked");},true)).toEqual([]);
    const read=await f.call("get_agent_session",{sessionId:id});f.safe(read);
    const g=await standalone();g.merges.report(g.owner.id,g.b.dispatchId,g.b.id,g.d.id,merged);g.grant(false,true);
    expect((await g.call("submit_release_batch",{productId:g.item.productId,idempotencyKey:"revoked",...proof,deliveries:[{deliveryId:g.d.id,expectedRevision:g.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]})).isError).toBe(true);
    expect(g.merges.batches(g.item.productId,g.owner.id)[0]!.presentation.entries[g.d.id]!.publication).toBe("pending");
  });
  it("invalidates source changes and supersedes only the same standalone PR",async()=>{
    const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store),identity={dispatchId:launched.dispatch.id};
    const input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId};
    const first=merges.propose(f.owner.id,"original-client",identity,"first",input);merges.decide(f.owner.id,first.id,first.revision,"confirm");
    const second=merges.propose(f.owner.id,"original-client",identity,"second",{...input,pullRequest:13});
    expect(merges.list(f.item.productId,f.owner.id)).toHaveLength(2);
    const renewed=merges.propose(f.owner.id,"original-client",identity,"renewed",input);
    expect(renewed.reconfirmation).toBe(true);expect(merges.list(f.item.productId,f.owner.id).map(d=>d.id)).toEqual([renewed.id,second.id]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,launched.projectSessionId,"Continue changing the implementation",[]);
    expect(merges.list(f.item.productId,f.owner.id)).toEqual([]);
  });
});

// The reference calculations stay available to test the projection after real
// writes. Normal reads must never call them, even on the first request.
describe("AND-484 write-time display projections",()=>{
  it("matches full recomputation across writes and keeps all four reads lightweight",async()=>{
    const f=await prepared();
    const verify=()=>{
      const expected={list:f.merges.recomputeList(f.item.productId,f.owner.id),
        batches:f.merges.recomputeBatches(f.item.productId,f.owner.id),
        attention:f.merges.recomputeAttentionSessionIds(f.item.productId,f.owner.id),
        progress:f.merges.recomputeSessionProgress(f.item.productId,f.owner.id)};
      const item=vi.spyOn(f.store,"getWorkItem").mockImplementation(()=>{throw new Error("Read assembled detail");});
      const events=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw new Error("Read assembled timeline");});
      try {
        expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(expected.list);
        expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(expected.batches);
        expect(f.merges.attentionSessionIds(f.item.productId,f.owner.id)).toEqual(expected.attention);
        expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(expected.progress);
      }finally{item.mockRestore();events.mockRestore();}
    };
    verify();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");verify();
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+360_000);
    try{verify();expect(f.merges.list(f.item.productId,f.owner.id)[0]?.blocker).toBe("stale");}finally{clock.mockRestore();}
    f.grant(false);verify();f.grant();verify();
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"New authorized input",[]);verify();
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
  });
  it("keeps mismatched heads stale and observes user-to-Agent history corrections",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"mismatched-head",{...f.input,evidence:{...f.input.evidence,head:"f".repeat(40)}});
    expect(d.blocker).toBe("stale");
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeList(f.item.productId,f.owner.id));
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"source-user",role:"user",text:"A newer input"}]});
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]);
    f.db.prepare("UPDATE agent_session_messages SET role='agent' WHERE session_id=? AND source_id='source-user'").run(f.projectSessionId);
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeList(f.item.productId,f.owner.id));
    expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
  });
  it("rolls back source and projection together, including a failed nested transaction",async()=>{
    const f=await prepared(),before=f.merges.list(f.item.productId,f.owner.id);
    let fail=false;
    f.store.database.registerProjectionWriter("synthetic-failure",()=>{if(fail)throw new Error("projection failure");});
    fail=true;
    expect(()=>f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm")).toThrow("projection failure");
    fail=false;
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(before);
    expect(f.merges.readForAccount(f.owner.id,f.d.id).state).toBe("proposed");
    f.store.database.transaction(()=>{
      expect(()=>f.store.database.transaction(()=>{f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");throw new Error("rollback nested");})).toThrow("rollback nested");
    });
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual(before);
    expect(f.db.prepare("SELECT * FROM merge_display_dirty").all()).toEqual([]);
  });
  it("does not refresh display rows for ordinary Agent output or unchanged snapshots",async()=>{
    const f=await prepared();
    const before=f.db.prepare("SELECT total_changes() AS n").get() as {n:number};
    f.db.exec(`CREATE TEMP TABLE observed_refreshes(value INTEGER);
      CREATE TEMP TRIGGER observe_display AFTER INSERT ON merge_delivery_projection BEGIN INSERT INTO observed_refreshes VALUES(1); END;`);
    new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",messages:[{sourceId:"new-output",role:"agent",text:"Only an output"}]});
    expect((f.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n).toBeGreaterThan(before.n);
    expect(f.db.prepare("SELECT * FROM observed_refreshes").all()).toEqual([]);
    f.store.createComment({itemKey:f.item.key,actorKind:"human",bodyKind:"free",body:{text:"An ordinary comment"}});
    expect(f.db.prepare("SELECT * FROM observed_refreshes").all()).toEqual([]);
  });
});

for(const [itemCount,batchCount] of [[500,100],[1000,200]])it(`AND-484 scale ${itemCount} items and ${batchCount} historical batches`,async()=>{
  const f=await prepared(),db=f.db;
  const source=JSON.parse((db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string}).data_json);
  const baseItem=db.prepare("SELECT * FROM work_items WHERE id=?").get(f.item.id) as Record<string,string|number|null>;
  const columns=Object.keys(baseItem),insertItem=db.prepare(`INSERT INTO work_items(${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`);
  const started=performance.now();
  f.store.database.transaction(()=>{
    for(let i=1;i<itemCount;i++){
      const row={...baseItem,id:`synthetic-item-${i}`,item_key:`CON-${i+1}`,sequence:i+1,title:`Synthetic item ${i}`};
      insertItem.run(...columns.map(column=>row[column as keyof typeof row] as string|number|null));
    }
    // A long diagnostic history is deliberately present but irrelevant to reads.
    for(let i=0;i<100;i++)db.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,payload_json,timeline_seq,created_at)
      VALUES (?,?,'synthetic_diagnostic','system',?,?,?)`).run(`synthetic-event-${i}`,f.item.id,JSON.stringify({text:"Historical diagnostic ".repeat(100)}),100+i,new Date().toISOString());
    for(let i=0;i<batchCount;i++){
      const batchId=`synthetic-batch-${i}`,ids:string[]=[],results:Record<string,unknown>={};
      for(let j=0;j<20;j++){
        const id=`synthetic-delivery-${i}-${j}`;ids.push(id);results[id]={status:"merged",head:source.head,commit:"c".repeat(40),detail:"Synthetic historic result"};
        db.prepare("INSERT INTO merge_deliveries(id,product_id,account_id,client_id,request_key,state,data_json) VALUES (?,?,?,?,?,'merged',?)")
          .run(id,f.item.productId,f.owner.id,"original-client",id,JSON.stringify({...source,id,state:"merged",batchId}));
      }
      db.prepare("INSERT INTO merge_batches(id,product_id,account_id,request_key,state,data_json) VALUES (?,?,?,?,'finished',?)")
        .run(batchId,f.item.productId,f.owner.id,batchId,JSON.stringify({id:batchId,productId:f.item.productId,accountId:f.owner.id,requestKey:batchId,
          dispatchId:batchId,sessionId:batchId,config:f.config,publish:false,deliveries:ids,selection:[],state:"finished",createdAt:new Date().toISOString(),results}));
    }
  });
  const initializationMs=performance.now()-started;
  let queries=0;
  const prepare=db.prepare.bind(db);
  const counter=vi.spyOn(db,"prepare").mockImplementation(sql=>{queries++;return prepare(sql);});
  const referenceAt=performance.now();
  const expected={deliveries:f.merges.recomputeList(f.item.productId,f.owner.id),batches:f.merges.recomputeBatches(f.item.productId,f.owner.id),
    attentionSessionIds:f.merges.recomputeAttentionSessionIds(f.item.productId,f.owner.id),sessionProgress:f.merges.recomputeSessionProgress(f.item.productId,f.owner.id)};
  const referenceMs=performance.now()-referenceAt,referenceQueries=queries;queries=0;
  // Repeated historical identities must not rescan authority and item facts
  // per delivery; keep the existing timeout and every hot-read assertion.
  expect(referenceQueries).toBeLessThan(20_000);
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  const heavy=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw new Error("Hot read loaded timeline");});
  queries=0;
  const times:number[]=[],queryCounts:number[]=[];
  try{
    for(let i=0;i<30;i++){
      queries=0;
      const at=performance.now(),response=await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/merge-deliveries`,headers:{cookie}});
      times.push(performance.now()-at);queryCounts.push(queries);expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      if(i===0)expect(response.json()).toEqual(expected);
    }
  }finally{heavy.mockRestore();counter.mockRestore();}
  // Cold reads may prepare fixed SQL once; warm reads reuse statements but still execute them.
  expect(new Set(queryCounts.slice(1)).size).toBe(1);expect(Math.max(...queryCounts)).toBeLessThan(25);
  const writeAt=performance.now();
  f.store.updateWorkItem(`CON-${itemCount}`,{title:"One unrelated item update"});
  const writeMs=performance.now()-writeAt,firstMs=times[0]!;
  db.exec(`CREATE TEMP TABLE observed_activity_refresh(kind TEXT);
    CREATE TEMP TRIGGER observe_activity_batch AFTER INSERT ON merge_batch_projection BEGIN INSERT INTO observed_activity_refresh VALUES('batch'); END;
    CREATE TEMP TRIGGER observe_activity_delivery AFTER INSERT ON merge_delivery_projection BEGIN INSERT INTO observed_activity_refresh VALUES('delivery'); END;`);
  const messageAt=performance.now();
  new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"A new input after historical deliveries",[]);
  const relatedMessageWriteMs=performance.now()-messageAt;
  expect(db.prepare("SELECT * FROM observed_activity_refresh WHERE kind='batch'").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM observed_activity_refresh WHERE kind='delivery'").all()).toHaveLength(1);
  expect(f.merges.batches(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeBatches(f.item.productId,f.owner.id));
  expect(f.merges.sessionProgress(f.item.productId,f.owner.id)).toEqual(f.merges.recomputeSessionProgress(f.item.productId,f.owner.id));
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({benchmark:"AND-484",itemCount,batchCount,deliveries:batchCount*20,events:100,returnedBatches:20,initializationMs,referenceMs,referenceQueries,readQueries:queryCounts[0],firstMs,p50:times[15],p95:times[28],max:times[29],unrelatedWriteMs:writeMs,relatedMessageWriteMs}));
  // Latency is reported rather than made a flaky CI assertion. The strict
  // guard is that every cold/hot request succeeds without the history reader.
  expect(times).toHaveLength(30);
},60_000);

 it("AND-484 filters retired history through partial indexes",async()=>{
   const f=await prepared();
   for(const [predicate,index] of [["visible=1","merge_delivery_projection_visible"],["attention=1","merge_delivery_projection_attention"]]) {
     const plan=f.db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND ${predicate} ${predicate==="attention=1" ? "GROUP BY session_id ORDER BY MAX(sequence) DESC" : "ORDER BY sequence DESC"}`).all(f.item.productId,f.owner.id);
     expect(JSON.stringify(plan)).toContain(index);
   }
 });

it("AND-484 query work should be bounded by live rows rather than retired history",async()=>{
  const f=await prepared(),db=f.db;
  const template=db.prepare("SELECT * FROM merge_delivery_projection WHERE id=?").get(f.d.id) as Record<string,string|number|null>;
  const keys=Object.keys(template),insert=db.prepare(`INSERT INTO merge_delivery_projection(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
  f.store.database.transaction(()=>{
    for(let i=0;i<500000;i++){
      const row={...template,id:`retired-${i}`,sequence:i+100,visible:0,attention:0,data_json:'{}'};
      insert.run(...keys.map(key=>row[key as keyof typeof row] as string|number|null));
    }
  });
  const queries=["SELECT data_json,fresh_from,fresh_until,fresh_blocker FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND visible=1 ORDER BY sequence DESC",
    "SELECT session_id FROM merge_delivery_projection WHERE product_id=? AND account_id=? AND attention=1 GROUP BY session_id ORDER BY MAX(sequence) DESC"];
  const results=queries.map(sql=>{
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(f.item.productId,f.owner.id);
    const times=[];for(let i=0;i<10;i++){const at=performance.now();db.prepare(sql).all(f.item.productId,f.owner.id);times.push(performance.now()-at);}
    expect(JSON.stringify(plan)).toContain(sql.includes("visible=1") ? "merge_delivery_projection_visible" : "merge_delivery_projection_attention");
    return {plan,maxMs:Math.max(...times)};
  });
  console.log(JSON.stringify({audit:'retired-history-scan',rows:500000,results}));
  expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
},60_000);

describe("AND-497 scoped conversation delivery reads",()=>{
 it("isolates session, account and project without changing the full list or freshness semantics",async()=>{
  const f=await prepared();
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:f.owner.email,password:"synthetic password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  const read=(sessionId:string,productId=f.item.productId)=>f.app.inject({method:"GET",url:`/api/v1/products/${productId}/merge-deliveries?sessionId=${encodeURIComponent(sessionId)}`,headers:{cookie}});
  const own=await read(f.d.sessionId);expect(own.statusCode).toBe(200);expect(own.json().deliveries.map((d:{id:string})=>d.id)).toEqual([f.d.id]);
  expect((await read("no-delivery")).json()).toEqual({deliveries:[],batches:[],attentionSessionIds:[],sessionProgress:{}});
  expect(f.merges.list(f.item.productId,f.other.id,f.d.sessionId)).toEqual([]);
  expect(f.merges.list(f.item.productId,f.owner.id)).toHaveLength(1);
  const privateProduct=f.store.createProduct({name:"Private",keyPrefix:"PRIVATE",createdByAccountId:config.id});
  expect((await read(f.d.sessionId,privateProduct.id)).statusCode).toBe(404);
  expect((await read("")).statusCode).toBe(400);
  new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"Continue changing",[]);
  expect((await read(f.d.sessionId)).json().deliveries).toEqual([]);
 });
 it("returns standalone offers and only the requested integration batch",async()=>{
  const f=await fixture(),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
  const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"standalone",{...proposal(f.item.key),itemKeys:[],productId:f.item.productId});
  expect(merges.list(f.item.productId,f.owner.id,d.sessionId).map(row=>row.id)).toEqual([d.id]);
  merges.decide(f.owner.id,d.id,d.revision,"confirm");
  const batch=merges.start(f.owner.id,"batch",[{id:d.id,revision:d.revision}],{productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex",mode:"default"},false);
  expect(merges.batches(f.item.productId,f.owner.id,batch.sessionId).map(row=>row.id)).toEqual([batch.id]);
  expect(merges.batches(f.item.productId,f.owner.id,"unrelated")).toEqual([]);
 });
});

describe("AND-511 two-step integration queue",()=>{
  async function mergedProject(artifacts=["web","macosApp"],databasePath=":memory:",finishBatch=true) {
    const f=await fixture(databasePath),launched=f.launch("codex"),merges=new MergeDeliveries(f.store);
    const input={...proposal(f.item.key),itemKeys:[],productId:f.item.productId,requiredArtifacts:artifacts};
    const d=merges.propose(f.owner.id,"original-client",{dispatchId:launched.dispatch.id},"queue-offer",input);
    merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const conf={productId:f.item.productId,nodeId:launched.node.nodeId,agentKind:"codex" as const,mode:"default"};
    const original=merges.start(f.owner.id,"merge-only",[{id:d.id,revision:d.revision}],conf,false);
    const launchBatch=(b:{dispatchId:string})=>{const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(launched.node.nodeId);dispatches.recordDispatchResult({nodeId:launched.node.nodeId,dispatchId:b.dispatchId,status:"launched"});};
    launchBatch(original);
    merges.report(f.owner.id,original.dispatchId,original.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Synthetic verified merge"});
    if(finishBatch)merges.finish(f.owner.id,original.dispatchId,original.id);
    return {...f,...launched,merges,input,d,conf,original,launchBatch,selection:[{id:d.id,revision:d.revision}]};
  }
  async function historicalProject(withReturn=true,withReplacement=true,withEvidence=false) {
    const f=await mergedProject(["web"]);
    const admins=f.accounts.projectAdministratorIds(f.item.productId);
    f.accounts.replaceProjectAdministrators(f.item.productId,[...admins,f.owner.id],admins,config.id);
    const transition=(to:"in_progress"|"development_complete")=>f.store.transitionWorkItem({itemKey:f.item.key,actor:"human",to,reason:"manual_override",note:"Synthetic historical state correction",attribution:{accountId:f.owner.id}});
    transition("in_progress");transition("development_complete");
    const old=f.store.getDevelopmentEvidence(f.item.key).handover!.id;
    if(withEvidence) {
      const evidence=f.store.getDevelopmentEvidence(f.item.key);
      f.store.supplementReleaseEvidence({productId:f.item.productId,itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,
        developmentEventId:old,roundKey:evidence.roundKey!,completion:{kind:"github",url:"https://github.com/example/project/pull/987"},requiredArtifacts:["windowsApp"],idempotencyKey:"original-proof",attribution:{accountId:f.owner.id,clientId:"original-client"}});
    }
    if(withReturn)transition("in_progress");
    if(withReturn&&withReplacement) {
      f.safe(await f.call("claim_item",{...f.claimInput,session:undefined,dispatchId:f.dispatch.id}));
      f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,dispatchId:f.dispatch.id,
        completion:{kind:"github",url:f.d.pullRequestUrl},requiredArtifacts:["web"],idempotencyKey:"replacement"}));
    }
    return {...f,old};
  }
  it("reviews returned status-only history at startup without inventing evidence or dropping real deliveries",async()=>{
    const f=await historicalProject(),before=f.store.getTimeline(f.item.key),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.blockers).toEqual([]);
    expect(scope.candidates.find(c=>c.developmentEventId===f.old)).toMatchObject({historicalGapReason:expect.any(String)});
    expect(scope.candidates.filter(c=>!c.historicalGapReason).length).toBeGreaterThan(0);
    expect(()=>f.merges.start(f.owner.id,"reviewed-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest)).toThrow(/历史/);
    expect(()=>f.merges.start(f.owner.id,"reviewed-history",f.selection,f.conf,true,1,false,"publish_only","0".repeat(64),true)).toThrow(/范围/);
    const b=f.merges.start(f.owner.id,"reviewed-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true);
    expect(b.publicationReview).toMatchObject({accountId:f.owner.id,scopeDigest:scope.digest});
    expect(f.merges.start(f.owner.id,"reviewed-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,"reviewed-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest,false)).toThrow();
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    expect(f.store.getDevelopmentEvidence(f.item.key,f.old).completion).toBeUndefined();
    // The same reviewed history must pass the execution-time frozen scope check.
    f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const display=f.merges.batches(f.item.productId,f.owner.id).find(row=>row.id===b.id)!.presentation;
    expect(display.historicalGaps).toHaveLength(1);
    expect(display.ownedExtras?.some(row=>row.id.includes(f.old))).not.toBe(true);
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Reviewed scope",validation:"Combination",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Reference",validation:"Regression"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Passed",source:"Synthetic"});
    act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:current.resultsDigest,detail:"Reviewed original scope"});
    f.store.updateWorkItem(f.item.key,{description:"Changed scope",attribution:{accountId:config.id}});
    expect(()=>act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:current.resultsDigest,detail:"Changed scope must stop"})).toThrow();
  });
  it("never excludes a returned delivery that has real integration and artifact evidence",async()=>{
    const f=await historicalProject(true,true,true),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    const old=scope.candidates.find(c=>c.developmentEventId===f.old)!;
    expect(old.historicalGapReason).toBeUndefined();expect(old.requiredArtifacts).toEqual(["windowsApp"]);
    expect(scope.requiredArtifacts).toContain("windowsApp");
    expect(scope.candidates.filter(c=>c.itemKey===f.item.key)).toHaveLength(2);
    expect(()=>f.merges.start(f.owner.id,"cannot-hide-known",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true)).toThrow();
  });
  it.each(["queue","original conversation"] as const)("reuses an exact saved historical review in the next %s batch",async entry=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const f=await historicalProject(),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    const first=f.merges.start(f.owner.id,"initial-review",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true);
    f.launchBatch(first);
    let current=f.merges.batch(f.owner.id,first.dispatchId,first.id);
    function act(action:Parameters<MergeDeliveries["integrate"]>[5]) {
      current=f.merges.integrate(f.owner.id,first.dispatchId,first.id,current.integration!.revision,randomUUID(),action);
    }
    act({kind:"plan",base:"b".repeat(40),summary:"Verify original",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"one",reason:"Reference",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    for(const command of f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(first.sessionId) as {id:string}[])
      new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:first.sessionId,status:"active",messages:[],turnState:{turnActive:true},commandId:command.id,commandStatus:"delivered"});
    const unchanged=f.merges.preview(f.owner.id,first.id);
    expect(unchanged.publicationIdentity?.unchanged).toBe(true);
    expect(unchanged.publicationRefresh).toBeUndefined();

    const addedUrl="https://github.com/example/project/pull/998";
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,dispatchId:f.dispatch.id,
      completion:{kind:"github",url:addedUrl},requiredArtifacts:["web"],idempotencyKey:"additional-web-delivery"}));
    const recovery=f.merges.preview(f.owner.id,first.id),refresh=recovery.publicationRefresh!;
    expect(recovery.publicationIdentity?.unchanged).toBe(false);
    expect(refresh.candidates.some(c=>c.completion?.kind==="github"&&c.completion.url===addedUrl)).toBe(true);
    expect(refresh.candidates.find(c=>c.developmentEventId===f.old)?.historicalGapPreviouslyReviewed).toBe(true);
    const requested=f.merges.requestReconciliation(f.owner.id,first.dispatchId,first.id,"refresh",recovery.snapshot,{
      kind:"allow_partial_publication",reason:"Approve the next publication snapshot",
      publicationRefresh:{scopeDigest:refresh.digest,historicalGaps:[]},
    }).reconciliation!.requests.find(r=>r.id==="refresh")!;
    expect(requested.publicationScope?.candidates.find(c=>c.developmentEventId===f.old)?.historicalGapPreviouslyReviewed).toBe(true);
    expect(()=>f.merges.applyReconciliation(f.owner.id,first.dispatchId,first.id,"refresh")).toThrow(/人工/);
    f.merges.decideReconciliation(f.owner.id,first.id,"refresh",recovery.snapshot,"approved",true,requested.publicationScope!.digest);
    f.merges.applyReconciliation(f.owner.id,first.dispatchId,first.id,"refresh");
    const snapshot=f.merges.preview(f.owner.id,first.id).snapshot;
    f.merges.requestReconciliation(f.owner.id,first.dispatchId,first.id,"defer",snapshot,{kind:"defer_publication",reason:"Synthetic human choice"});
    f.merges.decideReconciliation(f.owner.id,first.id,"defer",snapshot,"approved",true);
    f.merges.applyReconciliation(f.owner.id,first.dispatchId,first.id,"defer");
    f.merges.finish(f.owner.id,first.dispatchId,first.id);

    if(entry==="original conversation") {
      const sessions=new AgentSessionStore(f.store.database),identity={dispatchId:f.dispatch.id};
      f.db.prepare("UPDATE agent_sessions SET applied_settings_revision=settings_revision WHERE id=?").run(f.projectSessionId);
      const human=(text:string)=>{
        const command=sessions.enqueue(f.owner.id,f.projectSessionId,text,[]);
        f.db.prepare("UPDATE agent_session_commands SET status='delivered' WHERE id=?").run(command.id);
      };
      human("执行发布");
      const p=f.merges.prepareConversation(f.owner.id,"original-client",identity,"publish-next",{
        productId:f.item.productId,repository:f.input.repository,operation:"publish_only",deliveries:[],
      });
      expect(p.publicationScope?.candidates.find(c=>c.developmentEventId===f.old)?.historicalGapPreviouslyReviewed).toBe(true);
      expect(()=>f.merges.startConversation(f.owner.id,"original-client",identity,p.id)).toThrow(/完整发布范围/);
      vi.setSystemTime(Date.now()+10);
      sessions.recordSnapshot({nodeId:f.node.nodeId,sessionId:f.projectSessionId,status:"idle",
        messages:[{sourceId:"next-publication-scope",role:"agent",phase:"final_answer",text:p.reviewText,occurredAt:new Date(Date.now()-1).toISOString()}]});
      human("批准");
      const b=f.merges.startConversation(f.owner.id,"original-client",identity,p.id);
      expect(b.sessionId).toBe(f.projectSessionId);
      expect(b.publicationReview).toBeUndefined();
      expect(b.publicationScope?.requiredArtifacts).toEqual(["web"]);
      return;
    }

    const next=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"next-delivery",
      {...f.input,pullRequest:999,head:"f".repeat(40),requiredArtifacts:["windowsApp"],evidence:{...f.input.evidence,head:"f".repeat(40)}});
    f.merges.decide(f.owner.id,next.id,next.revision,"confirm");
    const selection=[{id:next.id,revision:next.revision}];
    const preview=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const old=preview.candidates.find(c=>c.developmentEventId===f.old)!;
    expect(preview.digest).not.toBe(scope.digest);
    expect(preview.requiredArtifacts).toEqual(["web","windowsApp"]);
    expect(old).toMatchObject({historicalGapReason:expect.any(String),historicalGapPreviouslyReviewed:true});
    expect(previouslyReviewedHistoricalGaps(f.store.database,f.item.productId,[old],f.other.id).size).toBe(0);
    expect(previouslyReviewedHistoricalGaps(f.store.database,"other-project",[old],f.owner.id).size).toBe(0);
    const second=f.merges.start(f.owner.id,"next-batch",selection,f.conf,true,1,false,"merge_and_publish",preview.digest);
    expect(second.publicationReview).toBeUndefined();
    expect(f.merges.start(f.owner.id,"next-batch",selection,f.conf,true,1,false,"merge_and_publish",preview.digest).id).toBe(second.id);
    expect(f.merges.start(f.owner.id,"next-batch",selection,f.conf,true,1,false,"merge_and_publish",preview.digest,true).id).toBe(second.id);
    expect(f.merges.batches(f.item.productId,f.owner.id).find(row=>row.id===second.id)!.presentation.historicalGaps).toBeUndefined();
    f.launchBatch(second);
    const live=()=>f.merges.batch(f.owner.id,second.dispatchId,second.id);
    expect(live().publicationScope?.candidates).toContainEqual(old);
    expect(live().prerequisiteGate.blockers.some(blocker=>blocker.id==="publication_scope")).toBe(false);

    f.store.updateWorkItem(f.item.key,{description:"Changed scope",attribution:{accountId:config.id}});
    const changed=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(changed.candidates.find(c=>c.developmentEventId===f.old)?.historicalGapPreviouslyReviewed).toBeUndefined();
    expect(live().prerequisiteGate.ready).toBe(true);
    expect(f.merges.preview(f.owner.id,second.id).publicationIdentity.unchanged).toBe(false);
  });
  it("retains only the historical warning after the replacement delivery is fully published",async()=>{
    const f=await historicalProject(),record=f.store.getDeliveryRecords(f.item.key).find(r=>r.id!==f.old)!;
    const result=f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"published-replacement",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),attribution:{accountId:f.owner.id,clientId:"original-client"},
      items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:record.id,roundKey:record.roundKey!,completion:record.completion!,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    expect(result.results[0]?.outcome).toBe("submitted");
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.blockers).toEqual([]);
    expect(scope.candidates.some(c=>c.developmentEventId===record.id)).toBe(false);
    expect(scope.candidates.find(c=>c.developmentEventId===f.old)?.historicalGapReason).toBeTruthy();
    const before=f.store.getTimeline(f.item.key);
    const accept=(expectedRevision?:number)=>f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",
      ...(expectedRevision!==undefined?{expectedRevision}:{}),attribution:{accountId:f.owner.id}});
    expect(()=>accept(f.store.getWorkItem(f.item.key).revision)).toThrow(/发布/);
    f.merges.start(f.owner.id,"after-published-replacement",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true);
    expect(f.store.getTimeline(f.item.key)).toEqual(before);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    expect(()=>accept()).toThrow(/修订/);
    // Reviewing old history must never exempt a new real integration.
    f.safe(await f.call("submit_development_complete",{itemKey:f.item.key,dispatchId:f.dispatch.id,
      completion:{kind:"github",url:"https://github.com/example/project/pull/999"},requiredArtifacts:["web"],idempotencyKey:"another-real-delivery"}));
    expect(()=>accept(f.store.getWorkItem(f.item.key).revision)).toThrow(/发布/);
    const next=f.store.getDeliveryRecords(f.item.key).at(-1)!;
    expect(f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"publish-next",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),attribution:{accountId:f.owner.id,clientId:"original-client"},
      items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:next.id,roundKey:next.roundKey!,completion:next.completion!,releases:[{artifact:"web",version:"2",sourceCommit:"e".repeat(40)}]}]}).results[0]?.outcome).toBe("submitted");
    const live=f.store.getWorkItem(f.item.key),records=f.store.getDeliveryRecords(f.item.key);
    const context={id:live.id,key:live.key,productId:live.productId,contentVersion:live.contentVersion!,builderAccountId:live.builderAccountId??null,roundKey:record.roundKey};
    expect(reviewedHistoricalDeliveries(f.store.database,context,records).has(f.old)).toBe(true);
    for(const changed of [{...context,contentVersion:context.contentVersion+1},{...context,builderAccountId:f.other.id},{...context,roundKey:randomUUID()}]) {
      expect(reviewedHistoricalDeliveries(f.store.database,changed,records).size).toBe(0);
    }
  });
  it("allows only human version-bound acceptance after exact durable history review",async()=>{
    const f=await historicalProject(),record=f.store.getDeliveryRecords(f.item.key).find(r=>r.id!==f.old)!;
    f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"published-replacement",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),attribution:{accountId:f.owner.id,clientId:"original-client"},
      items:[{itemKey:f.item.key,expectedRevision:f.store.getWorkItem(f.item.key).revision,developmentEventId:record.id,roundKey:record.roundKey!,completion:record.completion!,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    f.merges.start(f.owner.id,"review-then-accept",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",expectedRevision:f.store.getWorkItem(f.item.key).revision,attribution:{accountId:f.owner.id}});
    expect(f.store.getWorkItem(f.item.key).status).toBe("done");
    expect(f.store.getDeliveryRecords(f.item.key).find(r=>r.id===f.old)?.published).toBe(false);
  });
  it.each([[false,false],[true,false]])("keeps unresolved manual work blocked without a replacement (%s/%s)",async(returned,replacement)=>{
    const f=await historicalProject(returned,replacement),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    // In-progress items are not release candidates, but their old record is never classified as reviewed history.
    expect(f.store.getDeliveryRecords(f.item.key).find(r=>r.id===f.old)?.historicalGapReason).toBeUndefined();
    if(!returned) {
      expect(scope.blockers.length).toBeGreaterThan(0);
      expect(scope.blockers.join(" ")).not.toContain("取消“合并后发布”");
      expect(()=>f.merges.start(f.owner.id,"unsafe-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest,true)).toThrow();
    }
  });
  it("AND-520 active original merged delivery stays owned until finish while the project lock protects execution",async()=>{
    const f=await mergedProject(["web","macosApp"],":memory:",false);
    const queue=f.merges.queue(f.item.productId,f.owner.id);
    expect(queue.counts.release??0).toBe(0);expect(queue.occupancy).toEqual({active:true,sessionId:f.original.sessionId,requestKey:f.original.requestKey});
    expect(f.merges.batches(f.item.productId,f.owner.id).find(b=>b.id===f.original.id)?.state).toBe("active");
    expect(()=>f.merges.start(f.owner.id,"must-not-start",f.selection,f.conf,false)).toThrow(/已有合并批次/);
    f.merges.finish(f.owner.id,f.original.dispatchId,f.original.id);
    const finished=f.merges.queue(f.item.productId,f.owner.id);expect(finished.counts.release).toBe(1);expect(finished.occupancy).toEqual({active:false});
  });
  it("AND-520 active publish-only reference stays owned with partial artifacts and immutable origin",async()=>{
    const f=await mergedProject();const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    const b=f.merges.start(f.owner.id,"audit-publish",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:"audit-partial",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    const q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.counts.release??0).toBe(0);expect(q.deliveries).toEqual([]);
    expect(JSON.parse((f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string}).data_json).batchId).toBe(f.original.id);expect(b.references?.[f.d.id]?.batchId).toBe(f.original.id);
  });
  it("AND-520 reviewed extra publication candidate is also owned by the current batch",async()=>{
    const f=await mergedProject(["web"]);
    const extra=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"audit-extra",{...f.input,pullRequest:14,summary:"Reviewed extra"});
    f.merges.decide(f.owner.id,extra.id,extra.revision,"confirm");
    const prior=f.merges.start(f.owner.id,"audit-extra-merge",[{id:extra.id,revision:extra.revision}],f.conf,false);f.launchBatch(prior);
    f.merges.report(f.owner.id,prior.dispatchId,prior.id,extra.id,{status:"merged",head:extra.head,commit:"d".repeat(40),detail:"Synthetic merge"});f.merges.finish(f.owner.id,prior.dispatchId,prior.id);
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.candidates.find(c=>c.deliveryId===extra.id)?.selected).toBe(false);
    const batch=f.merges.start(f.owner.id,"audit-extra-publish",f.selection,f.conf,true,1,false,"publish_only",scope.digest);
    expect(batch.deliveries).not.toContain(extra.id);expect(f.merges.queue(f.item.productId,f.owner.id).counts.release??0).toBe(0);
  });
  it("AND-520 project lock is global but another authorized account gets only a permission-safe occupancy summary",async()=>{
    const f=await mergedProject(["web"],":memory:",false);
    expect(f.merges.batches(f.item.productId,f.other.id)).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.other.id).occupancy).toEqual({active:true});
    expect(()=>f.merges.start(f.other.id,"audit-other-account",f.selection,f.conf,false)).toThrow(/已有合并批次/);
  });


  it("AND-520 preserves ownership through timeouts and new source input, but leaves new independent offers selectable",async()=>{
    const f=await mergedProject(["web"],":memory:",false);
    const next=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"new-independent",{...f.input,pullRequest:19});
    f.merges.decide(f.owner.id,next.id,next.revision,"confirm");
    let q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.deliveries.map(d=>d.id)).toEqual([next.id]);expect(q.counts.merge).toBe(1);expect(q.counts.release??0).toBe(0);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+86_400_000);
    try{q=f.merges.queue(f.item.productId,f.owner.id);expect(q.occupancy.active).toBe(true);expect(q.counts.release??0).toBe(0);}finally{clock.mockRestore();}
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"A separate discussion",[]);
    q=f.merges.queue(f.item.productId,f.owner.id);expect(q.deliveries).toEqual([]);expect(q.occupancy.active).toBe(true);
    expect(f.merges.releaseCandidates(f.item.productId).map(c=>c.delivery.id)).toContain(f.d.id);
  });
  it("AND-520 rolls back ownership with a rejected batch and rebuilds active ownership on upgrade",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"and520-owner-upgrade-")),path=join(dir,"data.sqlite");let reopened:ReturnType<typeof buildApp>|undefined;
    try{
      const f=await mergedProject(["web"],path),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
      expect(()=>f.store.database.transaction(()=>{f.merges.start(f.owner.id,"rolled-back",f.selection,f.conf,true,1,false,"publish_only",scope.digest);throw Error("Synthetic rollback");})).toThrow("Synthetic rollback");
      expect(f.merges.queue(f.item.productId,f.owner.id)).toMatchObject({occupancy:{active:false},counts:{release:1}});
      const b=f.merges.start(f.owner.id,"active-upgrade",f.selection,f.conf,true,1,false,"publish_only",scope.digest);
      const source=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id),batch=f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(b.id),timeline=f.store.getTimeline(f.item.key);
      f.db.exec("DROP INDEX integration_queue_available; DROP INDEX integration_queue_owner; ALTER TABLE merge_delivery_projection DROP COLUMN processing_batch_id; DELETE FROM schema_migrations WHERE version=202611140247;");
      await f.app.close();reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});
      const merges=new MergeDeliveries(reopened.missionGoStore),q=merges.queue(f.item.productId,f.owner.id);
      expect(q.occupancy).toEqual({active:true,sessionId:b.sessionId,requestKey:b.requestKey});expect(q.deliveries).toEqual([]);expect(q.counts.release??0).toBe(0);
      const db=reopened.missionGoStore.database.connection;
      expect(db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id)).toEqual(source);
      expect(db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(b.id)).toEqual(batch);
      expect(reopened.missionGoStore.getTimeline(f.item.key)).toEqual(timeline);
    }finally{await reopened?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("AND-520 publishes the same complete candidates while selected and extra deliveries are owned",async()=>{
    const f=await mergedProject(["web"]),before=f.merges.releaseCandidates(f.item.productId);
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    const b=f.merges.start(f.owner.id,"full-candidates-owned",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.releaseCandidates(f.item.productId)).toEqual(before);
    expect(f.merges.batch(f.owner.id,b.dispatchId,b.id).references?.[f.d.id]?.batchId).toBe(f.original.id);
  });
  it("AND-520 refreshes ended reference history when a later batch supplies formal publication receipts",async()=>{
    const f=await mergedProject(["web"]),scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    const b=f.merges.start(f.owner.id,"deferred-reference-history",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Historical reference",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"history",reason:"Read existing merge",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    for(const command of f.db.prepare("SELECT id FROM agent_session_commands WHERE session_id=? AND status='queued'").all(b.sessionId) as {id:string}[])
      new AgentSessionStore(f.store.database).recordSnapshot({nodeId:f.node.nodeId,sessionId:b.sessionId,status:"active",messages:[],turnState:{turnActive:true},commandId:command.id,commandStatus:"delivered"});
    const snapshot=f.merges.preview(f.owner.id,b.id).snapshot;
    f.merges.requestReconciliation(f.owner.id,b.dispatchId,b.id,"defer-history",snapshot,{kind:"defer_publication",reason:"Explicit synthetic human choice"});
    f.merges.decideReconciliation(f.owner.id,b.id,"defer-history",snapshot,"approved",true);
    f.merges.applyReconciliation(f.owner.id,b.dispatchId,b.id,"defer-history");f.merges.finish(f.owner.id,b.dispatchId,b.id);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);
    f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:"later-publication",deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    expect(f.merges.batches(f.item.productId,f.owner.id).find(row=>row.id===b.id)!.presentation.entries[f.d.id]!.publication).toBe("published");
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
  });
  it("keeps merge-only work visible after source input; partial receipts stay pending until every artifact is covered",async()=>{
    const f=await mergedProject();
    expect(f.merges.list(f.item.productId,f.owner.id)).toEqual([]); // old offer API is unchanged
    let q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.counts).toMatchObject({release:1});expect(q.deliveries[0]!.queue.pendingArtifacts).toEqual(["web","macosApp"]);
    new AgentSessionStore(f.store.database).enqueue(f.owner.id,f.projectSessionId,"A new topic",[]);
    expect(f.merges.queue(f.item.productId,f.owner.id).counts).toMatchObject({release:1});
    const record=(artifact:string,key:string)=>f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:key,deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:f.d.id,expectedRevision:f.d.revision,releases:[{artifact,version:"1",sourceCommit:"e".repeat(40)}]}]});
    record("web","web");q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"release",publishedArtifacts:["web"],pendingArtifacts:["macosApp"]});
    record("macosApp","mac");expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.queue(f.item.productId,f.owner.id,"history").deliveries).toHaveLength(1);
    expect(f.merges.queue(f.item.productId,f.other.id).deliveries).toEqual([]);
    const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string};
    expect(JSON.parse(original.data_json).batchId).toBe(f.original.id);
  });
  it("runs publish-only through immutable references, forbids repeat report/repair and requires fresh reference validation",async()=>{
    const f=await mergedProject();const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.blockers).toEqual([]);
    const b=f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(current.references?.[f.d.id]?.batchId).toBe(f.original.id);expect(current.entries[0]!.mergeReady).toBe(false);
    expect(()=>f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Do not repeat"})).toThrow();
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);return current;};
    act({kind:"plan",base:"b".repeat(40),summary:"Verify historical integration",validation:"Live target",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"published",reason:"Historical reference",validation:"Verify ancestor"}]});
    expect(()=>act({kind:"prepare_repair",deliveryId:f.d.id,expectedHead:f.d.head,base:"b".repeat(40),reason:"Must not mutate historical PR"})).toThrow();
    expect(()=>act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Missing reference verification",source:"Synthetic"})).toThrow();
    expect(()=>f.merges.recordCombinedValidation(f.owner.id,b.dispatchId,b.id,{head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Cannot bypass references",source:"Synthetic"})).toThrow(/独立核实/);
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live Git ancestor verification"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified live target",source:"Synthetic"});
    act({kind:"publication_progress",state:"publishing",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Synthetic publication start"});
    act({kind:"publication_progress",state:"ended",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Synthetic end without receipt"});
    expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow(/发布凭据/);
    expect(f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,true,1,false,"publish_only",scope.digest).id).toBe(b.id);
    expect(()=>f.merges.start(f.owner.id,"publish-only",f.selection,f.conf,false,1,false,"merge_only")).toThrow();
  });
  it("refuses stale preview and blocks new unreviewed candidates before publication",async()=>{
    const f=await mergedProject(),old=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(()=>f.merges.start(f.owner.id,"bad-scope",f.selection,f.conf,true,1,false,"publish_only","wrong")).toThrow();
    const b=f.merges.start(f.owner.id,"reviewed",f.selection,f.conf,true,1,false,"publish_only",old.digest);f.launchBatch(b);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Read references",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"history",reason:"Already merged",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic Git"});
    act({kind:"final_validation",head:"c".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    const claim=await f.call("claim_item",f.claimInput);f.safe(claim);
    f.safe(await f.complete({sessionId:claim.structuredContent!.sessionId!}));
    expect(()=>act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:current.resultsDigest,detail:"Not authorized for new candidate"})).toThrow(/范围/);
  });
  it("combines pending PRs and historical references without changing the source batch",async()=>{
    const f=await mergedProject();const d=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"second",{...f.input,pullRequest:13,summary:"New pending change"});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const selection=[...f.selection,{id:d.id,revision:d.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,"mixed",selection,f.conf,true,1,false,"merge_and_publish",scope.digest);f.launchBatch(b);
    const batch=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    expect(batch.results[f.d.id]!.status).toBe("merged");expect(batch.results[d.id]).toBeUndefined();
    const history=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id) as {data_json:string};expect(JSON.parse(history.data_json).batchId).toBe(f.original.id);
    expect(()=>f.merges.start(f.owner.id,"wrong-publish-only",selection,f.conf,true,1,false,"publish_only",scope.digest)).toThrow();
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries.some(row=>row.id===d.id)).toBe(false);
    let current=batch;
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Mixed plan",validation:"Combination",entries:[f.d,d].map(v=>({deliveryId:v.id,head:v.head,dependsOn:[],group:"mixed",reason:"Synthetic",validation:"Verify"}))});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic target ancestor"});
    act({kind:"check",deliveryId:d.id,expectedHead:d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live checks",checks:"passed",mergeable:"clean",local:"passed",validation:"Synthetic local and CI"});
    expect(current.prerequisiteGate.ready).toBe(true);
    act(syntheticPrerequisites(current));
    current=f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"d".repeat(40),detail:"New merge only"});
    act({kind:"final_validation",head:"d".repeat(40),checkedAt:new Date().toISOString(),validation:"Mixed target verified",source:"Synthetic"});
    expect(()=>act({kind:"publication_progress",state:"publishing",resultsDigest:current.resultsDigest,checkedAt:new Date().toISOString(),detail:"Own new merge is within the frozen scope"})).not.toThrow();

  });
  it("paginates queue history with account-scoped counts without reading event bodies",async()=>{
    const f=await mergedProject();const spy=vi.spyOn(f.store,"getTimeline").mockImplementation(()=>{throw Error("No hot history reads");});
    try{expect(f.merges.queue(f.item.productId,f.owner.id,"release",undefined,1).nextBeforeSequence).toBeTypeOf("number");expect(f.merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);}finally{spy.mockRestore();}
  });
  it("rebuilds queue metadata once on upgrade without rewriting immutable delivery history",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"and511-queue-migration-")),path=join(dir,"data.sqlite");
    let reopened:ReturnType<typeof buildApp>|undefined;
    try {
      const f=await mergedProject(["web"],path);
      const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id);
      f.db.exec("DROP INDEX integration_queue_stage; DELETE FROM schema_migrations WHERE version=202611120007;");
      f.db.prepare("UPDATE merge_delivery_projection SET data_json=json_remove(data_json,'$.queue')").run();
      await f.app.close();
      reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});
      const merges=new MergeDeliveries(reopened.missionGoStore);
      expect(merges.queue(f.item.productId,f.owner.id).counts.release).toBe(1);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id)).toEqual(original);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611120007").get()).toMatchObject({count:1});
    }finally{await reopened?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("reclassifies existing cached queue rows on lifecycle upgrade without changing source evidence",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"queue-lifecycle-upgrade-")),path=join(dir,"data.sqlite");
    let reopened:ReturnType<typeof buildApp>|undefined;
    try {
      const f=await mergedProject(["web"],path);
      const original=f.db.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id);
      f.db.exec("DELETE FROM schema_migrations WHERE version=202611121510");
      f.db.prepare("UPDATE merge_delivery_projection SET data_json=json_set(data_json,'$.queue.stage','history')").run();
      await f.app.close();
      reopened=buildApp({databasePath:path,adminAccount:config,writeTools:"comments",statusCheckTime:false});
      expect(new MergeDeliveries(reopened.missionGoStore).queue(f.item.productId,f.owner.id).counts.release).toBe(1);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT data_json FROM merge_deliveries WHERE id=?").get(f.d.id)).toEqual(original);
      expect(reopened.missionGoStore.database.connection.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=202611121510").get()).toMatchObject({count:1});
    } finally {await reopened?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("requires receipts for unselected but reviewed extra coverage before completing publication",async()=>{
    const f=await mergedProject(["web"]);
    const d=f.merges.propose(f.owner.id,"original-client",{dispatchId:f.dispatch.id},"extra",{...f.input,pullRequest:14,summary:"Extra merged change"});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const old=f.merges.start(f.owner.id,"extra-merge",[{id:d.id,revision:d.revision}],f.conf,false);f.launchBatch(old);
    f.merges.report(f.owner.id,old.dispatchId,old.id,d.id,{status:"merged",head:d.head,commit:"d".repeat(40),detail:"Synthetic extra merge"});f.merges.finish(f.owner.id,old.dispatchId,old.id);
    const scope=f.merges.publicationPreview(f.owner.id,f.item.productId,f.selection);
    expect(scope.candidates.find(c=>c.deliveryId===d.id)?.selected).toBe(false);
    const b=f.merges.start(f.owner.id,"publish-all",f.selection,f.conf,true,1,false,"publish_only",scope.digest);f.launchBatch(b);
    expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.presentation.ownedExtras).toMatchObject([{id:d.id,pendingArtifacts:["web"]}]);
    let current=f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries['integrate']>[5])=>{current=f.merges.integrate(f.owner.id,b.dispatchId,b.id,current.integration!.revision,randomUUID(),action);};
    act({kind:"plan",base:"b".repeat(40),summary:"Read selected reference",validation:"Verify",entries:[{deliveryId:f.d.id,head:f.d.head,dependsOn:[],group:"history",reason:"Already merged",validation:"Verify"}]});
    act({kind:"verify_reference",deliveryId:f.d.id,expectedHead:f.d.head,commit:"c".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic Git"});
    act({kind:"final_validation",head:"d".repeat(40),checkedAt:new Date().toISOString(),validation:"Verified",source:"Synthetic"});
    const receipt=(delivery:typeof f.d,key:string)=>f.merges.recordRelease(f.owner.id,"original-client",{productId:f.item.productId,idempotencyKey:key,deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),deliveries:[{deliveryId:delivery.id,expectedRevision:delivery.revision,releases:[{artifact:"web",version:"1",sourceCommit:"e".repeat(40)}]}]});
    receipt(f.d,"selected-receipt");expect(()=>f.merges.finish(f.owner.id,b.dispatchId,b.id)).toThrow(/Extra merged change/);
    receipt(d,"extra-receipt");expect(f.merges.finish(f.owner.id,b.dispatchId,b.id).state).toBe("finished");
  });

  it("projects per-item partial receipts with the exact development event and leaves acceptance to people",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"item-scope",{...f.input,requiredArtifacts:["web","macosApp"]});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,"item-merge",[{id:d.id,revision:d.revision}],f.config,false);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Synthetic item merge"});f.merges.finish(f.owner.id,b.dispatchId,b.id);
    const completion={kind:"github" as const,url:d.pullRequestUrl},event=f.store.getDeliveryRecords(f.item.key)[0]!;
    const release=(artifact:string)=>f.store.submitForVerification({itemKey:f.item.key,developmentEventId:event.id,completion,releases:[{artifact,version:"1",sourceCommit:"e".repeat(40)}],deployedCommit:"e".repeat(40),receiptDigest:"f".repeat(64),idempotencyKey:`item-${artifact}`});
    release("web");const q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.deliveries[0]!.queue).toMatchObject({stage:"release",publishedArtifacts:["web"],pendingArtifacts:["macosApp"],records:[{itemKey:f.item.key,developmentEventId:event.id,roundKey:event.roundKey}]});
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    release("macosApp");expect(f.merges.queue(f.item.productId,f.owner.id).deliveries).toEqual([]);expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
  });
  it("keeps queue and preview scoped to the account, rejects malformed actions and preserves the read snapshot",async()=>{
    const f=await mergedProject();
    const login=async(email:string)=>{const r=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:email,password:"synthetic password"}});return r.headers["set-cookie"]!.toString().split(";")[0]!;};
    const owner=await login(f.owner.email),other=await login(f.other.email);
    expect((await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue`,headers:{cookie:owner}})).json().counts.release).toBe(1);
    expect((await f.app.inject({method:"GET",url:`/api/v1/products/${f.item.productId}/integration-queue`,headers:{cookie:other}})).json().deliveries).toEqual([]);
    const before=f.snapshot();
    const preview=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:owner},payload:{selection:f.selection}});
    expect(preview.statusCode).toBe(200);expect(f.snapshot()).toEqual(before);
    const denied=await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:other},payload:{selection:f.selection}});expect(denied.statusCode).toBe(409);
    expect((await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/merge-batches`,headers:{cookie:owner},payload:{...f.conf,requestKey:"invalid-action",selection:f.selection,publish:true,operation:"arbitrary"}})).statusCode).toBe(400);
    f.grant(false,true);
    expect((await f.app.inject({method:"POST",url:`/api/v1/products/${f.item.productId}/integration-preview`,headers:{cookie:owner},payload:{selection:f.selection}})).statusCode).toBe(404);
  });

});

describe("AND-520 item-linked intermediate lifecycle",()=>{
  it("AND-520 item-backed merged delivery stays owned while its original batch remains active",async()=>{
    const f=await prepared();f.merges.decide(f.owner.id,f.d.id,f.d.revision,"confirm");
    const b=f.merges.start(f.owner.id,"audit-item-active",[{id:f.d.id,revision:f.d.revision}],f.config,false);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(f.node.nodeId);ds.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    f.merges.report(f.owner.id,b.dispatchId,b.id,f.d.id,{status:"merged",head:f.d.head,commit:"c".repeat(40),detail:"Synthetic integration"});
    const q=f.merges.queue(f.item.productId,f.owner.id);
    expect(q.counts.release??0).toBe(0);expect(q.deliveries).toEqual([]);
    expect(f.store.getWorkItem(f.item.key).status).toBe("development_complete");
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.state).toBe("active");
  });
  it("AND-520 no-release work does not create a separate exception before normal batch handover finishes",async()=>{
    const f=await prepared();
    const d=f.merges.propose(f.owner.id,"original-client",f.identity,"audit-no-release",{...f.input,requiredArtifacts:[],noReleaseReason:"Only test fixtures"});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const b=f.merges.start(f.owner.id,"audit-no-release-active",[{id:d.id,revision:d.revision}],f.config,false);
    const ds=new DispatchStore(f.store.database);ds.claimNextDispatch(f.node.nodeId);ds.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,{status:"merged",head:d.head,commit:"c".repeat(40),detail:"Synthetic integration awaiting normal handover"});
    const q=f.merges.queue(f.item.productId,f.owner.id,"review");
    expect(q.counts.review??0).toBe(0);expect(q.deliveries).toEqual([]);
    const context=f.merges.reviewContext(f.owner.id,d.id);expect(context.queue.blocker).toContain("无需发布交接证据待核实");
    expect(()=>f.merges.startReview(f.owner.id,d.id,d.revision,context.queue.review!.scopeDigest,"no-duplicate-review",f.config)).toThrow(/活动集成批次/);
    expect(f.merges.batches(f.item.productId,f.owner.id)[0]!.state).toBe("active");
  });
});

describe("AND-539 frozen delivery identity succession",()=>{
  async function mergedFixture(itemCount=1,precompleted=false) {
    const f=await prepared(),keys=[f.item.key],session={...f.session,sessionRef:randomUUID()};
    let identity:Identity={};
    for(let i=0;i<itemCount;i++) {
      if(i)keys.push(f.store.createWorkItem({productId:f.item.productId,title:`Same PR ${i}`,description:"Synthetic",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}).key);
      const claim=await f.call("claim_item",{...f.claimInput,itemKey:keys[i],session,idempotencyKey:`successor-claim-${i}`});f.safe(claim);
      identity={sessionId:claim.structuredContent!.sessionId!};
    }
    if(precompleted)f.safe(await f.call("submit_development_complete",{itemKey:keys[0],...identity,completion:{kind:"github",url:`${f.input.repository}/pull/${f.input.pullRequest}`},requiredArtifacts:["androidApp","web"],idempotencyKey:"existing-first-item"}));
    const d=f.merges.propose(f.owner.id,"original-client",identity,"two-artifact-offer",{...f.input,itemKeys:keys,requiredArtifacts:["androidApp","web"]});
    f.merges.decide(f.owner.id,d.id,d.revision,"confirm");
    const selection=[{id:d.id,revision:d.revision}],scope=f.merges.publicationPreview(f.owner.id,f.item.productId,selection);
    const b=f.merges.start(f.owner.id,randomUUID(),selection,f.config,true,1,false,"merge_and_publish",scope.digest);
    const dispatches=new DispatchStore(f.store.database);dispatches.claimNextDispatch(f.node.nodeId);dispatches.recordDispatchResult({nodeId:f.node.nodeId,dispatchId:b.dispatchId,status:"launched"});
    const current=()=>f.merges.batch(f.owner.id,b.dispatchId,b.id);
    const act=(action:Parameters<MergeDeliveries["integrate"]>[5],key=randomUUID())=>f.merges.integrate(f.owner.id,b.dispatchId,b.id,current().integration!.revision,key,action);
    act({kind:"plan",base:"b".repeat(40),summary:"Approved two-artifact delivery",validation:"Combination",entries:[{deliveryId:d.id,head:d.head,dependsOn:[],group:"one",reason:"Frozen PR",validation:"Regression"}]});
    act(syntheticPrerequisites(current()));
    act({kind:"check",deliveryId:d.id,expectedHead:d.head,base:"b".repeat(40),checkedAt:new Date().toISOString(),source:"Synthetic live Git",checks:"passed",mergeable:"clean",local:"passed",validation:"Passed"});
    const result={status:"merged" as const,head:d.head,commit:"c".repeat(40),detail:"Verified synthetic merge"};
    f.merges.report(f.owner.id,b.dispatchId,b.id,d.id,result);
    const raw=()=>JSON.parse((f.db.prepare("SELECT data_json FROM merge_batches WHERE id=?").get(b.id) as {data_json:string}).data_json);
    const preview=()=>f.merges.preview(f.owner.id,b.id);
    return {...f,keys,d,b,current,act,result,raw,preview};
  }
  it.each([1,2])("reuses the original Android+Web scope for %i item(s), audits once, and offers no redundant review",async count=>{
    const f=await mergedFixture(count),before=f.raw(),original=before.publicationScope;
    expect(f.preview().publicationIdentity).toMatchObject({unchanged:true,transitions:expect.arrayContaining(f.keys.map(itemKey=>expect.objectContaining({itemKey,deliveryId:f.d.id,fromIdentity:`selection:${f.d.id}`,commit:f.result.commit})))});
    expect(f.preview().publicationRefresh).toBeUndefined();
    expect(before.publicationTransitions).toHaveLength(count);
    f.merges.report(f.owner.id,f.b.dispatchId,f.b.id,f.d.id,f.result);
    f.preview();f.preview();expect(f.raw().publicationTransitions).toEqual(before.publicationTransitions);
    f.act({kind:"final_validation",head:f.result.commit,checkedAt:new Date().toISOString(),source:"Synthetic target",validation:"Combination passed"});
    f.act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Original authorization"});
    f.act({kind:"publication_progress",state:"ended",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Publisher stopped"});
    expect(f.raw().publicationScope).toEqual(original);expect(f.raw().reconciliation.requests).toHaveLength(0);
    expect(f.raw().publicationTransitions).toEqual(before.publicationTransitions);
    expect(()=>f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id)).toThrow(/发布/);
    const records=f.keys.map(key=>({key,r:f.store.getDeliveryRecords(key)[0]!}));
    expect(f.store.submitReleaseBatch({productId:f.item.productId,idempotencyKey:"two-artifact-release",deployedCommit:f.result.commit,receiptDigest:"d".repeat(64),attribution:{accountId:f.owner.id,clientId:"original-client"},items:records.map(({key,r})=>({itemKey:key,expectedRevision:f.store.getWorkItem(key).revision,developmentEventId:r.id,roundKey:r.roundKey!,completion:r.completion!,releases:["web","androidApp"].map(artifact=>({artifact,version:"test",sourceCommit:f.result.commit}))}))}).results.every(r=>r.outcome==="submitted")).toBe(true);
    expect(f.preview().publicationIdentity?.unchanged).toBe(true);
    expect(f.merges.finish(f.owner.id,f.b.dispatchId,f.b.id).state).toBe("finished");
  });
  it("AND-539 preserves an existing event while inheriting only the still-pending item of the same PR",async()=>{
    const f=await mergedFixture(2,true);
    expect(f.preview().publicationIdentity).toMatchObject({unchanged:true,transitions:[expect.objectContaining({itemKey:f.keys[1]})]});
    expect(f.preview().publicationRefresh).toBeUndefined();
    const frozen=f.raw().publicationScope;
    expect(frozen.candidates.filter((c:{itemKey?:string})=>c.itemKey===f.keys[0])).toHaveLength(1);
    expect(frozen.candidates.find((c:{deliveryId?:string})=>c.deliveryId===f.d.id).pendingItemKeys).toEqual([f.keys[1]]);
    f.act({kind:"final_validation",head:f.result.commit,checkedAt:new Date().toISOString(),source:"Synthetic target",validation:"Combination passed"});
    expect(()=>f.act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Same frozen item set"})).not.toThrow();
    expect(f.raw().publicationScope).toEqual(frozen);
  });
  it.each(["artifacts","round","missing","ambiguous","added","replaced"])("rejects %s changes instead of treating them as record renames",async mode=>{
    const f=await mergedFixture(),r=f.store.getDeliveryRecords(f.item.key)[0]!;
    const event=f.store.getTimeline(f.item.key).find(e=>e.id===r.id)!;
    if(mode==="added") {
      const created=await f.call("submit_development_complete",{itemKey:f.item.key,sessionId:f.d.sessionId,completion:{kind:"github",url:`${f.d.repository}/pull/99`},requiredArtifacts:["web"],idempotencyKey:"extra-event"});f.safe(created);
    } else if(mode==="ambiguous") {
      f.db.prepare("INSERT INTO work_item_events(id,item_id,event_type,actor_kind,payload_json,created_at) VALUES (?,?,?,?,?,?)")
        .run(randomUUID(),f.item.id,"delivery_recorded","agent",JSON.stringify(event.payload),new Date().toISOString());
    } else if(mode==="replaced") f.db.prepare("UPDATE work_item_events SET id=? WHERE id=?").run(randomUUID(),r.id);
    else if(mode==="missing") f.db.prepare("DELETE FROM work_item_events WHERE id=?").run(r.id);
    else f.db.prepare("UPDATE work_item_events SET payload_json=? WHERE id=?").run(JSON.stringify({...event.payload,...(mode==="artifacts"?{requiredArtifacts:["web"]}:{roundKey:randomUUID()})}),r.id);
    expect(f.preview().publicationIdentity?.unchanged).toBe(false);
    f.act({kind:"final_validation",head:f.result.commit,checkedAt:new Date().toISOString(),source:"Synthetic target",validation:"Combination"});
    expect(()=>f.act({kind:"publication_progress",state:"publishing",checkedAt:new Date().toISOString(),resultsDigest:f.current().resultsDigest,detail:"Must remain blocked"})).toThrow();
    expect(f.raw().publicationTransitions).toHaveLength(1);
  });
});
