import { scryptSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AgentSessionStore, type AgentSessionMessageInput } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const evidence = "以上方案等待你批准，批准后开始实施。";

async function fixture(external = false, initialMessages?: AgentSessionMessageInput[]) {
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
  const messages = initialMessages ?? [{ sourceId: "plan", role: "agent" as const, text: "方案：增加快捷按钮并测试。\n" + evidence, occurredAt: now }];
  let id: string;
  if (external) {
    // A native mirror shares the same existing approval attention as its dispatch.
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('dispatch','owner','node','codex','plan','launched','synthetic-repo',?)`).run(now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
    const mirrored = dispatch.createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "thread" });
    dispatch.recordSnapshot({ nodeId: "node", sessionId: mirrored, status: "idle", messages });
    const progress = new ExternalAgentSessionStore(store);
    id = progress.register({ accountId: "owner", clientId: "fixture" }, { agentKind: "codex", sessionRef: "thread", refKind: "native" }, item.key);
    db.prepare("UPDATE external_agent_sessions SET native_node_id='node',native_generation=1,native_synced_at=?,native_snapshot_json=? WHERE id=?")
      .run(now, JSON.stringify({ status: "idle", turnState: {} }), id);
    messages.forEach((message, position) => db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES (?,?,?,?,?)")
      .run("native-" + position, id, message.sourceId, JSON.stringify(message), position));
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
  expect((await f.approve(revision)).statusCode).toBe(201);
  expect((await f.get()).json()).not.toHaveProperty("planApproval");
  const table = external ? "external_native_commands" : "agent_session_commands";
  expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`).get(f.id)).toMatchObject({ n: 1 });
  if (external) expect(new ExternalNativeSessionStore(f.store).overlay("owner", f.id).command?.text).toBe("批准");
});

it("rejects stale content and current permission/connection changes, but does not require AI settings", async () => {
  const f = await fixture();
  const { revision } = await f.offer();
  f.dispatch.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "idle", messages: [{ ...f.messages[0]!, text: "新的方案，等待你批准后开始实施。" }] });
  expect((await f.approve(revision)).statusCode).toBe(409);
  expect((await f.app.inject({ method: "POST", url: `/api/v1/agent-sessions/${f.id}/plan-approval`, payload: { revision } })).statusCode).toBe(401);
  await f.app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers: f.headers, payload: { agentAttentionEnabled: false } });
  const current = await f.offer();
  expect(f.provider).not.toHaveBeenCalled();
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date(Date.now() - 10 * 60_000).toISOString());
  expect((await f.approve(current.revision)).statusCode).toBe(409);
  expect((await f.get()).json()).toMatchObject({ planApprovalStatus: { code: "connection_unavailable" } });
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date().toISOString());
  const online = await f.offer();
  const other = f.store.createProduct({ name: "Other", keyPrefix: "OTHER" });
  f.app.missionGoAccounts.replacePermissions("owner", [{ productId: other.id, canView: true, canOperate: true, canUseAi: true }]);
  expect((await f.approve(online.revision)).statusCode).toBe(403);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({ n: 0 });
});

it("offers approval after two text answers to historical cards, then blocks a new live question with a visible reason", async () => {
  const messages: AgentSessionMessageInput[] = [
    { sourceId: "q1", role: "agent", text: "范围选局部还是全部？", questions: [{ title: "范围", options: ["局部", "全部"] }] },
    { sourceId: "a1", role: "user", text: "全部" },
    { sourceId: "q2", role: "agent", text: "原生还是统一自定义？", questions: [{ title: "实现", options: ["原生", "统一自定义"] }] },
    { sourceId: "a2", role: "user", text: "统一自定义" },
    { sourceId: "plan", role: "agent", text: "方案：全产品统一自定义控件。两项选择已明确，无新增问题。\n" + evidence },
  ];
  const f = await fixture(false, messages);
  const offer = await f.offer();
  expect((await f.get()).json()).toMatchObject({ planApprovalStatus: { code: "ready" } });
  f.dispatch.recordSnapshot({ nodeId: "node", sessionId: f.id, status: "idle", turnState: { waitingForInput: true },
    messages: [...messages, { sourceId: "new-question", role: "agent", text: "还需确定发布范围", questions: [{ title: "发布范围", options: ["Web", "全部"] }] }] });
  const detail = (await f.get()).json();
  expect(detail.planApprovalStatus).toEqual({ code: "not_approval" });
  expect(detail).not.toHaveProperty("planApproval");
  expect((await f.approve(offer.revision)).statusCode).toBe(409);
  expect(f.provider).not.toHaveBeenCalled();
});

