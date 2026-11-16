import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ConsolePerformance } from "./console-performance.js";
import { afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "./admin-auth.js";
import { buildApp } from "./app.js";
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture(){
 const app=buildApp({adminAccount:{id:"owner",username:"owner@example.invalid",passwordScrypt:hashPassword("synthetic-password"),sessionSecret:"synthetic-signing",cookieSecure:false},performance:{enabled:true,path:":memory:"},dingtalkWorker:false,release:"fixture-build"});apps.push(app);
 const member=app.missionGoAccounts.createAccount({email:"member@example.invalid",password:"synthetic-password",role:"member"});
 const product=app.missionGoStore.createProduct({name:"Visible",keyPrefix:"VIS"}),hidden=app.missionGoStore.createProduct({name:"Hidden",keyPrefix:"HID"});
 app.missionGoAccounts.grantCreatorPermissions(member.id,product.id);
 const login=async(username:string)=>{const r=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password:"synthetic-password"}});return {cookie:r.headers["set-cookie"]!.split(";",1)[0]!};};
 const headers=await login(member.email),owner=await login("owner@example.invalid");
 for(let i=0;i<50;i++){const r=await app.inject({url:"/api/v1/console/performance",headers});if(r.json().status.ready)break;await new Promise(r=>setTimeout(r,20));}
 const post=(productId:string,events:unknown)=>app.inject({method:"POST",url:"/api/v1/console/performance",headers,payload:{productId,events}});
 return {app,member,headers,owner,product,hidden,post};
}
it("only the authenticated owner's authorized product metrics are visible, including after revocation",async()=>{
 const f=await fixture(),event={id:"synthetic-stable",stage:"submit",result:"success",durationMs:22.6};
 expect((await f.post(f.product.id,[event])).statusCode).toBe(202);expect((await f.post(f.product.id,[event])).statusCode).toBe(202);
 const r=await f.app.inject({url:`/api/v1/console/performance?to=${Date.now()+1}`,headers:f.headers});expect(r.statusCode).toBe(200);expect(r.json().rows).toHaveLength(1);expect(r.json().rows[0].n).toBe(1);
 const other=await f.app.inject({url:"/api/v1/console/performance",headers:f.owner});expect(other.json().rows).toEqual([]);expect(other.body).not.toContain(f.product.id);
 expect((await f.post(f.hidden.id,[event])).statusCode).toBe(404);
 f.app.missionGoStore.database.connection.prepare("DELETE FROM product_administrators WHERE account_id=?").run(f.member.id);
 f.app.missionGoStore.database.connection.prepare("DELETE FROM account_products WHERE account_id=?").run(f.member.id);
 expect((await f.app.inject({url:"/api/v1/console/performance",headers:f.headers})).json().rows).toEqual([]);
});
it("rejects free text, invalid duration, excess payload and missing authentication",async()=>{
 const f=await fixture();
 for(const event of [{id:"x",stage:"submit",result:"success",message:"sensitive"},{id:"x",stage:"submit",result:"success",durationMs:-1},{id:"x",stage:"arbitrary",result:"success"}])expect((await f.post(f.product.id,[event])).statusCode).toBe(400);
 expect((await f.post(f.product.id,Array.from({length:33},()=>({id:"x",stage:"submit",result:"success"})))).statusCode).toBe(400);
 expect((await f.app.inject({url:"/api/v1/console/performance"})).statusCode).toBe(401);
 expect((await f.app.inject({url:"/api/v1/console/performance?from=0&to=999999999999999",headers:f.headers})).statusCode).toBe(400);
});

it("rechecks account authorization after the asynchronous report even when no rows exist",async()=>{
 const f=await fixture();
 vi.spyOn(ConsolePerformance.prototype,"report").mockImplementation(async()=>{
  f.app.missionGoAccounts.updateAccount(f.member.id,{disabled:true});
  return {status:{enabled:true,ready:true,degraded:false},rows:[],coverage:[],complete:false};
 });
 const result=await f.app.inject({url:"/api/v1/console/performance",headers:f.headers});expect(result.statusCode).toBe(401);
});

