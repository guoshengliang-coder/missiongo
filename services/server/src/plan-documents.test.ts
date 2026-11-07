import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";

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

it("keeps one document across MCP, Web, offline approval and idempotent comment attachment", async()=>{
  const f=await fixture();
  const summary="**建议：修复导出进度与取消恢复。**\n\n| 问题 | 诊断结论 | 修改建议 |\n|---|---|---|\n| 无进度 | 已确认 | 分阶段显示 |\n| 无法取消 | 已确认 | 安全取消与重试 |\n| 完成仍等待 | 尚未复现 | 补充恢复验证 |\n\n**范围：** 仅客户端，保留完整性检查。\n\n**验证：** 取消不破坏已有文件；完成状态需实测。";
  const markdown=summary+"\n\n## 验证\n\n模拟断线恢复；真实新消息应继续更新时间。\n";
  const args={itemKeys:[f.item.key],session:f.session,summary,markdown,idempotencyKey:"doc-one"};
  const prepared=await f.call("prepare_plan_document",args);
  expect(prepared.isError,JSON.stringify(prepared)).not.toBe(true);
  const doc=prepared.structuredContent;
  expect(doc.plan.startsWith(summary+"\n")).toBe(true);
  expect((await f.call("prepare_plan_document",args)).structuredContent).toEqual(doc);
  expect((await f.call("prepare_plan_document",{...args,markdown:markdown+"changed"})).isError).toBe(true);
  expect((await f.call("get_plan_document",{documentId:doc.documentId})).structuredContent.text).toBe(markdown);
  const web=await f.app.inject({url:`/api/v1/plan-documents/${doc.documentId}`,headers:f.headers});
  expect(web.statusCode).toBe(200);expect(web.json()).toMatchObject({markdown,sha256:doc.sha256});
  expect((await f.app.inject({url:`/api/v1/plan-documents/${doc.documentId}`})).statusCode).toBe(401);
  expect((await f.app.inject({url:`/api/v1/plan-documents/${doc.documentId}?download=1`,headers:f.headers})).body).toBe(markdown);
  expect((await f.call("append_comment",{itemKey:f.item.key,planDocumentId:doc.documentId,idempotencyKey:"archive-before"})).isError).toBe(true);
  expect((await f.call("request_plan_approval",{...f.proposal,documentId:doc.documentId,plan:doc.plan+"changed",validation:""})).isError).toBe(true);
  const proposal=await f.request({documentId:doc.documentId,plan:doc.plan,validation:""});
  expect((await f.get(proposal.sessionId)).json().implementationPlan).toMatchObject({plan:doc.plan,documentId:doc.documentId});
  expect((await f.approve(proposal.sessionId,proposal.revision)).statusCode).toBe(201);
  const resumed=await f.request({documentId:doc.documentId,plan:doc.plan,validation:"",approvalMethod:"native"});
  expect(resumed).toMatchObject({approved:true,documentMarkdown:markdown,documentSha256:doc.sha256});
  const commentWrite=vi.spyOn(f.store,"createComment").mockImplementationOnce(()=>{throw new Error("Temporary comment failure after attachment upload");});
  expect((await f.call("append_comment",{itemKey:f.item.key,planDocumentId:doc.documentId,idempotencyKey:"archive-failed"})).isError).toBe(true);
  commentWrite.mockRestore();
  const archived=await f.call("append_comment",{itemKey:f.item.key,planDocumentId:doc.documentId,agentName:"Fixture",summary:"Approved plan",idempotencyKey:"archive-after"});
  expect(archived.isError,JSON.stringify(archived)).not.toBe(true);
  const comment=archived.structuredContent.comment;
  expect(comment.body.text).toBe(doc.plan);expect(comment.body.attachmentIds).toHaveLength(1);
  const again=await f.call("append_comment",{itemKey:f.item.key,planDocumentId:doc.documentId,agentName:"Fixture",idempotencyKey:"archive-retry"});
  expect(again.structuredContent.comment.id).toBe(comment.id);
  const attachment=await f.call("get_attachment",{itemKey:f.item.key,attachmentId:comment.body.attachmentIds[0]});
  expect(JSON.stringify(attachment)).toContain("模拟断线恢复");
  const changed=await f.call("prepare_plan_document",{...args,idempotencyKey:"doc-two",markdown:markdown+"\n新范围"});
  expect(changed.structuredContent.version).toBe(2);
  await f.request({documentId:changed.structuredContent.documentId,plan:changed.structuredContent.plan,validation:""});
  expect((await f.approve(proposal.sessionId,proposal.revision)).statusCode).toBe(409);
  expect((await f.call("append_comment",{itemKey:f.item.key,planDocumentId:changed.structuredContent.documentId,idempotencyKey:"unapproved-new"})).isError).toBe(true);
  expect((await f.call("get_plan_document",{documentId:doc.documentId})).structuredContent.text).toBe(markdown);
});

