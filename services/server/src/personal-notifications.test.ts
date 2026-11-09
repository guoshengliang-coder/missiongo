import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { PersonalNotifications, enqueuePersonalNotification } from "./personal-notifications.js";
import { DingTalkNotifications } from "./dingtalk-notifications.js";

const apps:FastifyInstance[]=[];
const password="synthetic message password",passwordScrypt=hashPassword(password);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture() {
  const app=buildApp({dingtalkWorker:false,adminAccount:{id:"admin",username:"admin@example.test",passwordScrypt,sessionSecret:"synthetic-message-session-secret",cookieSecure:false}});apps.push(app);
  const store=app.missionGoStore,accounts=app.missionGoAccounts,db=store.database.connection;
  const product=store.createProduct({name:"Messages",keyPrefix:"MSG",createdByAccountId:"admin"});
  const member=accounts.createAccount({email:"reader@example.test",role:"member",password});
  accounts.replacePermissions(member.id,[{productId:product.id,canView:true,canOperate:true,canUseAi:false}]);
  const item=store.createWorkItem({productId:product.id,title:"Message target",description:"Target",type:"requirement",priority:"normal",attribution:{accountId:member.id}});
  const service=new PersonalNotifications(store,accounts);
  const external=new DingTalkNotifications(store,accounts,undefined,undefined);
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:member.email,password}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0]!;
  const call=(method:"GET"|"POST",url:string,payload?:unknown)=>app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  const comment=(text:string,accountId="admin",audience:Record<string,unknown>={mentionAccountIds:[member.id]})=>store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text},attribution:{accountId},...audience});
  return {app,store,accounts,db,product,member,item,service,external,call,comment};
}
// Seed pre-AND-494 notification records to exercise compatibility without
// relying on the now-retired verification enqueue path.
function legacyVerification(f: Awaited<ReturnType<typeof fixture>>) {
  const event=f.db.prepare("SELECT id,created_at FROM work_item_events WHERE item_id=? AND to_status='pending_verification' ORDER BY timeline_seq DESC LIMIT 1").get(f.item.id) as {id:string;created_at:string};
  const id=enqueuePersonalNotification(f.store.database,{itemId:f.item.id,productId:f.product.id,accountId:f.member.id,kind:"verification",businessEventId:event.id,createdAt:event.created_at})!;
  return f.service.detail(f.member,id);
}