it("authenticates account-feed observations and prevents browser forgery of server measurements",async()=>{
 const f=await fixture();
 const list={protocol:1,device:"phone",scenario:"first_entry",dataset:"account_feed",visitId:"visit-528"};
 const post=(events:unknown,extra:Record<string,unknown>={})=>f.app.inject({method:"POST",url:"/api/v1/console/performance",headers:f.headers,payload:{list:true,events,...extra}});
 expect((await post([{id:"start",stage:"list_visit",result:"success",list}])).statusCode).toBe(202);
 expect((await post([{id:"forged",stage:"list_server",result:"success",durationMs:0,list}])).json().queued).toBe(0);
 expect((await post([{id:"wrong-scope",stage:"list_visit",result:"success",list}],{productId:f.product.id})).statusCode).toBe(400);
 expect((await post([{id:"sensitive",stage:"list_visit",result:"success",list:{...list,message:"private"}}])).statusCode).toBe(400);
 const r=await f.app.inject({url:`/api/v1/console/performance?to=${Date.now()+1}`,headers:f.headers});expect(r.json().rows.find((r:any)=>r.stage==="list_visit").n).toBe(1);
 expect((await f.app.inject({url:"/api/v1/console/performance",headers:f.owner})).json().rows).toEqual([]);
 const actual=await f.app.inject({url:"/api/v1/agent-sessions",headers:{...f.headers,"x-missiongo-list-observation":JSON.stringify({...list,rows:999,responseBytes:999,dataset:"project_view"})}});expect(actual.statusCode).toBe(200);
 const serverReport=await f.app.inject({url:`/api/v1/console/performance?to=${Date.now()+1}`,headers:f.headers});
 const row=serverReport.json().rows.find((r:any)=>r.stage==="list_server");expect(row.dimensions.dataset).toBe("account_feed");expect(row.measures.rows.total).toBe(0);expect(row.measures.responseBytes.total).toBe(Buffer.byteLength(actual.body));
 expect(JSON.stringify(serverReport.json())).not.toContain("visit-528");
});

it("keeps Windows native delivery separate from account-list observations",async()=>{
  const f=await fixture(),database=f.app.missionGoStore.database;
  const node=new DispatchStore(database).registerNode({accountId:f.member.id,name:"Windows fixture",installationId:"windows-performance"});
  const item=f.app.missionGoStore.createWorkItem({productId:f.product.id,title:"Metrics fixture",description:"",type:"task",priority:"normal"});
  database.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('windows-performance-dispatch',?,?,'codex','default','launched','synthetic',?)`).run(f.member.id,node.nodeId,new Date().toISOString());
  database.connection.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('windows-performance-dispatch',?,0)").run(item.id);
  const sessions=new AgentSessionStore(database),sessionId=sessions.createForDispatch({dispatchId:"windows-performance-dispatch",nodeId:node.nodeId,sessionRef:"windows-thread"});
  const command=sessions.enqueue(f.member.id,sessionId,"synthetic"),headers={authorization:`Bearer ${node.token}`};
  const result=await f.app.inject({method:"POST",url:`/api/v1/node/agent-sessions/${sessionId}/performance`,headers,payload:{commandId:command.id,platform:"windows",version:"fixture",events:[{id:"windows-delivery",stage:"native_delivery",result:"success",durationMs:7}]}});
  expect(result.statusCode,result.body).toBe(202);expect(result.json().queued).toBe(1);
  await f.app.inject({url:"/api/v1/agent-sessions",headers:f.headers});
  const report=await f.app.inject({url:`/api/v1/console/performance?to=${Date.now()+1}`,headers:f.headers});
  expect(report.json().rows).toEqual(expect.arrayContaining([expect.objectContaining({source:"windows",stage:"native_delivery",n:1}),expect.objectContaining({source:"server",stage:"list_server"})]));
  expect(report.json().rows.some((row:any)=>row.source === "linux" && row.stage === "native_delivery")).toBe(false);
});