it("offers immediately for existing approval attention with long history, even when the AI provider fails", async () => {
  const f = await fixture(false, [
    { sourceId: "old", role: "agent", text: "旧报告".repeat(10_000), questions: [{ title: "旧问题", options: ["A", "B"] }] },
    { sourceId: "plan", role: "plan", text: "无需再次分析的待批准方案。" },
  ]);
  f.provider.mockRejectedValue(new Error("provider unavailable"));
  expect((await f.get()).json()).toMatchObject({ planApprovalStatus: { code: "ready" }, planApproval: { revision: expect.any(String) } });
  expect(f.provider).not.toHaveBeenCalled();
});

it("persists Web approval across service recreation and never grants it for chat or a mode change",async()=>{
 const f=await fixture();
 const {ImplementationPlans}=await import("./implementation-plans.js");
 const plans=new ImplementationPlans(f.store.database);
 const key=plans.dispatchKeys("dispatch")[0]!;
 expect(()=>plans.assertApprovedScope("owner","dispatch:dispatch",key)).toThrow();
 const offer=await f.offer();
 expect(()=>plans.assertApprovedScope("owner","dispatch:dispatch",key)).toThrow();
 expect((await f.approve(offer.revision)).statusCode).toBe(201);
 const fresh=new ImplementationPlans(f.store.database);
 expect(()=>fresh.assertApprovedScope("owner","dispatch:dispatch",key)).not.toThrow();
 const desired=f.dispatch.listForNode("node").find(session=>session.id===f.id)!.desiredSettings!;
 f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:[],mode:"auto",settingsRevision:desired.revision});
 expect(()=>fresh.assertApprovedScope("owner","dispatch:dispatch",key)).not.toThrow();
 const row=f.db.prepare("SELECT source,plan_text FROM implementation_plan_approvals").get();
 expect(row).toMatchObject({source:"web",plan_text:f.messages.at(-1)!.text});
 expect(fresh.commandRevision((await f.get()).json().command.id)).toBe(offer.revision);
});

it("approves a registered external proposal under its original native conversation identity",async()=>{
 const f=await fixture(true);
 const {ImplementationPlans}=await import("./implementation-plans.js");
 const plans=new ImplementationPlans(f.store.database), identity="native:fixture:codex:native:thread";
 const key=f.store.listWorkItems({productId:f.product.id})[0]!.key;
 plans.request("owner",identity,"external-exact-v1",{keys:[key],plan:"Exact external implementation",validation:"Verify external identity"});
 const offered=(await f.get()).json();
 expect(offered.planApproval).toMatchObject({revision:"external-exact-v1",plan:"Exact external implementation",itemKeys:[key]});
 expect((await f.approve("external-exact-v1")).statusCode).toBe(201);
 expect(()=>plans.assertApprovedScope("owner",identity,key)).not.toThrow();
 expect(plans.canImplement("owner",`session:${f.id}`)).toBe(false);
});


it("saves an explicit dispatch plan offline without queuing a continuation and keeps retries idempotent",async()=>{
  const f=await fixture();
  const {ImplementationPlans}=await import("./implementation-plans.js");
  const plans=new ImplementationPlans(f.store.database),identity="dispatch:dispatch";
  const key=plans.dispatchKeys("dispatch")[0]!;
  plans.request("owner",identity,"dispatch-explicit-offline",{keys:[key],plan:"Exact dispatch handoff plan",validation:"Verify offline approval separately from execution"});
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date(Date.now()-10*60_000).toISOString());
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"unavailable",messages:[],error:"Codex rejected thread/read: thread not loaded"});
  expect((await f.get()).json()).toMatchObject({canReply:true,canApprovePlan:true,planApprovalStatus:{code:"ready"},planApproval:{revision:"dispatch-explicit-offline"}});
  const result=await f.approve("dispatch-explicit-offline");
  expect(result.statusCode,result.body).toBe(201);
  expect(result.json()).toMatchObject({approved:true,revision:"dispatch-explicit-offline",continuationQueued:false,continuationPending:true});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
  expect((await f.get()).json()).toMatchObject({canApprovePlan:false,planApprovalState:{approved:true,continuationQueued:false}});
  expect((await f.approve("dispatch-explicit-offline")).json()).toMatchObject({approved:true,continuationQueued:false});
  expect(()=>plans.assertApprovedScope("owner",identity,key)).not.toThrow();
});

