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


it("retains exact submitted versions, approval facts and original execution boundaries",async()=>{
  const f=await fixture();
  const args={itemKeys:[f.item.key],session:f.session,summary:"Version one",markdown:"Version one\n\nExact original body.",idempotencyKey:"v1"};
  const one=(await f.call("prepare_plan_document",args)).structuredContent;
  const first=await f.request({documentId:one.documentId,plan:one.plan,validation:""});
  await f.approve(first.sessionId,first.revision);
  const two=(await f.call("prepare_plan_document",{...args,summary:"Version two",markdown:"Version two\n\nNew Android scope.",idempotencyKey:"v2"})).structuredContent;
  // Merely preparing a document does not register a new pending proposal.
  const url=`/api/v1/agent-sessions/${first.sessionId}/plan-records`;
  const get=(suffix="")=>f.app.inject({url:url+suffix,headers:f.headers});
  let page=(await get()).json();
  expect(page.records).toHaveLength(1);expect(page.records[0]).toMatchObject({documentId:one.documentId,effective:true,current:true});
  expect(page.records[0].markdown).toBeUndefined();
  expect((await get(`?recordId=${page.records[0].id}`)).json().records[0].markdown).toBe(args.markdown);
  await f.request({documentId:two.documentId,plan:two.plan,validation:""});
  page=(await get()).json();expect(page.records).toHaveLength(2);
  expect(page.records[0]).toMatchObject({documentId:two.documentId,current:true,effective:false});
  expect(page.records[1]).toMatchObject({documentId:one.documentId,current:false,effective:false,approval:{source:"web"}});
  expect((await f.approve(first.sessionId,first.revision)).statusCode).toBe(409);
  const second=(await f.get(first.sessionId)).json();
  await f.approve(first.sessionId,second.planApproval.revision);
  const note=(await f.call("prepare_plan_document",{...args,parentDocumentId:two.documentId,summary:"Rework note",markdown:"Rework note\n\nNo new scope.",idempotencyKey:"note"})).structuredContent;
  page=(await get()).json();expect(page.records[0]).toMatchObject({documentId:note.documentId,kind:"rework",parentDocumentId:two.documentId,parentApproved:true,current:false});
  const repeated=(await f.call("prepare_plan_document",{...args,parentDocumentId:two.documentId,summary:"Rework note",markdown:"Rework note\n\nNo new scope.",idempotencyKey:"note-same-body-new-version"})).structuredContent;
  expect(repeated.documentId).not.toBe(note.documentId);
  expect((await get()).json().records.filter((record:{kind:string})=>record.kind==="rework")).toHaveLength(2);
  expect(page.records.find((r:{documentId:string})=>r.documentId===two.documentId)).toMatchObject({effective:true});
  // History is read-only: no duplicate approval or snapshot is manufactured on reads/retries.
  await f.request({documentId:two.documentId,plan:two.plan,validation:""});
  expect((await get()).json().records).toHaveLength(4);
  expect((await f.app.inject({url})).statusCode).toBe(401);
  expect((await get("?recordId=0")).statusCode).toBe(400);
  expect((await get("?before=invalid")).statusCode).toBe(400);
  expect((await get("?recordId=999999")).statusCode).toBe(404);
});

it("paginates submitted legacy versions without merging or inventing their content",async()=>{
  const f=await fixture();let id="";
  for(let n=0;n<23;n++) id=(await f.request({plan:`Legacy exact ${n}`,validation:`Check ${n}`})).sessionId;
  const url=`/api/v1/agent-sessions/${id}/plan-records`;
  const first=(await f.app.inject({url,headers:f.headers})).json();
  expect(first.records).toHaveLength(20);expect(first.nextBefore).toBeDefined();
  const second=(await f.app.inject({url:url+`?before=${first.nextBefore}`,headers:f.headers})).json();
  expect(second.records).toHaveLength(3);expect(second.nextBefore).toBeUndefined();
  const last=second.records.at(-1);
  const read=(await f.app.inject({url:url+`?recordId=${last.id}`,headers:f.headers})).json().records[0];
  expect(read.plan).toBe("Legacy exact 0");expect(read.validation).toBe("Check 0");expect(read.approval).toBeUndefined();
  expect(first.historyIncomplete).toBe(false);
  expect(()=>f.store.database.connection.prepare("UPDATE implementation_plan_versions SET proposal_json='{}'").run()).toThrow("immutable");
});

it("cannot read a record from another conversation or another account",async()=>{
 const f=await fixture();
 const first=await f.request({plan:"Original private record"});
 const url=`/api/v1/agent-sessions/${first.sessionId}/plan-records`;
 const record=(await f.app.inject({url,headers:f.headers})).json().records[0];
 const second=await f.request({session:{...f.session,sessionRef:"different-native-thread"},plan:"Other conversation"});
 const denied=await f.app.inject({url:`/api/v1/agent-sessions/${second.sessionId}/plan-records?recordId=${record.id}`,headers:f.headers});
 expect(denied.statusCode).toBe(404);expect(denied.body).not.toContain("Original private record");
 const other=f.app.missionGoAccounts.createAccount({email:"record-outsider@example.test",password:"fixture-password",role:"member"});
 const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:other.email,password:"fixture-password"}});
 const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
 const outsider=await f.app.inject({url,headers:{cookie}});
 expect(outsider.statusCode).toBe(404);expect(outsider.body).not.toContain("Original private record");
});

it("ordinary attention classification does not become formal version history",async()=>{
 const f=await fixture();
 const first=await f.request();
 const {ImplementationPlans}=await import("./implementation-plans.js");
 const db=f.store.database.connection;
 const row=db.prepare("SELECT identity_key FROM implementation_plan_requests LIMIT 1").get() as {identity_key:string};
 new ImplementationPlans(f.store.database).request(config.id,row.identity_key,"attention-only",{keys:[f.item.key],plan:"Ordinary discussion",validation:"",origin:"attention"});
 const response=await f.app.inject({url:`/api/v1/agent-sessions/${first.sessionId}/plan-records`,headers:f.headers});
 expect(response.json().records).toHaveLength(1);
 expect(response.body).not.toContain("attention-only");
});
