import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(auth=false) {
 const dir=await mkdtemp(join(tmpdir(),"console-sse-"));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const config={id:"owner",username:"owner@example.invalid",passwordScrypt:hashPassword("synthetic-password"),sessionSecret:"synthetic-test-signing-secret",cookieSecure:false};
 const app=buildApp({databasePath:join(dir,"test.sqlite"),attachmentsPath:join(dir,"attachments"),dingtalkWorker:false,...(auth?{adminAccount:config}:{})});
 const origin=await app.listen({host:"127.0.0.1",port:0});cleanup.push(()=>app.close());
 const connect=async(cookie?:string,cursor?:string)=>{
  const controller=new AbortController();cleanup.push(async()=>controller.abort());
  const response=await fetch(`${origin}/api/v1/console/events${cursor?`?cursor=${encodeURIComponent(cursor)}`:""}`,{signal:controller.signal,headers:cookie?{cookie}:{}});
  if(!response.body)throw new Error("No stream");
  const reader=response.body.getReader();let buffer="";const decoder=new TextDecoder();
  const event=async()=>{
   while(!buffer.includes("\n\n")){const chunk=await reader.read();if(chunk.done)throw new Error("Stream ended");buffer+=decoder.decode(chunk.value,{stream:true});}
   const end=buffer.indexOf("\n\n"),frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
   return {event:/event: (.*)/.exec(frame)?.[1],id:/id: (.*)/.exec(frame)?.[1],data:JSON.parse(/data: (.*)/.exec(frame)?.[1]??"{}")};
  };
  return {response,event,controller};
 };
 const login=async(username:string)=>{
  const r=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username,password:"synthetic-password"}});
  return r.headers["set-cookie"]!.split(";",1)[0]!;
 };
 return {app,connect,login,origin,store:app.missionGoStore};
}
it("delivers committed changes below one second and resumes only versions after the cursor",async()=>{
 const f=await fixture();const stream=await f.connect();expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
 const hello=await stream.event();expect(hello.event).toBe("hello");
 const at=Date.now();const p=f.store.createProduct({name:"First",keyPrefix:"FIRST"});const change=await stream.event();
 expect(Date.now()-at).toBeLessThan(1000);expect(change.event).toBe("change");expect(change.data.resources).toContainEqual({kind:"products",productId:p.id});
 stream.controller.abort();f.store.createProduct({name:"Offline change",keyPrefix:"OFF"});
 const restored=await f.connect(undefined,change.id);await restored.event();const missing=await restored.event();
 expect(missing.data.resources).toHaveLength(1);expect(missing.id).not.toBe(change.id);
});
it("filters other accounts and products and propagates permission revocation",async()=>{
 const f=await fixture(true);const member=f.app.missionGoAccounts.createAccount({email:"member@example.invalid",password:"synthetic-password",role:"member"});
 const visible=f.store.createProduct({name:"Visible",keyPrefix:"VIS"}),hidden=f.store.createProduct({name:"Hidden",keyPrefix:"HID"});
 f.app.missionGoAccounts.grantCreatorPermissions(member.id,visible.id);
 const cookie=await f.login(member.email);const stream=await f.connect(cookie);await stream.event();
 f.store.database.connection.prepare("UPDATE products SET name='private' WHERE id=?").run(hidden.id);
 f.store.database.connection.prepare("UPDATE products SET name='public' WHERE id=?").run(visible.id);
 const event=await stream.event();expect(JSON.stringify(event)).not.toContain(hidden.id);expect(event.data.resources).toContainEqual({kind:"products",productId:visible.id});
 // Revocation targets the account, even though it no longer has product access.
 f.store.database.connection.prepare("DELETE FROM product_administrators WHERE account_id=?").run(member.id);
 f.store.database.connection.prepare("DELETE FROM account_products WHERE account_id=?").run(member.id);
 const revoked=await stream.event();expect(revoked.data.resources).toContainEqual({kind:"access"});
});
it("rejects unauthenticated streams and malformed cursors without accepting bearer credentials",async()=>{
 const f=await fixture(true);const response=await fetch(`${f.origin}/api/v1/console/events`);expect(response.status).toBe(401);
 const cookie=await f.login("owner@example.invalid");
 const bad=await fetch(`${f.origin}/api/v1/console/events?cursor=invalid`,{headers:{cookie}});expect(bad.status).toBe(400);
});
it("closes already-open streams when credentials are revoked",async()=>{
 const f=await fixture(true);const cookie=await f.login("owner@example.invalid");const stream=await f.connect(cookie);await stream.event();
 f.store.database.connection.prepare("UPDATE accounts SET credentials_changed_at=? WHERE id='owner'").run(new Date(Date.now()+1000).toISOString());
 expect((await stream.event()).event).toBe("unauthorized");
});
it("a hundred idle connections do not create periodic SQL and health remains responsive",async()=>{
 vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
 const f=await fixture();const streams=await Promise.all(Array.from({length:100},()=>f.connect()));await Promise.all(streams.map(s=>s.event()));
 const spy=vi.spyOn(f.store.database.connection,"prepare");
 // Drive the actual heartbeat callback at its deadline; timers perform no SELECT.
 try{vi.advanceTimersByTime(30_000);await Promise.resolve();expect(spy).not.toHaveBeenCalled();}finally{vi.useRealTimers();spy.mockRestore();}
 const at=Date.now(),health=await fetch(`${f.origin}/health`);expect(health.ok).toBe(true);expect(Date.now()-at).toBeLessThan(1000);
});
it("limits collaboration notifications to the shared item and clears reach after revocation",async()=>{
 const f=await fixture(true),accounts=f.app.missionGoAccounts;
 const member=accounts.createAccount({email:"receiver@example.invalid",password:"synthetic-password",role:"member"});
 const source=f.store.createProduct({name:"Source",keyPrefix:"SRC"}),target=f.store.createProduct({name:"Target",keyPrefix:"TGT"});
 accounts.grantCreatorPermissions(member.id,target.id);
 const create=(productId:string,title:string)=>f.store.createWorkItem({productId,title,description:"",type:"requirement",priority:"normal",environment:{platform:"web"}});
 const shared=create(source.id,"Shared"),privateItem=create(source.id,"Private"),received=create(target.id,"Received");
 const db=f.store.database.connection,now=new Date().toISOString();
 db.prepare(`INSERT INTO collaboration_grants(id,source_product_id,target_product_id,updated_by,updated_at) VALUES('grant',?,?,'owner',?)`).run(source.id,target.id,now);
 db.prepare(`INSERT INTO collaboration_requests(id,source_item_id,target_item_id,grant_id,approved_version,payload_json,approved_by,verifier_account_id,created_at) VALUES('request',?,?,'grant',1,'{}','owner','owner',?)`).run(shared.id,received.id,now);
 const stream=await f.connect(await f.login(member.email));await stream.event();
 db.prepare("UPDATE work_items SET title='hidden change' WHERE id=?").run(privateItem.id);
 db.prepare("UPDATE work_items SET title='shared change' WHERE id=?").run(shared.id);
 const event=await stream.event();expect(event.data.resources).toContainEqual({kind:"item",productId:source.id,itemKey:shared.key});expect(JSON.stringify(event)).not.toContain(privateItem.key);
 db.prepare("UPDATE collaboration_requests SET access_revoked_at=? WHERE id='request'").run(now);
 const revoked=await stream.event();expect(revoked.data.resources).toContainEqual({kind:"access",productId:target.id});expect(JSON.stringify(revoked)).not.toContain(shared.key);
});