async function nodeReport(f: Awaited<ReturnType<typeof fixture>>, payload: Record<string,unknown>) {
  const { createHash } = await import("node:crypto");
  f.db.prepare("UPDATE nodes SET token_hash=? WHERE id='node'").run(createHash('sha256').update('single-plan-node-token').digest('hex'));
  return f.app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${f.id}/snapshot`,
    headers:{authorization:"Bearer single-plan-node-token"},payload:{status:"idle",messages:[],turnActive:false,...payload,...(payload.turnState as Record<string,unknown>)}});
}

it.each(["resume","running","new-input","scope","permission"])("offline Web approval saves once and respects %s on reconnect",async(action)=>{
  const f=await fixture();
  const {ImplementationPlans}=await import("./implementation-plans.js");
  const plans=new ImplementationPlans(f.store.database),keys=plans.dispatchKeys("dispatch");
  plans.request("owner","dispatch:dispatch","offline-plan",{keys,plan:f.messages[0]!.text,validation:"Verify single continuation"});
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date(Date.now()-600_000).toISOString());
  expect((await f.get()).json()).toMatchObject({canApprovePlan:true,planApprovalStatus:{code:"ready"}});
  expect((await f.approve("offline-plan")).json()).toMatchObject({approved:true,continuationQueued:false,continuationPending:true});
  expect((await f.approve("offline-plan")).json()).toMatchObject({approved:true,continuationQueued:false});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date().toISOString());
  if(action==="scope") f.db.prepare("UPDATE work_items SET content_version=content_version+1").run();
  if(action==="permission") f.app.missionGoAccounts.replacePermissions("owner",[{productId:f.product.id,canView:true,canOperate:true,canUseAi:false}]);
  const payload=action==="running" ? {status:"active",turnState:{turnActive:true}} : action==="new-input"
    ? {messages:[{sourceId:"new-user",turnId:"new-turn",role:"user",text:"Wait, change the scope."}]} : {};
  const result=await nodeReport(f,payload);
  expect([204,403]).toContain(result.statusCode);
  await nodeReport(f,{status:"idle",turnState:{turnActive:false}});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands WHERE text='批准'").get()).toMatchObject({n:action==="resume"?1:0});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:1});
});

it("a Web approval during an active turn does not start another turn later",async()=>{
  const f=await fixture();
  const {ImplementationPlans}=await import("./implementation-plans.js");
  const plans=new ImplementationPlans(f.store.database),keys=plans.dispatchKeys("dispatch");
  plans.request("owner","dispatch:dispatch","running-plan",{keys,plan:f.messages[0]!.text,validation:"Keep the existing native turn"});
  await nodeReport(f,{status:"active",turnState:{turnActive:true}});
  expect((await f.approve("running-plan")).json()).toMatchObject({approved:true,continuationQueued:false});
  await nodeReport(f,{status:"idle",turnState:{turnActive:false}});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
});

it.each(["codex","claude_code"])("syncs one %s native plan decision without a continuation or a second Web approval",async(kind)=>{
  const f=await fixture();
  f.db.prepare("UPDATE agent_sessions SET agent_kind=? WHERE id=?").run(kind,f.id);
  const plan={sourceId:"native-plan",role:"plan",turnId:"planning-turn",text:"Implement the exact reviewed behavior and verify all original entry points.",occurredAt:new Date(Date.now()-1000).toISOString()};
  expect((await nodeReport(f,{messages:[plan]})).statusCode).toBe(204);
  const pending=(await f.get()).json();
  expect(pending.implementationPlan).toMatchObject({plan:plan.text,approved:false});
  const accepted=kind==="codex" ? [plan,{sourceId:"native-acceptance",role:"user",turnId:"implementation-turn",text:`PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`,occurredAt:new Date().toISOString()}]
    : [{...plan,phase:"plan_approved"}];
  expect((await nodeReport(f,{status:"active",turnState:{turnActive:true},messages:accepted})).statusCode).toBe(204);
  expect((await f.get()).json()).toMatchObject({canApprovePlan:false,implementationPlan:{approved:true},planApprovalState:{continuationQueued:false}});
  expect((await f.approve(pending.implementationPlan.revision)).json()).toMatchObject({approved:true,continuationQueued:false});
  await nodeReport(f,{messages:accepted});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals WHERE source='native'").get()).toMatchObject({n:1});
  f.db.prepare("UPDATE work_items SET content_version=content_version+1").run();
  await nodeReport(f,{messages:accepted});
  expect((await f.get()).json().implementationPlan).toMatchObject({approved:false,valid:false});
});

it("does not manufacture current approval from an already accepted historical transcript",async()=>{
  const f=await fixture();
  const plan={sourceId:"historical-plan",role:"plan",turnId:"old-plan-turn",text:"A historical plan accepted before today's registered item scope.",occurredAt:"2026-10-01T00:00:00Z"};
  await nodeReport(f,{messages:[plan,{sourceId:"old-decision",role:"user",turnId:"old-implementation",text:`PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`,occurredAt:"2026-10-01T00:01:00Z"}]});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
  const {ImplementationPlans}=await import("./implementation-plans.js");
  const plans=new ImplementationPlans(f.store.database);
  plans.request("owner","dispatch:dispatch","new-scope",{keys:plans.dispatchKeys("dispatch"),plan:plan.text,validation:""});
  await nodeReport(f,{});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:0});
});

it.each(["queued","delivering","delivery_unknown"])("native continuation cancels only an unsent Web handoff (%s)",async(status)=>{
  const f=await fixture();
  const plan={sourceId:"race-plan",role:"plan",turnId:"race-plan-turn",text:"Implement this exact change and preserve the existing working controls.",occurredAt:new Date(Date.now()-1000).toISOString()};
  await nodeReport(f,{messages:[plan]});
  const offer=(await f.get()).json().planApproval;
  const command=(await f.approve(offer.revision)).json();
  expect(command).toMatchObject({status:"queued",text:"批准"});
  f.db.prepare("UPDATE agent_session_commands SET status=? WHERE id=?").run(status,command.id);
  await nodeReport(f,{status:"active",turnState:{turnActive:true},messages:[{sourceId:"race-accept",role:"user",turnId:"race-implementation",text:`PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`,occurredAt:new Date().toISOString()}]});
  expect(f.db.prepare("SELECT status FROM agent_session_commands WHERE id=?").get(command.id)).toMatchObject({status:status==="queued"?"cancelled":status});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM implementation_plan_approvals").get()).toMatchObject({n:1});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:1});
});

it("same-plan history IDs, timestamps and permission changes do not request a second approval",async()=>{
  const f=await fixture();
  const offer=await f.offer();
  await f.approve(offer.revision);
  f.dispatch.recordSnapshot({nodeId:"node",sessionId:f.id,status:"idle",messages:[{...f.messages[0]!,sourceId:"backfilled-plan",occurredAt:new Date().toISOString()}],mode:"default"});
  const detail=(await f.get()).json();
  expect(detail.planApproval).toBeUndefined();
  expect(detail.implementationPlan).toMatchObject({approved:true});
  expect((await f.approve(offer.revision)).json()).toMatchObject({approved:true});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:1});
});

it("Web approval answers a dispatched Claude native Plan wait through the original queue",async()=>{
  const f=await fixture();
  f.db.prepare("UPDATE agent_sessions SET agent_kind='claude_code' WHERE id=?").run(f.id);
  const plan={sourceId:"permission-live-plan",role:"plan",text:"Implement the reviewed change and verify all existing entry points."};
  await nodeReport(f,{status:"active",turnState:{turnActive:true,waitingForInput:true},messages:[plan]});
  const offer=(await f.get()).json().planApproval;
  const command=(await f.approve(offer.revision)).json();
  expect(command).toMatchObject({status:"queued",text:"批准"});
  const {ImplementationPlans}=await import("./implementation-plans.js");
  expect(new ImplementationPlans(f.store.database).commandRevision(command.id)).toBe(offer.revision);
  expect((await f.approve(offer.revision)).json()).toMatchObject({approved:true,continuationQueued:true});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:1});
});

it("archiving and restoring a conversation does not revive its deferred continuation",async()=>{
  const f=await fixture();
  const {ImplementationPlans}=await import("./implementation-plans.js");
  const plans=new ImplementationPlans(f.store.database);
  plans.request("owner","dispatch:dispatch","archive-plan",{keys:plans.dispatchKeys("dispatch"),plan:f.messages[0]!.text,validation:"Preserve user archive intent"});
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date(Date.now()-600_000).toISOString());
  await f.approve("archive-plan");
  f.dispatch.setArchived("owner",f.id,true);
  f.dispatch.setArchived("owner",f.id,false);
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='node'").run(new Date().toISOString());
  await nodeReport(f,{});
  expect(f.db.prepare("SELECT state FROM implementation_plan_continuations").get()).toMatchObject({state:"cancelled"});
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toMatchObject({n:0});
});