it("binds exact scope and identity, preserves Unicode pages and forbids document mutation",async()=>{
  const f=await fixture();
  const summary="诊断🙂"; const markdown=summary+"\n"+"长文🧪".repeat(2000);
  const args={itemKeys:[f.item.key],session:f.session,summary,markdown,idempotencyKey:"unicode"};
  const d=(await f.call("prepare_plan_document",args)).structuredContent;
  let offset=0,text="";
  do {
    const page=(await f.call("get_plan_document",{documentId:d.documentId,offset,limit:1001})).structuredContent;
    text+=page.text; offset=page.nextOffset;
  } while(offset!==undefined);
  expect(text).toBe(markdown);
  const wrong=await f.call("request_plan_approval",{...f.proposal,session:{...f.session,sessionRef:"different"},documentId:d.documentId,plan:d.plan,validation:""});
  expect(wrong.isError).toBe(true);
  expect(()=>f.store.database.connection.prepare("UPDATE plan_documents SET document_json='{}' WHERE id=?").run(d.documentId)).toThrow("immutable");
  expect((await f.call("prepare_plan_document",{...args,idempotencyKey:"wrong-prefix",markdown:"different"})).isError).toBe(true);
  const readToken=f.tokenFor("reader",["missiongo:read"]);
  expect((await f.call("get_plan_document",{documentId:d.documentId},readToken)).structuredContent.sha256).toBe(d.sha256);
  expect((await f.call("prepare_plan_document",args,readToken)).isError).toBe(true);
});

it("preserves the original approval for bounded rework records without approving a changed plan",async()=>{
  const f=await fixture(); const summary="Repair only the original failure";
  const args={itemKeys:[f.item.key],session:f.session,summary,markdown:summary+"\n\nKeep original boundaries.",idempotencyKey:"original"};
  const doc=(await f.call("prepare_plan_document",args)).structuredContent;
  const proposal=await f.request({documentId:doc.documentId,plan:doc.plan,validation:""});
  await f.approve(proposal.sessionId,proposal.revision);
  // Actual event format, without changing execution ownership in this isolated fixture.
  f.store.database.connection.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,from_status,to_status,payload_json,created_at)
    VALUES ('verification-return',?,'status_changed','human','pending_verification','ready','{"reason":"verification_failed"}',?)`).run(f.item.id,new Date().toISOString());
  const note=(await f.call("prepare_plan_document",{...args,idempotencyKey:"return-note",parentDocumentId:doc.documentId,markdown:args.markdown+"\nReproduce remaining original failure."})).structuredContent;
  expect(note).toMatchObject({recordOnly:true,parentDocumentId:doc.documentId,version:1,rounds:[{key:f.item.key,number:2}]});
  expect((await f.get(proposal.sessionId)).json().implementationPlan).toMatchObject({approved:true,revision:proposal.revision});
  expect((await f.call("request_plan_approval",{...f.proposal,documentId:note.documentId,plan:note.plan,validation:""})).isError).toBe(true);
  expect((await f.call("append_comment",{itemKey:f.item.key,planDocumentId:note.documentId,idempotencyKey:"return-archive"})).isError).not.toBe(true);
  // Requirement edits invalidate both original authority and records referencing it.
  f.store.database.connection.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  expect((await f.call("prepare_plan_document",{...args,idempotencyKey:"changed-scope",parentDocumentId:doc.documentId})).isError).toBe(true);
  expect((await f.call("append_comment",{itemKey:f.item.key,planDocumentId:note.documentId,idempotencyKey:"stale-return"})).isError).toBe(true);
});

it("checks every covered item and denies a reader without product access",async()=>{
  const f=await fixture(); const second=f.create();
  const doc=(await f.call("prepare_plan_document",{itemKeys:[f.item.key,second.key],session:f.session,summary:"Both",markdown:"Both\n\nScope",idempotencyKey:"multi"})).structuredContent;
  const other=f.app.missionGoAccounts.createAccount({email:"plan-outsider@example.test",password:"fixture-password",role:"member"});
  const token=createAiAccessToken(config,{id:other.id,username:other.email,role:other.role},f.app.missionGoAccounts.credentialsStamp(other),"outsider",["missiongo:read"]).token;
  expect((await f.call("get_plan_document",{documentId:doc.documentId},token)).isError).toBe(true);
  const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:other.email,password:"fixture-password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  expect((await f.app.inject({url:`/api/v1/plan-documents/${doc.documentId}`,headers:{cookie}})).statusCode).toBe(404);
  expect((await f.call("request_plan_approval",{...f.proposal,documentId:doc.documentId,plan:doc.plan,validation:""})).isError).toBe(true);
});

it("rejects pending documents from before a verification return without reviving their approval",async()=>{
  const f=await fixture(); const summary="Original pending plan";
  const args={itemKeys:[f.item.key],session:f.session,summary,markdown:summary+"\n\nValidation",idempotencyKey:"old-pending"};
  const doc=(await f.call("prepare_plan_document",args)).structuredContent;
  const proposal=await f.request({documentId:doc.documentId,plan:doc.plan,validation:""});
  f.store.database.connection.prepare(`INSERT INTO work_item_events(id,item_id,event_type,actor_kind,from_status,to_status,payload_json,created_at)
    VALUES ('pending-return',?,'status_changed','human','pending_verification','ready','{"reason":"verification_failed"}',?)`).run(f.item.id,new Date().toISOString());
  expect((await f.get(proposal.sessionId)).json().implementationPlan.valid).toBe(false);
  expect((await f.approve(proposal.sessionId,proposal.revision)).statusCode).toBe(409);
  expect((await f.call("request_plan_approval",{...f.proposal,documentId:doc.documentId,plan:doc.plan,validation:""})).isError).toBe(true);
  const next=(await f.call("prepare_plan_document",{...args,idempotencyKey:"next-round"})).structuredContent;
  expect(next).toMatchObject({version:1,rounds:[{number:2}]});
});
