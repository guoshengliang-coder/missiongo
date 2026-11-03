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
describe("personal message center",()=>{
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
  it("keeps verification in-app with external disabled, and snapshots channels for new events",async()=>{
    const f=await fixture();
    f.store.transitionWorkItem({itemKey:f.item.key,to:"pending_verification",actor:"human",reason:"manual_override",note:"synthetic override"});
    expect(f.service.list(f.member,{}).notifications[0]?.kind).toBe("verification");
    expect(f.external.list(f.item.id)[0]?.status).toBe("skipped");
    f.external.saveProject(f.product.id,f.accounts.getAccount("admin"),false,false,false,true);
    f.comment("in-app only");
    const jobs=f.external.list(f.item.id);expect(jobs.find(n=>n.kind==="comment")?.reason).toBe("仅站内通知");
    expect(f.service.count(f.member)).toBe(2);
    f.external.saveProject(f.product.id,f.accounts.getAccount("admin"),true,false,true,false);
    f.comment("in-app and external");
    expect(f.external.list(f.item.id).filter(n=>n.kind==="comment").map(n=>n.status).sort()).toEqual(["queued","skipped"]);
    expect(f.service.count(f.member)).toBe(3);
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

});
