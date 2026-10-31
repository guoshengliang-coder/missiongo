import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { hashPassword } from "./admin-auth.js";
import { commentCandidates } from "./comment-discussions.js";
import { DingTalkNotifications } from "./dingtalk-notifications.js";
import { MissionGoStore } from "./store.js";
import { AccountStore } from "./accounts-store.js";

const apps:FastifyInstance[]=[],stores:MissionGoStore[]=[];
const password="synthetic-discussion-password",secret="synthetic-discussion-encryption-secret",passwordScrypt=hashPassword(password);
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const store of stores.splice(0))store.close();});
function fixture() {
  const store=new MissionGoStore(":memory:");stores.push(store);
  const accounts=new AccountStore(store.database);
  const writer=accounts.createAccount({email:"writer@example.test",role:"admin",password});
  const member=accounts.createAccount({email:"proposer@example.test",role:"member",password});
  const builder=accounts.createAccount({email:"builder@example.test",role:"member",password});
  const outsider=accounts.createAccount({email:"outsider@example.test",role:"member",password});
  const product=store.createProduct({name:"Discussion",keyPrefix:"DC",createdByAccountId:writer.id});
  for(const account of [member,builder])accounts.replacePermissions(account.id,[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]);
  const item=store.createWorkItem({productId:product.id,type:"requirement",priority:"normal",title:"Comment discussion",description:"Details",attribution:{accountId:member.id},builderAccountId:builder.id});
  const post=(text:string,accountId=writer.id,extra:Record<string,unknown>={})=>store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text},attribution:{accountId},...extra});
  const requests:Array<Record<string,unknown>>=[];
  let onToken:()=>void=()=>{};
  const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
    if(String(url).includes("/gettoken")){onToken();return Response.json({errcode:0,access_token:"synthetic-access",expires_in:7200});}
    const body=JSON.parse(String(init?.body ?? "{}"));requests.push(body);
    return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{spaceType:"IM_ROBOT",spaceId:"employee-proposer",success:true,carrierId:"synthetic-card"}]}});
  }) as unknown as typeof fetch;
  const service=new DingTalkNotifications(store,accounts,secret,"https://example.test",fetcher,undefined,"blue","synthetic-comment-template.schema");
  const configure=()=>{
    service.saveSettings({corpId:"synthetic-corp",clientId:"synthetic-app",agentId:"",clientSecret:"synthetic-secret",expectedRevision:0,deliveryMode:"robot",robotCode:"synthetic-robot"},writer.id);
    service.saveBinding(member.id,{userId:"employee-proposer",name:"",department:""},null,writer.id);
  };
  const jobs=()=>store.database.connection.prepare("SELECT id,account_id,comment_id,status,reason FROM dingtalk_notifications WHERE kind='comment'").all() as Array<{id:string;account_id:string;comment_id:string;status:string;reason:string}>;
  const callback=(id:string,text="A reply from DingTalk")=>({outTrackId:id,corpId:"synthetic-corp",userId:"employee-proposer",userIdType:1,
    content:JSON.stringify({cardPrivateData:{actionIds:["send_reply"],params:{action:"reply",replyText:text}}})});
  return {store,accounts,writer,member,builder,outsider,product,item,post,service,configure,jobs,callback,requests,setOnToken:(fn:()=>void)=>{onToken=fn;}};
}

