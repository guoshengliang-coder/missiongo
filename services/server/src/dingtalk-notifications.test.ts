import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { DingTalkNotifications } from "./dingtalk-notifications.js";
import { MissionGoStore } from "./store.js";
import { AccountStore } from "./accounts-store.js";

const apps:FastifyInstance[]=[];const dirs:string[]=[];
const password="synthetic notification password",secret="synthetic-notification-encryption-key",passwordScrypt=hashPassword(password);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture() {
  const requests:Array<{url:string;body:Record<string,unknown>}>=[];
  let send:()=>Promise<Response>=async()=>Response.json({errcode:0,task_id:123});
  let result:Record<string,unknown>={errcode:0,send_result:{unread_user_id_list:["employee-one"]}};
  const fetchImpl=vi.fn(async(url:unknown,init?:RequestInit)=>{
    requests.push({url:String(url),body:JSON.parse(String(init?.body??"{}"))});
    if(String(url).includes("/gettoken"))return Response.json({errcode:0,access_token:"synthetic-token",expires_in:7200});
    if(String(url).includes("/getsendresult"))return Response.json(result);
    return send();
  }) as unknown as typeof fetch;
  const app=buildApp({dingtalkFetch:fetchImpl,dingtalkWorker:false,publicOrigin:"https://example.test",adminAccount:{id:"admin",username:"admin@example.test",passwordScrypt,sessionSecret:secret,cookieSecure:false}});apps.push(app);
  const login=async(username:string)=>{const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password}});return response.headers["set-cookie"]!.toString().split(";")[0]!;};
  const cookie=await login("admin@example.test"),store=app.missionGoStore,accounts=app.missionGoAccounts;
  const product=store.createProduct({name:"Notice project",keyPrefix:"NT",createdByAccountId:"admin"});
  store.setProductReleaseArtifacts(product.id,["web"]);
  const member=accounts.createAccount({email:"person@example.test",role:"member",password});accounts.changeOwnNickname(member.id,"测试提需者");
  accounts.replacePermissions(member.id,[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]);
  const memberCookie=await login(member.email),db=store.database.connection;
  const service=new DingTalkNotifications(store,accounts,secret,"https://example.test",fetchImpl);
  const call=(method:"GET"|"POST"|"PUT",url:string,payload?:unknown,auth=cookie)=>app.inject({method,url,headers:{cookie:auth},...(payload===undefined?{}:{payload})});
  const config=()=>service.saveSettings({corpId:"synthetic-corp",clientId:"synthetic-app",agentId:"123",clientSecret:"synthetic-client-secret",expectedRevision:0},"admin");
  const bind=()=>service.saveBinding(member.id,{userId:"employee-one",name:"测试人员",department:"测试部门"},null,"admin");
  const enable=()=>service.saveProject(product.id,accounts.getAccount("admin"),true,false);
  const create=(accountId:string|undefined=member.id)=>store.createWorkItem({productId:product.id,title:"A verification item",description:"Details",type:"requirement",priority:"normal",...(accountId?{attribution:{accountId}}:{})});
  const verify=(itemKey:string)=>store.transitionWorkItem({itemKey,to:"pending_verification",actor:"human",reason:"manual_override"});
  const due=()=>db.prepare("UPDATE dingtalk_notifications SET next_at='2000-01-01T00:00:00.000Z'").run();
  return {app,store,accounts,db,service,product,member,memberCookie,requests,fetchImpl,call,config,bind,enable,create,verify,due,setSend:(value:typeof send)=>{send=value;},setResult:(value:typeof result)=>{result=value;}};
}
describe("DingTalk configuration and mappings",()=>{
  it("protects admin endpoints, encrypts secrets, checks revisions and keeps mappings attached to account IDs",async()=>{
    const f=await fixture();
    expect((await f.call("GET","/api/v1/dingtalk/settings",undefined,f.memberCookie)).statusCode).toBe(404);
    expect((await f.app.inject({method:"GET",url:"/api/v1/dingtalk/settings"})).statusCode).toBe(401);
    const response=await f.call("PUT","/api/v1/dingtalk/settings",{corpId:"synthetic-corp",clientId:"synthetic-app",agentId:"123",clientSecret:"synthetic-client-secret",expectedRevision:0});
    expect(response.statusCode).toBe(200);expect(response.body).not.toContain("synthetic-client-secret");
    expect(JSON.stringify(f.db.prepare("SELECT * FROM dingtalk_settings").get())).not.toContain("synthetic-client-secret");
    expect(()=>f.service.saveSettings({corpId:"synthetic-corp",clientId:"synthetic-app",agentId:"123",expectedRevision:0},"admin")).toThrow(/配置已被修改/);
    f.bind();f.accounts.updateAccount(f.member.id,{email:"renamed@example.test"});expect(f.service.bindings()[0]?.accountId).toBe(f.member.id);
    expect(()=>f.service.saveBinding("admin",{userId:"employee-one",name:"",department:""},null,"admin")).toThrow(/已绑定其他账号/);
    expect(()=>f.service.saveBinding("admin",{userId:"one,two",name:"",department:""},null,"admin")).toThrow(/只能填写一个/);
    expect(()=>f.service.saveSettings({corpId:"other-org",clientId:"synthetic-app",agentId:"123",clientSecret:"new-synthetic-secret",expectedRevision:1},"admin")).toThrow(/解除现有人员绑定/);
    const binding=f.service.bindings()[0]!;f.service.saveBinding(f.member.id,null,binding.revision,"admin");
    expect(f.service.bindings()).toEqual([]);expect(f.db.prepare("SELECT count(*) AS n FROM dingtalk_audit").get()).toMatchObject({n:3});
    const check=await f.call("POST","/api/v1/dingtalk/check");expect(check.statusCode).toBe(200);
    expect(f.requests.every(r=>!r.url.includes("/user/"))).toBe(true);
  });
  it("previews batch issues and refuses stale previews without partial writes",async()=>{
    const f=await fixture();f.config();
    const rows=[{email:f.member.email,userId:"employee-one",name:"员工",department:"测试"},{email:"missing@example.test",userId:"employee-two",name:"",department:""}];
    const preview=f.service.preview(rows);expect(preview.rows[1]?.issue).toBe("MissionGo 账号不存在");
    expect(()=>f.service.importBindings(rows,preview.fingerprint,"admin")).toThrow(/所有问题/);expect(f.service.bindings()).toEqual([]);
    const valid=[rows[0]!],before=f.service.preview(valid);f.accounts.updateAccount(f.member.id,{email:"changed@example.test"});
    expect(()=>f.service.importBindings(valid,before.fingerprint,"admin")).toThrow(/重新预览/);
    valid[0]={...valid[0]!,email:"changed@example.test"};const fresh=f.service.preview(valid);expect(f.service.importBindings(valid,fresh.fingerprint,"admin")).toHaveLength(1);
    expect(f.service.preview([valid[0]!,valid[0]!]).rows[1]?.issue).toMatch(/重复/);
  });
  it("never reuses an in-flight token from a different application configuration",async()=>{
    const f=await fixture();f.config();
    const resolvers=new Map<string,(response:Response)=>void>();
    const fetchMock=vi.fn((url:unknown)=>new Promise<Response>(resolve=>resolvers.set(new URL(String(url)).searchParams.get("appkey")!,resolve)));
    const service=new DingTalkNotifications(f.store,f.accounts,secret,"https://example.test",fetchMock as unknown as typeof fetch);
    const old=service.checkConnection().catch(()=>"configuration changed");
    service.saveSettings({corpId:"synthetic-corp",clientId:"new-synthetic-app",agentId:"124",clientSecret:"new-synthetic-client-secret",expectedRevision:1},"admin");
    const fresh=service.checkConnection();expect(resolvers.size).toBe(2);
    resolvers.get("synthetic-app")!(Response.json({errcode:0,access_token:"old-synthetic-token",expires_in:7200}));
    resolvers.get("new-synthetic-app")!(Response.json({errcode:0,access_token:"new-synthetic-token",expires_in:7200}));
    expect(await old).toBe("configuration changed");await fresh;await service.checkConnection();expect(fetchMock).toHaveBeenCalledTimes(2);await service.close();
  });
  it("scopes the project switch and test notices without requiring directory access",async()=>{
    const f=await fixture();f.config();f.bind();
    const url=`/api/v1/products/${f.product.id}/dingtalk`;
    expect((await f.call("PUT",url,{enabled:true,expectedEnabled:false},f.memberCookie)).statusCode).toBe(403);
    f.accounts.replaceProjectAdministrators(f.product.id,[f.member.id],[],"admin");
    expect((await f.call("PUT",url,{enabled:true,expectedEnabled:false},f.memberCookie)).statusCode).toBe(200);
    expect((await f.call("PUT",url,{enabled:false,expectedEnabled:false})).statusCode).toBe(409);
    const first=await f.call("POST",`/api/v1/dingtalk/bindings/${f.member.id}/test`);expect(first.statusCode).toBe(200);
    expect((await f.call("POST",`/api/v1/dingtalk/bindings/${f.member.id}/test`)).statusCode).toBe(429);
    await f.service.drain();expect(f.requests.at(-1)?.body).toMatchObject({userid_list:"employee-one",to_all_user:false,msg:{msgtype:"text"}});
    expect(Object.values(f.service.tests())[0]?.status).toBe("accepted");
    f.due();await f.service.drain();expect(Object.values(f.service.tests())[0]?.status).toBe("sent");
    const binding=f.service.bindings()[0]!;
    f.service.saveBinding(f.member.id,{userId:"employee-corrected",name:"",department:""},binding.revision,"admin");
    expect(f.service.tests()).toEqual({});
  });
});
describe("durable verification notification delivery",()=>{
  it("keeps queue writes atomic and leases sends across workers",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();const item=f.create();
    expect(()=>f.store.database.transaction(()=>{f.verify(item.key);throw new Error("synthetic rollback");})).toThrow("synthetic rollback");
    expect(f.store.getWorkItem(item.key).status).toBe("inbox");expect(f.service.list(item.id)).toEqual([]);
    f.verify(item.key);const second=new DingTalkNotifications(f.store,f.accounts,secret,"https://example.test",f.fetchImpl);
    await Promise.all([f.service.drain(),second.drain()]);expect(f.requests.filter(request=>request.url.includes("asyncsend_v2"))).toHaveLength(1);await second.close();
    const another=f.create();f.verify(another.key);f.db.prepare("UPDATE dingtalk_notifications SET status='sending',lease_until='2000-01-01' WHERE item_id=?").run(another.id);
    await f.service.drain();expect(f.service.list(another.id)[0]?.status).toBe("uncertain");expect(f.requests.filter(request=>request.url.includes("asyncsend_v2"))).toHaveLength(1);
  });
  it("names personally authorized AI submissions and sends to that account without altering the actor",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();
    const item=f.store.createDerivedWorkItem({productId:f.product.id,title:"Assisted submission",description:"Details",type:"requirement",priority:"normal",status:"inbox",agentName:"Synthetic Agent",attribution:{accountId:f.member.id,clientId:"synthetic-client"},idempotencyKey:"synthetic-ai-item"});
    const response=await f.call("GET",`/api/v1/items/${item.key}`);expect(response.json().createdBy).toMatchObject({kind:"agent",accountId:f.member.id,name:"测试提需者",agentName:"Synthetic Agent"});
    f.verify(item.key);await f.service.drain();expect(f.requests.at(-1)?.body.userid_list).toBe("employee-one");
  });
  it("ignores a late result from an expired send after a deliberate retry",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();const item=f.create();f.verify(item.key);
    let deliver:(response:Response)=>void=()=>{},started:()=>void=()=>{};
    const sending=new Promise<void>(resolve=>{started=resolve;});
    f.setSend(()=>new Promise<Response>(resolve=>{deliver=resolve;started();}));
    const old=f.service.drain();await sending;
    f.db.prepare("UPDATE dingtalk_notifications SET lease_until='2000-01-01' WHERE item_id=?").run(item.id);
    const second=new DingTalkNotifications(f.store,f.accounts,secret,"https://example.test",f.fetchImpl);
    await second.drain();expect(second.list(item.id)[0]?.status).toBe("uncertain");
    second.retry(item.key,second.list(item.id)[0]!.id,"admin");f.setSend(async()=>Response.json({errcode:0,task_id:999}));await second.drain();
    deliver(Response.json({errcode:40014}));await old;
    expect(second.list(item.id)[0]?.status).toBe("accepted");expect(f.db.prepare("SELECT task_id FROM dingtalk_notifications WHERE item_id=?").get(item.id)).toMatchObject({task_id:"999"});await second.close();
  });
  it("rechecks permissions after waiting for a network credential",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();const item=f.create();f.verify(item.key);
    let release:(response:Response)=>void=()=>{};
    const fetchMock=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));
    const service=new DingTalkNotifications(f.store,f.accounts,secret,"https://example.test",fetchMock as unknown as typeof fetch);
    const pending=service.drain();f.accounts.replacePermissions(f.member.id,[]);release(Response.json({errcode:0,access_token:"synthetic-token",expires_in:7200}));await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(service.list(item.id)[0]?.reason).toContain("没有项目查看权限");await service.close();
  });
  it("does not backfill disabled rounds, sends one message per new entry and only marks confirmed results as sent",async()=>{
    const f=await fixture();f.config();f.bind();const item=f.create();f.verify(item.key);
    expect(f.service.list(item.id)[0]?.status).toBe("skipped");f.enable();await f.service.drain();expect(f.requests).toHaveLength(0);
    f.store.transitionWorkItem({itemKey:item.key,to:"ready",actor:"human",reason:"verification_failed",note:"Needs another round"});f.verify(item.key);
    await Promise.all([f.service.drain(),f.service.drain()]);
    expect(f.requests.filter(r=>r.url.includes("asyncsend_v2"))).toHaveLength(1);
    const message=f.requests.at(-1)!.body.msg as {action_card:{title:string;single_url:string}};
    expect(message.action_card.title).toBe("你提出的条目已进入待验证");expect(message.action_card.single_url).toContain(`item=${item.key}`);
    expect(f.service.list(item.id)[0]?.status).toBe("accepted");
    f.setResult({errcode:0,send_result:{}});f.due();await f.service.drain();expect(f.service.list(item.id)[0]?.status).toBe("accepted");
    f.setResult({errcode:0,send_result:{unread_user_id_list:["employee-one"]}});f.due();await f.service.drain();expect(f.service.list(item.id)[0]?.status).toBe("sent");
    expect(()=>f.service.retry(item.key,f.service.list(item.id)[0]!.id,"admin")).toThrow(/只能补发/);
    expect(()=>f.verify(item.key)).toThrow();expect(f.service.list(item.id)).toHaveLength(2);
  });
  it("uses release evidence and the matching development summary for published wording",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();const item=f.create();
    f.store.transitionWorkItem({itemKey:item.key,to:"in_progress",actor:"human",reason:"manual_override"});
    const completion={kind:"commit" as const,commit:"a".repeat(40),targetBranch:"main"};
    f.store.submitDevelopmentComplete({itemKey:item.key,completion,requiredArtifacts:["web"],summary:"Fixed the reported behavior",idempotencyKey:"synthetic-completion"});
    f.store.submitForVerification({itemKey:item.key,completion,deployedCommit:"b".repeat(40),receiptDigest:"c".repeat(64),releases:[{artifact:"web",version:"synthetic-v1",sourceCommit:"b".repeat(40)}],idempotencyKey:"synthetic-verification"});
    await f.service.drain();const msg=JSON.stringify(f.requests.at(-1)?.body.msg);
    expect(msg).toContain("已发布");expect(msg).toContain("synthetic-v1");expect(msg).toContain("Fixed the reported behavior");
  });
  it("rechecks current access, account activity, bindings and stale rounds before sending",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();
    const denied=f.create();f.verify(denied.key);f.accounts.replacePermissions(f.member.id,[]);await f.service.drain();expect(f.service.list(denied.id)[0]?.reason).toContain("没有项目查看权限");
    f.accounts.replacePermissions(f.member.id,[{productId:f.product.id,canView:true,canOperate:true,canUseAi:true}]);
    const stale=f.create();f.verify(stale.key);f.store.transitionWorkItem({itemKey:stale.key,to:"done",actor:"human",reason:"verification_passed"});await f.service.drain();expect(f.service.list(stale.id)[0]?.reason).toContain("离开本轮");
    const disabled=f.create();f.verify(disabled.key);f.accounts.updateAccount(f.member.id,{disabled:true});await f.service.drain();expect(f.service.list(disabled.id)[0]?.reason).toContain("停用");
    f.accounts.updateAccount(f.member.id,{disabled:false});const binding=f.service.bindings()[0]!;f.service.saveBinding(f.member.id,null,binding.revision,"admin");const unbound=f.create();f.verify(unbound.key);await f.service.drain();expect(f.service.list(unbound.id)[0]?.reason).toContain("未绑定");
    const unknown=f.create("");f.verify(unknown.key);await f.service.drain();expect(f.service.list(unknown.id)[0]?.reason).toContain("未记录具体提需者");expect(f.requests).toHaveLength(0);
  });
  it("does not auto-resend ambiguous requests and supports explicit retry after a binding correction",async()=>{
    const f=await fixture();f.config();f.bind();f.enable();const item=f.create();f.verify(item.key);
    f.setSend(async()=>{throw new Error("synthetic network interruption");});await f.service.drain();expect(f.service.list(item.id)[0]?.status).toBe("uncertain");
    f.due();await f.service.drain();expect(f.requests.filter(r=>r.url.includes("asyncsend_v2"))).toHaveLength(1);
    f.setSend(async()=>Response.json({errcode:0,task_id:124}));f.service.retry(item.key,f.service.list(item.id)[0]!.id,"admin");await f.service.drain();
    expect(f.service.list(item.id)[0]?.status).toBe("accepted");
    f.setResult({errcode:0,send_result:{forbidden_list:[{userid:"employee-one",code:"limit",count:1}]}});f.due();await f.service.drain();expect(f.service.list(item.id)[0]?.status).toBe("queued");
    f.due();await f.service.drain();f.due();await f.service.drain();expect(f.service.list(item.id)[0]?.status).toBe("failed");
    const other=f.accounts.createAccount({email:"outsider@example.test",role:"member",password});f.accounts.replacePermissions(other.id,[]);
    const response=await f.call("GET",`/api/v1/items/${item.key}/dingtalk-notifications`,undefined,await (async()=>{const login=await f.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:other.email,password}});return login.headers["set-cookie"]!.toString().split(";")[0]!;})());expect(response.statusCode).toBe(404);
  });
  it("persists credentials, mappings and pending sends across reopening without enqueueing old events",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"missiongo-dingtalk-"));dirs.push(dir);const path=join(dir,"store.sqlite");
    let store=new MissionGoStore(path),accounts=new AccountStore(store.database);
    const admin=accounts.createAccount({email:"persistent@example.test",password,role:"admin"});const product=store.createProduct({name:"Persistent",keyPrefix:"PS",createdByAccountId:admin.id});
    let service=new DingTalkNotifications(store,accounts,secret,"https://example.test",async()=>Response.json({errcode:0,access_token:"synthetic-token",expires_in:7200}) as never);
    service.saveSettings({corpId:"synthetic-corp",clientId:"synthetic-app",agentId:"123",clientSecret:"synthetic-client-secret",expectedRevision:0},admin.id);
    service.saveBinding(admin.id,{userId:"persistent-user",name:"",department:""},null,admin.id);service.saveProject(product.id,admin,true,false);
    const item=store.createWorkItem({productId:product.id,type:"task",priority:"normal",title:"Persistent queue",description:"Details",attribution:{accountId:admin.id}});store.transitionWorkItem({itemKey:item.key,to:"pending_verification",actor:"human",reason:"manual_override"});
    store.close();expect(readFileSync(path).includes(Buffer.from("synthetic-client-secret"))).toBe(false);
    store=new MissionGoStore(path);accounts=new AccountStore(store.database);const fetchMock=vi.fn(async(url:unknown)=>String(url).includes("gettoken")?Response.json({errcode:0,access_token:"synthetic-token",expires_in:7200}):Response.json({errcode:0,task_id:17}));
    service=new DingTalkNotifications(store,accounts,secret,"https://example.test",fetchMock as unknown as typeof fetch);
    try{expect(service.settings().configured).toBe(true);expect(service.bindings()).toHaveLength(1);expect(service.list(item.id)).toHaveLength(1);await service.drain();expect(service.list(item.id)[0]?.status).toBe("accepted");}
    finally{await service.close();store.close();}
  });
});