describe("personal message center",()=>{
  it("keeps collaboration verification visible because it has no equivalent personal todo",async()=>{
    const f=await fixture(),at=new Date().toISOString();
    const eventId=f.store.recordCollaborationEvent(f.item.id,{note:"Collaboration requires its designated verifier"},"admin","human",at);
    const id=enqueuePersonalNotification(f.store.database,{itemId:f.item.id,productId:f.product.id,accountId:f.member.id,kind:"verification",businessEventId:eventId,createdAt:at})!;
    const page=f.service.list(f.member,{kind:"verification"});
    expect(page.notifications.map(n=>n.id)).toEqual([id]);
    expect(f.service.attentionCount(f.member)).toEqual({count:1,todoCount:0,unreadCount:1,coveredUnreadCount:0});
    f.service.markAllRead(f.member,page.throughSequence,{kind:"verification"});
    expect(f.service.detail(f.member,id).readAt).not.toBeNull();
    expect(f.service.count(f.member)).toBe(0);
  });
  it("persists independent of DingTalk, deduplicates mention/reply and does not notify ordinary comments",async()=>{
    const f=await fixture();
    const parent=f.comment("My question",f.member.id,{});
    f.comment("Ordinary progress","admin",{});
    const reply=f.comment("Targeted answer","admin",{replyToCommentId:parent.id,mentionAccountIds:[f.member.id]});
    const page=f.service.list(f.member,{});
    expect(page.notifications).toHaveLength(1);expect(page.unreadCount).toBe(1);
    expect(page.notifications[0]).toMatchObject({kind:"mention",summary:"Targeted answer",commentId:reply.id,readAt:null});
    const before=f.db.prepare("SELECT count(*) AS n FROM personal_notifications").get();
    enqueuePersonalNotification(f.store.database,{itemId:f.item.id,productId:f.product.id,accountId:f.member.id,kind:"reply",commentId:reply.id,createdAt:reply.createdAt});
    expect(f.db.prepare("SELECT count(*) AS n FROM personal_notifications").get()).toEqual(before);
    await f.external.drain();
    expect(f.service.count(f.member)).toBe(1);
    expect(f.external.list(f.item.id)[0]?.status).toBe("skipped");
    f.external.retry(f.item.key,f.external.list(f.item.id)[0]!.id,"admin");
    expect(f.service.count(f.member)).toBe(1);
    f.comment("Automatic self reply",f.member.id,{replyToCommentId:parent.id});
    expect(f.service.count(f.member)).toBe(1);
    f.comment("Explicit self mention",f.member.id,{mentionAccountIds:[f.member.id]});
    expect(f.service.count(f.member)).toBe(2);
  });
  it("rolls back both business comment and notification when its transaction fails",async()=>{
    const f=await fixture();
    f.db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON personal_notifications BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect(()=>f.comment("must roll back")).toThrow(/synthetic failure/);
    expect(f.store.listComments(f.item.key)).toHaveLength(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM notification_events").get()).toEqual({n:0});
    expect(f.external.list(f.item.id)).toHaveLength(0);
  });
  it("authenticates routes, scopes each read/count/write and redacts withdrawn comments",async()=>{
    const f=await fixture(),comment=f.comment("Private content");
    const page=(await f.call("GET","/api/v1/notifications")).json();
    const id=page.notifications[0].id;
    expect((await f.app.inject({url:"/api/v1/notifications"})).statusCode).toBe(401);
    expect((await f.call("GET",`/api/v1/notifications/${id}`)).json().text).toBe("Private content");
    expect(f.service.count(f.member)).toBe(1); // GET never marks read.
    f.db.prepare("UPDATE work_item_comments SET withdrawn_at=? WHERE id=?").run(new Date().toISOString(),comment.id);
    expect(f.service.detail(f.member,id)).toMatchObject({text:"",summary:"",unavailable:true});
    f.accounts.replacePermissions(f.member.id,[]);
    expect((await f.call("GET","/api/v1/notifications/unread-count")).json()).toEqual({count:0});
    expect((await f.call("GET","/api/v1/notifications")).json().notifications).toEqual([]);
    expect((await f.call("GET",`/api/v1/notifications/${id}`)).statusCode).toBe(404);
    expect((await f.call("POST",`/api/v1/notifications/${id}/read`)).statusCode).toBe(404);
    expect(f.db.prepare("SELECT read_at FROM personal_notifications WHERE id=?").get(id)).toEqual({read_at:null});
  });
  it("marks a bounded filtered snapshot, preserves new arrivals and shares per-account read state",async()=>{
    const f=await fixture();f.comment("first");
    const page=(await f.call("GET","/api/v1/notifications?unread=true&kind=mention")).json();
    f.comment("arrived after snapshot");
    expect((await f.call("POST","/api/v1/notifications/read-all",{throughSequence:page.throughSequence,filter:{kind:"mention",unread:"true"}})).statusCode).toBe(200);
    const next=f.service.list(f.member,{unread:true});expect(next.notifications).toHaveLength(1);
    expect(next.notifications[0]?.summary).toBe("arrived after snapshot");
    await f.call("POST",`/api/v1/notifications/${next.notifications[0]!.id}/read`);
    expect((await f.call("GET","/api/v1/notifications/unread-count")).json()).toEqual({count:0});
    expect(f.store.getWorkItem(f.item.key).status).toBe(f.item.status);
    expect((await f.call("POST","/api/v1/notifications/read-all",{throughSequence:-1})).statusCode).toBe(400);
  });
  it("keeps verification only as a todo, while external channel settings remain independent",async()=>{
    const f=await fixture();
    f.store.transitionWorkItem({itemKey:f.item.key,to:"pending_verification",actor:"human",reason:"manual_override",note:"synthetic override"});
    expect(f.service.list(f.member,{}).notifications).toEqual([]);
    expect(f.service.todos(f.member).todos).toHaveLength(1);
    expect(f.db.prepare("SELECT count(*) AS n FROM personal_notifications").get()).toEqual({n:0});
    expect(f.external.list(f.item.id)[0]?.status).toBe("skipped");
    f.external.saveProject(f.product.id,f.accounts.getAccount("admin"),false,false,false,true);
    f.comment("in-app only");
    const jobs=f.external.list(f.item.id);expect(jobs.find(n=>n.kind==="comment")?.reason).toBe("仅站内通知");
    expect(f.service.count(f.member)).toBe(1);
    f.external.saveProject(f.product.id,f.accounts.getAccount("admin"),true,false,true,false);
    f.comment("in-app and external");
    expect(f.external.list(f.item.id).filter(n=>n.kind==="comment").map(n=>n.status).sort()).toEqual(["queued","skipped"]);
    expect(f.service.count(f.member)).toBe(2);
  });
  it("paginates without duplicates and never lets another account read or acknowledge a message",async()=>{
    const f=await fixture();
    for(let i=0;i<53;i++)f.comment(`message ${i}`);
    const first=f.service.list(f.member,{}),second=f.service.list(f.member,{beforeSequence:first.nextBeforeSequence});
    expect(first.notifications).toHaveLength(50);expect(second.notifications).toHaveLength(3);
    expect(new Set([...first.notifications,...second.notifications].map(n=>n.id)).size).toBe(53);
    expect(second.nextBeforeSequence).toBeUndefined();
    const admin=f.accounts.getAccount("admin"),id=first.notifications[0]!.id;
    expect(f.service.count(admin)).toBe(0);
    expect(()=>f.service.detail(admin,id)).toThrow();expect(()=>f.service.markRead(admin,id)).toThrow();
    f.service.markAllRead(f.member,first.throughSequence,{kind:"reply"});
    expect(f.service.count(f.member)).toBe(53);
  });

  it("counts verification once before and after reading, but keeps independent comments",async()=>{
    const f=await fixture();
    f.store.transitionWorkItem({itemKey:f.item.key,to:"pending_verification",actor:"human",reason:"manual_override",note:"synthetic delivery"});
    const notice=legacyVerification(f);
    expect(f.service.attentionCount(f.member)).toEqual({count:1,todoCount:1,unreadCount:0,coveredUnreadCount:0});
    expect((await f.call("GET","/api/v1/attention/todos")).json().todos).toMatchObject([{kind:"verification",itemKey:f.item.key}]);
    expect(f.service.list(f.member,{kind:"verification"}).notifications).toEqual([]);
    f.service.markAllRead(f.member,f.service.list(f.member,{}).throughSequence,{});
    expect(f.service.detail(f.member,notice.id).readAt).toBeNull();
    f.service.markRead(f.member,notice.id);
    expect(f.service.attentionCount(f.member)).toEqual({count:1,todoCount:1,unreadCount:0,coveredUnreadCount:0});
    f.comment("Independent comment requiring attention");
    expect(f.service.attentionCount(f.member).count).toBe(2);
    f.service.markAllRead(f.member,f.service.list(f.member,{}).throughSequence,{});
    expect(f.service.attentionCount(f.member).count).toBe(1);
    expect(f.store.getWorkItem(f.item.key).status).toBe("pending_verification");
    // Acceptance is a human business action, never a read API side effect.
    f.store.transitionWorkItem({itemKey:f.item.key,to:"done",actor:"human",reason:"verification_passed",attribution:{accountId:f.member.id}});
    expect(f.service.attentionCount(f.member).count).toBe(0);
    expect(f.service.todos(f.member).todos).toEqual([]);
  });
  it("resolves only the ended verification round, preserving unread comments and history across reopening",async()=>{
    const f=await fixture();
    const move=(to:"pending_verification"|"done"|"ready",reason:"manual_override"|"verification_passed"|"reopened"|"verification_failed")=>
      f.store.transitionWorkItem({itemKey:f.item.key,to,actor:"human",reason,note:"synthetic action",attribution:{accountId:"admin"}});
    move("pending_verification","manual_override");
    const first=legacyVerification(f);
    const firstTodo=f.service.todos(f.member).todos[0]!;
    f.comment("Do not silently mark this read");
    move("done","verification_passed");
    expect(f.service.detail(f.member,first.id)).toMatchObject({readAt:null,resolvedAt:expect.any(String)});
    expect(f.service.list(f.member,{unread:true}).notifications.map(n=>n.kind)).toEqual(["mention"]);
    expect(f.service.attentionCount(f.member)).toEqual({count:1,todoCount:0,unreadCount:1,coveredUnreadCount:0});
    move("ready","reopened");move("pending_verification","manual_override");
    const nextTodo=f.service.todos(f.member).todos[0]!;
    expect(nextTodo.id).not.toBe(firstTodo.id);
    expect(nextTodo.businessEventId).not.toBe(firstTodo.businessEventId);
    expect(f.service.todos(f.member).todos).toEqual([nextTodo]);
    expect(f.service.attentionCount(f.member)).toEqual({count:3,todoCount:1,unreadCount:2,coveredUnreadCount:0});
    expect(f.service.detail(f.member,first.id).resolvedAt).not.toBeNull();
    const decision=f.service.list(f.member,{}).notifications.find(n=>n.kind==="decision")!;
    expect(decision.businessEventId).toEqual(expect.any(String));
    expect(f.db.prepare("SELECT to_status FROM work_item_events WHERE id=?").get(decision.businessEventId!)).toMatchObject({to_status:"ready"});
    move("ready","verification_failed");
    expect(f.service.todos(f.member).todos).toEqual([]);
    expect(f.service.list(f.member,{unread:true}).notifications.map(n=>n.kind).sort()).toEqual(["decision","decision","mention"]);
    expect(f.service.list(f.member,{}).notifications.filter(n=>n.kind==="verification")).toHaveLength(0);
  });
  it("derives old pending work without notification backfill; scopes tasks to the accessible proposer",async()=>{
    const f=await fixture();
    // Represents already-pending work created before notifications were installed.
    f.db.prepare("UPDATE work_items SET status='pending_verification' WHERE id=?").run(f.item.id);
    expect(f.service.attentionCount(f.member)).toEqual({count:1,todoCount:1,unreadCount:0,coveredUnreadCount:0});
    expect(f.service.todos(f.accounts.getAccount("admin")).todos).toEqual([]);
    expect(f.service.todos(f.member,{productId:"outside-scope"}).todos).toEqual([]);
    expect((await f.app.inject({url:"/api/v1/attention/count"})).statusCode).toBe(401);
    expect((await f.app.inject({url:"/api/v1/attention/todos"})).statusCode).toBe(401);
    expect((await f.call("GET","/api/v1/attention/todos?beforeSequence=-1")).statusCode).toBe(400);
    f.db.prepare("UPDATE products SET archived_at=? WHERE id=?").run(new Date().toISOString(),f.product.id);
    expect(f.service.attentionCount(f.member).todoCount).toBe(0);
    f.db.prepare("UPDATE products SET archived_at=NULL WHERE id=?").run(f.product.id);
    f.accounts.replacePermissions(f.member.id,[]);
    expect((await f.call("GET","/api/v1/attention/count")).json()).toEqual({count:0,todoCount:0,unreadCount:0,coveredUnreadCount:0});
    expect((await f.call("GET","/api/v1/attention/todos")).json().todos).toEqual([]);
    expect(f.service.list(f.member,{}).notifications).toEqual([]);
  });
  it("paginates pending tasks without capping the badge and excludes SDK ownership",async()=>{
    const f=await fixture();
    for(let i=0;i<52;i++)f.store.createWorkItem({productId:f.product.id,title:`Task ${i}`,description:"",type:"task",priority:"normal",attribution:{accountId:f.member.id}});
    f.db.prepare("UPDATE work_items SET status='pending_verification' WHERE product_id=?").run(f.product.id);
    const first=f.service.todos(f.member),second=f.service.todos(f.member,{beforeSequence:first.nextBeforeSequence});
    expect(first.todos).toHaveLength(50);expect(second.todos).toHaveLength(3);
    expect(new Set([...first.todos,...second.todos].map(t=>t.id)).size).toBe(53);
    expect(f.service.attentionCount(f.member).count).toBe(53);
    f.db.prepare("UPDATE work_item_events SET payload_json=json_set(payload_json,'$.source','android_sdk') WHERE item_id=? AND event_type='item_created'").run(f.item.id);
    expect(f.service.attentionCount(f.member).count).toBe(52);
  });

  it("moves a todo with its business item without reviving copied notices or leaving a source task",async()=>{
    const f=await fixture(),target=f.store.createProduct({name:"Target",keyPrefix:"DST",createdByAccountId:"admin"});
    f.accounts.replacePermissions(f.member.id,[f.product,target].map(p=>({productId:p.id,canView:true,canOperate:true,canUseAi:false})));
    f.store.transitionWorkItem({itemKey:f.item.key,to:"pending_verification",actor:"human",reason:"manual_override",note:"synthetic delivery"});
    const notice=legacyVerification(f);
    const response=await f.call("POST",`/api/v1/items/${f.item.key}/transfer`,{targetProductId:target.id,idempotencyKey:"attention-transfer"});
    expect(response.statusCode).toBe(200);
    const member=f.accounts.getAccount(f.member.id),moved=response.json();
    expect(f.service.todos(member).todos.map(t=>t.itemKey)).toEqual([moved.key]);
    expect(f.service.detail(member,notice.id)).toMatchObject({readAt:null,resolvedAt:expect.any(String)});
    expect(f.service.attentionCount(member)).toEqual({count:1,todoCount:1,unreadCount:0,coveredUnreadCount:0});
    // Proposer verification is allowed even without general editing permission.
    f.accounts.replacePermissions(member.id,[{productId:target.id,canView:true,canOperate:false,canUseAi:false}]);
    expect((await f.call("GET","/api/v1/attention/todos")).json().todos.map((t:{itemKey:string})=>t.itemKey)).toEqual([moved.key]);
    expect((await f.call("POST",`/api/v1/items/${moved.key}/transitions`,{to:"done",reason:"verification_passed",expectedStatus:moved.status,expectedRevision:moved.revision,idempotencyKey:"attention-verify"})).statusCode).toBe(200);
    expect((await f.call("GET","/api/v1/attention/count")).json().count).toBe(0);
  });

});