describe("comment discussions and recipients",()=>{
  it("limits candidates, resolves all to Builder and proposer, deduplicates and excludes the author",()=>{
    const f=fixture();expect(commentCandidates(f.store,f.item.key).map(p=>p.accountId)).not.toContain(f.outsider.id);
    const comment=f.post("@everyone",f.writer.id,{mentionTargets:["all"],mentionAccountIds:[f.member.id,f.member.id,f.writer.id],idempotencyKey:"same-comment"});
    expect(new Set(comment.mentions?.map(p=>p.accountId))).toEqual(new Set([f.member.id,f.builder.id,f.writer.id]));
    expect(new Set(f.jobs().map(job=>job.account_id))).toEqual(new Set([f.member.id,f.builder.id]));
    expect(f.post("retry",f.writer.id,{mentionTargets:["all"],idempotencyKey:"same-comment"}).id).toBe(comment.id);expect(f.jobs()).toHaveLength(2);
  });
  it("keeps precise parents in one root and notifies only parent authors plus explicit mentions",()=>{
    const f=fixture(),root=f.post("Question",f.member.id);
    const reply=f.post("Answer",f.writer.id,{replyToCommentId:root.id,mentionAccountIds:[f.member.id,f.builder.id]});
    const followup=f.post("Follow up",f.builder.id,{replyToCommentId:reply.id});
    expect(reply).toMatchObject({replyToCommentId:root.id,threadRootCommentId:root.id});
    expect(followup).toMatchObject({replyToCommentId:reply.id,threadRootCommentId:root.id});
    expect(f.jobs().filter(job=>job.comment_id===reply.id).map(job=>job.account_id).sort()).toEqual([f.member.id,f.builder.id].sort());
    expect(f.jobs().filter(job=>job.comment_id===followup.id).map(job=>job.account_id)).toEqual([f.writer.id]);
    expect(f.store.getTimeline(f.item.key).find(e=>e.id===followup.id)?.payload).toMatchObject({replyToCommentId:reply.id,threadRootCommentId:root.id});
  });
  it("rejects foreign and withdrawn parents and invalid recipients without partial writes",()=>{
    const f=fixture(),other=f.store.createWorkItem({productId:f.product.id,type:"note",priority:"normal",title:"Other",description:""});
    const foreign=f.store.createComment({itemKey:other.key,actorKind:"human",bodyKind:"free",body:{text:"Foreign"}});
    expect(()=>f.post("Cross item",f.writer.id,{replyToCommentId:foreign.id})).toThrow(/Reply comment/);
    expect(()=>f.post("Bad mention",f.writer.id,{mentionAccountIds:[f.outsider.id]})).toThrow(/查看权限/);
    const root=f.post("Withdrawn");f.store.withdrawComment({itemKey:f.item.key,commentId:root.id});
    expect(()=>f.post("Reply",f.writer.id,{replyToCommentId:root.id})).toThrow(/撤回/);
    expect(f.store.listComments(f.item.key,{includeWithdrawn:true})).toHaveLength(1);expect(f.jobs()).toHaveLength(0);
  });
  it("preserves existing replies when their root is withdrawn",()=>{
    const f=fixture(),root=f.post("Question",f.member.id),reply=f.post("Answer",f.writer.id,{replyToCommentId:root.id});
    f.store.withdrawComment({itemKey:f.item.key,commentId:root.id});
    expect(f.store.listComments(f.item.key,{includeWithdrawn:true})).toEqual(expect.arrayContaining([expect.objectContaining({id:root.id,withdrawnAt:expect.any(String)}),expect.objectContaining({id:reply.id,threadRootCommentId:root.id})]));
  });
  it("rolls back comment creation if notification enqueue fails",()=>{
    const f=fixture();f.store.database.connection.exec("CREATE TEMP TRIGGER fail_notice BEFORE INSERT ON dingtalk_notifications BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END;");
    expect(()=>f.post("Must be atomic",f.writer.id,{mentionTargets:["proposer"]})).toThrow(/synthetic queue failure/);
    expect(f.store.listComments(f.item.key)).toHaveLength(0);expect(f.jobs()).toHaveLength(0);
  });
  it("does not guess a proposer for unattributed items or notify for plain comments",()=>{
    const f=fixture();f.post("Plain");expect(f.jobs()).toHaveLength(0);
    const item=f.store.createWorkItem({productId:f.product.id,type:"bug",priority:"normal",title:"Unattributed",description:""});
    expect(commentCandidates(f.store,item.key).filter(c=>c.isProposer)).toHaveLength(0);
  });
});

