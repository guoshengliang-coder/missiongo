import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken, hashPassword } from "./admin-auth.js";
import { Collaborations } from "./collaboration.js";
import { ManagedRunStore } from "./managed-run-store.js";
import { ManagedDecisionStore } from "./managed-decision-store.js";

const config={id:"native-human-owner",username:"native-human@example.test",passwordScrypt:hashPassword("fixture password"),sessionSecret:"synthetic-native-human-confirmation-key",cookieSecure:false};
const apps: ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
const meta=(client="codex")=>({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:client,version:"fixture"},"io.modelcontextprotocol/clientCapabilities":{elicitation:{form:{}}}});
async function fixture() {
  const app=buildApp({adminAccount:config,writeTools:"comments",publicOrigin:"https://native.example.test"});apps.push(app);
  const store=app.missionGoStore,db=store.database.connection,accounts=app.missionGoAccounts;
  const sourceProduct=store.createProduct({name:"Source fixture",keyPrefix:"NS"});
  const targetProduct=store.createProduct({name:"Target fixture",keyPrefix:"NT"});
  const source=store.createWorkItem({productId:sourceProduct.id,title:"Source",description:"Source content",status:"ready",type:"requirement",priority:"normal",builderAccountId:config.id,environment:{platform:"shared"}});
  const collaborations=new Collaborations(store);
  const grant=collaborations.configure(config.id,targetProduct.id,{sourceProductId:sourceProduct.id,moduleId:"",builderAccountId:null,enabled:true,expectedRevision:0});
  const body={grantId:grant.id,title:"Exact cross-project request",description:"No internal comments shared",acceptance:"Verify only the shared result",type:"requirement" as const,priority:"normal" as const,attachmentIds:[]};
  const draft=collaborations.prepare(config.id,source.key,body);
  const token=(client="original",id=config.id,scopes=["missiongo:read","missiongo:write"])=>{
    const a=accounts.getAccount(id);return createAiAccessToken(config,{id:a.id,username:a.email,role:a.role},accounts.credentialsStamp(a),client,scopes).token;
  };
  const rpc=async(name:string,args:Record<string,unknown>,extra:Record<string,unknown>={_meta:meta()},bearer=token())=>{
    const r=await app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${bearer}`,accept:"application/json, text/event-stream",...(extra["_meta"]?{"mcp-method":"tools/call","mcp-name":name}:{})},
      payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args,...extra}}});
    const raw=r.headers["content-type"]?.includes("text/event-stream")?r.body.split("\n").find(l=>l.startsWith("data: "))!.slice(6):r.body;
    const parsed=JSON.parse(raw);return parsed.result??{rpcError:parsed.error};
  };
  const args={draftId:draft.id,version:draft.version,idempotencyKey:"native-submit"};
  const accept=(state:string,action="accept")=>({_meta:meta(),requestState:state,inputResponses:{humanConfirmation:{action,content:action==="accept"?{}:null}}});
  const targetCount=()=>store.listWorkItems({productId:targetProduct.id}).length;
  const receipts=()=>db.prepare("SELECT * FROM native_human_confirmations").all();
  const run=new ManagedRunStore(store.database).createRun({accountId:config.id,productIds:[sourceProduct.id]}, {scope:{productId:sourceProduct.id,repositoryRef:"fixture-repo",itemKeys:[source.key],contractRevision:1},idempotencyKey:"run"});
  const decisions=new ManagedDecisionStore(store.database);
  const decision=decisions.create(()=>config.id,{runId:run.id,decisionKey:"implementation",scopeDigest:run.scopeDigest,contractRevision:1,idempotencyKey:"decision",content:{title:"Exact managed decision",recommendation:"Implement locally",alternatives:["Defer"],costs:"Local testing",acceptanceCriteria:["Tests pass"],allowedActions:["implement","verify"]}});
  const decisionArgs={decisionId:decision.id,version:decision.version,stateVersion:decision.stateVersion,contentDigest:decision.contentDigest,scopeDigest:decision.scopeDigest,contractRevision:1,idempotencyKey:"native-managed-approval"};
  return {app,store,db,accounts,sourceProduct,targetProduct,source,collaborations,body,draft,rpc,token,args,accept,targetCount,receipts,decisions,decision,decisionArgs};
}

it.each(["codex","claude_code","opencode"])("uses a bound %s human response and commits one shared collaboration result",async client=>{
  const f=await fixture();const tool="request_collaboration_approval";
  const first=await f.rpc(tool,f.args,{_meta:meta(client)});
  expect(first,JSON.stringify(first)).toMatchObject({resultType:"input_required",requestState:expect.any(String)});
  expect(JSON.stringify(first.inputRequests)).toContain(f.body.description);
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(0);
  const result=await f.rpc(tool,f.args,{...f.accept(first.requestState),_meta:meta(client)});
  expect(result,JSON.stringify(result)).toMatchObject({structuredContent:{approved:true,source:"native",result:{targetKey:expect.any(String)}}});
  expect(f.targetCount()).toBe(1);expect(f.receipts()).toHaveLength(1);
  expect(f.receipts()[0]).toMatchObject({tool_name:tool,target_id:f.draft.id,choice:"accept"});
  const repeated=await f.rpc(tool,f.args,{_meta:meta(client)});
  expect(repeated).toMatchObject({structuredContent:{approved:true,source:"existing"}});expect(repeated.inputRequests).toBeUndefined();
  const web=f.collaborations.submit(config.id,f.draft.id,f.draft.version,"web-repeat");
  expect(web.targetKey).toBe(result.structuredContent.result.targetKey);expect(f.targetCount()).toBe(1);
  expect((await f.rpc(tool,{...f.args,approved:true})).isError).toBe(true);
});

it.each(["decline","cancel"])("persists %s without submitting or asking for the same native decision again",async action=>{
  const f=await fixture(),tool="request_collaboration_approval";
  const first=await f.rpc(tool,f.args);
  const result=await f.rpc(tool,f.args,f.accept(first.requestState,action));
  expect(result).toMatchObject({structuredContent:{approved:false,choice:action}});
  const repeated=await f.rpc(tool,f.args);
  expect(repeated).toMatchObject({structuredContent:{approved:false,choice:action}});expect(repeated.inputRequests).toBeUndefined();
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(1);
});

it("rejects forged, missing, cross-client, changed-version and revoked-permission native responses",async()=>{
  const f=await fixture(),tool="request_collaboration_approval";
  const first=await f.rpc(tool,f.args);
  const missing=await f.rpc(tool,f.args,{_meta:meta(),inputResponses:f.accept(first.requestState).inputResponses});
  expect(missing.isError).toBe(true);
  expect((await f.rpc(tool,f.args,f.accept(first.requestState+"forged"))).rpcError).toBeDefined();
  expect((await f.rpc(tool,f.args,f.accept(first.requestState),f.token("other-client"))).rpcError).toBeDefined();
  expect((await f.rpc(tool,{...f.args,idempotencyKey:"another-action"},f.accept(first.requestState))).isError).toBe(true);
  expect((await f.rpc("request_managed_decision_approval",f.decisionArgs,f.accept(first.requestState))).isError).toBe(true);
  const changed=f.collaborations.prepare(config.id,f.source.key,{...f.body,description:"Changed scope"},"human",undefined,f.draft.id,f.draft.version);
  expect((await f.rpc(tool,{...f.args,version:changed.version},f.accept(first.requestState))).isError).toBe(true);
  const nextArgs={...f.args,version:changed.version,idempotencyKey:"new-version"};
  const next=await f.rpc(tool,nextArgs);
  f.accounts.createAccount({email:"second-admin@example.test",password:"fixture password",role:"admin"});
  f.accounts.updateAccount(config.id,{role:"member"});
  f.accounts.replacePermissions(config.id,[{productId:f.sourceProduct.id,canView:true,canOperate:false,canUseAi:true}],"selected");
  const denied=await f.rpc(tool,nextArgs,f.accept(next.requestState));
  expect(denied.isError??Boolean(denied.rpcError)).toBe(true);
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(0);
});

it("reuses a Web decision won while the native form was pending, including a native cancellation",async()=>{
  const f=await fixture(),tool="request_collaboration_approval";
  const first=await f.rpc(tool,f.args);
  f.collaborations.submit(config.id,f.draft.id,f.draft.version,"web-won");
  const result=await f.rpc(tool,f.args,f.accept(first.requestState,"cancel"));
  expect(result).toMatchObject({structuredContent:{approved:true,source:"existing"}});
  expect(f.targetCount()).toBe(1);expect(f.receipts()).toHaveLength(0);
});

it("rolls the domain write back when its native audit receipt cannot commit",async()=>{
  const f=await fixture(),tool="request_collaboration_approval";
  const first=await f.rpc(tool,f.args);
  f.db.exec("CREATE TRIGGER fail_native_audit BEFORE INSERT ON native_human_confirmations BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;");
  expect((await f.rpc(tool,f.args,f.accept(first.requestState))).isError).toBe(true);
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(0);
  f.db.exec("DROP TRIGGER fail_native_audit");
  expect(await f.rpc(tool,f.args,f.accept(first.requestState))).toMatchObject({structuredContent:{approved:true}});
  expect(f.targetCount()).toBe(1);
});

it("keeps complete content when forms are unavailable and does not expose approval tools to read-only scope",async()=>{
  const f=await fixture(),tool="request_collaboration_approval";
  const unsupported=await f.rpc(tool,f.args,{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"unsupported",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}});
  expect(unsupported).toMatchObject({structuredContent:{approved:false,code:"native_confirmation_unavailable",content:{draft:{description:f.body.description}}}});
  const readOnly=await f.rpc(tool,f.args,undefined,f.token("read-client",config.id,["missiongo:read"]));
  expect(readOnly.isError??Boolean(readOnly.rpcError)).toBe(true);
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(0);
});

it("approves only the exact managed decision and never restores a revoked approval",async()=>{
  const f=await fixture(),tool="request_managed_decision_approval";
  const first=await f.rpc(tool,f.decisionArgs);
  expect(f.decisions.get(()=>config.id,f.decision.id).status).toBe("pending");
  expect(await f.rpc(tool,f.decisionArgs,f.accept(first.requestState))).toMatchObject({structuredContent:{approved:true,source:"native"}});
  const approved=f.decisions.get(()=>config.id,f.decision.id);
  expect(approved.status).toBe("approved");expect(f.receipts()).toHaveLength(1);
  expect(await f.rpc(tool,f.decisionArgs)).toMatchObject({structuredContent:{approved:true,source:"existing"}});
  f.decisions.change(()=>config.id,approved.id,"revoke",{version:approved.version,stateVersion:approved.stateVersion,contentDigest:approved.contentDigest,scopeDigest:approved.scopeDigest,contractRevision:1,idempotencyKey:"human-revoked"});
  expect((await f.rpc(tool,f.decisionArgs,f.accept(first.requestState))).isError).toBe(true);
  expect(f.decisions.get(()=>config.id,approved.id).status).toBe("revoked");
});

it("rejects stale managed content, expired proof and changed native receipt request keys",async()=>{
  const f=await fixture(),tool="request_managed_decision_approval";
  const first=await f.rpc(tool,f.decisionArgs);
  const old=f.decision;
  f.decisions.change(()=>config.id,old.id,"revise",{...f.decisionArgs,idempotencyKey:"revise",content:{...old.content,costs:"Changed costs"}});
  expect((await f.rpc(tool,f.decisionArgs,f.accept(first.requestState))).isError).toBe(true);
  const collab=await f.rpc("request_collaboration_approval",f.args);
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+3_700_000);
  expect((await f.rpc("request_collaboration_approval",f.args,f.accept(collab.requestState))).rpcError).toBeDefined();
  expect(f.targetCount()).toBe(0);expect(f.receipts()).toHaveLength(0);
});

it("does not let an operator approve another Builder's draft, or reuse a declined request key for another draft",async()=>{
  const f=await fixture();
  const other=f.accounts.createAccount({email:"operator-only@example.test",password:"fixture password",role:"member"});
  f.accounts.replacePermissions(other.id,[{productId:f.sourceProduct.id,canView:true,canOperate:true,canUseAi:true}]);
  const denied=await f.rpc("request_collaboration_approval",f.args,undefined,f.token("operator",other.id));
  expect(denied.isError).toBe(true);expect(denied.inputRequests).toBeUndefined();
  const first=await f.rpc("request_collaboration_approval",f.args);
  await f.rpc("request_collaboration_approval",f.args,f.accept(first.requestState,"decline"));
  const next=f.collaborations.prepare(config.id,f.source.key,{...f.body,title:"A different target request"});
  expect((await f.rpc("request_collaboration_approval",{...f.args,draftId:next.id,version:next.version})).isError).toBe(true);
  expect(f.targetCount()).toBe(0);
});