describe("DingTalk comment card replies",()=>{
  it("delivers without the verification switch and saves authenticated replies exactly once",async()=>{
    const f=fixture();f.configure();const root=f.post("Please explain",f.writer.id,{mentionTargets:["proposer"]});
    await f.service.drain();expect(f.jobs()[0]?.status).toBe("sent");
    const request=f.requests[0]!;expect(request).toMatchObject({callbackType:"STREAM",userIdType:1,imRobotOpenSpaceModel:{supportForward:false}});
    expect(JSON.stringify(request)).toContain("Please explain");expect(JSON.stringify(request)).toContain(`comment=${root.id}`);
    const job=f.jobs()[0]!,body=f.callback(job.id);
    expect(f.service.receiveCommentCard(body)).toMatchObject({cardData:{cardParamMap:{replySaved:"true"}}});
    f.service.receiveCommentCard(body);f.service.receiveCommentCard(f.callback(job.id,"Changed replay"));
    const comments=f.store.listComments(f.item.key);expect(comments).toHaveLength(2);
    expect(comments[1]).toMatchObject({actorKind:"human",accountId:f.member.id,replyToCommentId:root.id,threadRootCommentId:root.id,body:{text:"A reply from DingTalk"}});
    expect(f.jobs().filter(job=>job.comment_id===comments[1]!.id)).toHaveLength(1);
  });
  it("rejects wrong organizations, other users and missing operate permission",async()=>{
    const f=fixture();f.configure();f.post("Question",f.writer.id,{mentionTargets:["proposer"]});await f.service.drain();const body=f.callback(f.jobs()[0]!.id);
    expect(()=>f.service.receiveCommentCard({...body,corpId:"foreign-corp"})).toThrow(/失效/);
    expect(()=>f.service.receiveCommentCard({...body,userId:"someone-else"})).toThrow(/绑定/);
    f.accounts.replacePermissions(f.member.id,[{productId:f.product.id,canView:true,canOperate:false,canUseAi:false}]);
    expect(()=>f.service.receiveCommentCard(body)).toThrow(/评论权限/);expect(f.store.listComments(f.item.key)).toHaveLength(1);
  });
  it("rejects stale bindings, withdrawn comments and malformed or empty submissions",async()=>{
    const f=fixture();f.configure();const root=f.post("Question",f.writer.id,{mentionTargets:["proposer"]});await f.service.drain();const body=f.callback(f.jobs()[0]!.id);
    expect(()=>f.service.receiveCommentCard(f.callback(f.jobs()[0]!.id,"   "))).toThrow(/请输入/);
    expect(()=>f.service.receiveCommentCard({...body,content:"{bad"})).toThrow(/无效/);
    f.store.withdrawComment({itemKey:f.item.key,commentId:root.id});expect(()=>f.service.receiveCommentCard(body)).toThrow(/撤回/);
    const binding=f.service.bindings()[0]!;f.service.saveBinding(f.member.id,{userId:"changed-user",name:"",department:""},binding.revision,f.writer.id);
    expect(()=>f.service.receiveCommentCard(body)).toThrow(/绑定/);
  });
  it("rechecks recipients after network waits and never sends revoked project content",async()=>{
    const f=fixture();f.configure();f.post("Sensitive",f.writer.id,{mentionTargets:["proposer"]});
    f.setOnToken(()=>f.accounts.replacePermissions(f.member.id,[]));await f.service.drain();
    expect(f.requests).toHaveLength(0);expect(f.jobs()[0]).toMatchObject({status:"skipped",reason:expect.stringContaining("查看权限")});
  });
  it("saves comments when bindings or configuration are missing and records reasons",async()=>{
    const f=fixture();f.post("Notify",f.writer.id,{mentionTargets:["all"]});await f.service.drain();
    expect(f.store.listComments(f.item.key)).toHaveLength(1);expect(f.jobs()).toHaveLength(2);
    expect(f.jobs().every(job=>job.status==="skipped" && job.reason.includes("未配置"))).toBe(true);
  });
});

it("protects item-scoped candidate queries and validates HTTP comment parameters",async()=>{
  const app=buildApp({dingtalkWorker:false,adminAccount:{id:"admin",username:"admin@example.test",passwordScrypt,sessionSecret:secret,cookieSecure:false}});apps.push(app);
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"admin@example.test",password}}),cookie=String(login.headers["set-cookie"]).split(";")[0]!;
  const store=app.missionGoStore,product=store.createProduct({name:"HTTP",keyPrefix:"HC"});
  const item=store.createWorkItem({productId:product.id,type:"note",priority:"normal",title:"HTTP comment",description:""});
  expect((await app.inject({url:`/api/v1/items/${item.key}/comment-candidates`})).statusCode).toBe(401);
  const request=(url:string,payload?:unknown)=>app.inject({method:payload?"POST":"GET",url,headers:{cookie},...(payload?{payload}:{})});
  expect((await request(`/api/v1/items/${item.key}/comment-candidates`)).json().candidates).toEqual([expect.objectContaining({accountId:"admin"})]);
  const root=await request(`/api/v1/items/${item.key}/comments`,{text:"Question"});expect(root.statusCode).toBe(201);
  const reply=await request(`/api/v1/items/${item.key}/comments`,{text:"Answer",replyToCommentId:root.json().id,mentionTargets:["all"]});expect(reply.statusCode).toBe(201);expect(reply.json().replyToCommentId).toBe(root.json().id);
  expect((await request(`/api/v1/items/${item.key}/comments`,{text:"Bad",mentionTargets:["global"]})).statusCode).toBe(400);
});
