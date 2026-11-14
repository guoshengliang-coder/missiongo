import {readFileSync} from "node:fs";
import {expect,test,type Page} from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const documentId="11111111-1111-4111-8111-111111111111",stamp="2026-11-13T12:00:00.000Z",label="恢复之前的批准记录";
type Surface="console"|"panel";
async function setup(page:Page,surface:Surface,code="ready_to_restore",options:{canRecover?:boolean;archived?:boolean}={}) {
 await page.clock.setFixedTime(new Date("2026-11-13T13:00:00Z"));
 const id="document-recovery",state={approved:false,posts:0,commands:0,overviewReads:0,keys:[] as string[],finish:()=>{}};
 const summary={id,agentSessionId:id,dispatchId:"recovery-dispatch",agentKind:"codex",status:"running",updatedAt:stamp,createdAt:stamp,activityAt:stamp,
  nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
  canReply:true,canRetry:false,canStop:true,canArchive:true,items:[{key:fixture.detailKey,title:"Original approval",productId:fixture.productId}],attention:{state:"not_needed"},needsAttention:false,
  ...(options.archived?{archivedAt:stamp}: {})};
 const source="固定方案\n\n[完整方案](/?planDocument="+documentId+")";
 await page.route("**/api/v1/agent-sessions**",async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(path.endsWith("/plan-approval/recover")){
   state.posts++;const body=request.postDataJSON();expect(body).toMatchObject({documentId,revision:"document-v2",requestKey:expect.any(String)});state.keys.push(body.requestKey);
   if(state.posts===1)return route.fulfill({status:503,json:{message:"Unavailable"}});
   if(state.posts===2)return route.fulfill({json:{code:"history_incomplete",documentId,revision:"document-v2"}});
   await new Promise<void>(resolve=>{state.finish=resolve;});
   state.approved=true;return route.fulfill({json:{code:"restored",documentId,revision:"document-v2"}});
  }
  if(path.endsWith("/commands")){state.commands++;return route.fulfill({status:500});}
  if(path.endsWith("/plan-records")) {
   if(url.searchParams.get("view")==="overview")state.overviewReads++;
   const record={id:1,revision:"document-v2",documentId,version:2,keys:[fixture.detailKey],kind:"proposal",current:true,effective:state.approved,scopeValid:true,legacy:false,summary:"当前文档",submittedAt:stamp,
    ...(state.approved?{approval:{source:"native",approvedAt:stamp}}:{}),...(url.searchParams.has("recordId")?{markdown:source}:{})};
   const old={...record,id:2,documentId:"22222222-2222-4222-8222-222222222222",revision:"old",version:1,current:false,effective:false,summary:"旧文档",markdown:"旧版本正文",approval:undefined};
   return route.fulfill({json:{records:url.searchParams.get("recordId")==="2"?[old]:url.searchParams.has("recordId")?[record]:[record,old],historyIncomplete:false}});
  }
  if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:[summary]}});
  if(request.method()!=="GET")return route.fulfill({status:204});
  return route.fulfill({json:{...summary,hasPlanRecords:true,messages:[{id:"display",sourceId:"display",role:"agent",phase:"final_answer",text:source,occurredAt:stamp},
   {id:"acceptance",sourceId:"acceptance",role:"user",text:"批准",occurredAt:"2026-11-13T12:01:00Z"}],
   implementationPlan:{documentId,revision:"document-v2",plan:source,validation:"",itemKeys:[fixture.detailKey],approved:state.approved,valid:true},
   documentPlanApproval:{documentId,revision:"document-v2",code:state.approved?"already_approved":code},canRecoverPlanApproval:options.canRecover??true,
   canApprovePlan:false,planApprovalStatus:{code:state.approved?"approved":"not_approval"},...(state.approved?{planApprovalState:{approved:true,revision:"document-v2",continuationQueued:false}}:{})}});
 });
 await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"auto",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
 if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
 else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
 await expect(page.getByRole("button",{name:"方案与审批",exact:true})).toBeVisible();
 return state;
}
for(const surface of ["console","panel"] as const) for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
 test(`${surface} approval recovery in records ${width} ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const state=await setup(page,surface);
  const reply=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await reply.fill("保留聊天草稿");
  await expect(page.getByRole("region",{name:label,exact:true})).toHaveCount(0);
  const opener=page.getByRole("button",{name:"方案与审批",exact:true});await opener.click();
  const modal=page.getByRole("dialog",{name:"方案与审批",exact:true}),recovery=modal.getByRole("region",{name:label,exact:true}),restore=recovery.getByRole("button",{name:label,exact:true});
  await expect(restore).toBeVisible();await page.screenshot({path:info.outputPath(`ready-${surface}-${width}-${theme}.png`)});await restore.click();await expect(recovery.getByRole("alert")).toContainText("恢复请求失败");
  await restore.click();await expect(recovery.getByRole("status")).toContainText("未能恢复批准记录");await expect(recovery).toContainText("批准证据不完整");
  await expect(recovery.getByRole("button")).toHaveCount(0);
  await modal.getByRole("button",{name:"关闭",exact:true}).click();await expect(reply).toHaveValue("保留聊天草稿");await expect(opener).toBeFocused();
  await opener.click();await restore.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await expect(recovery.getByRole("status")).toContainText("正在恢复");await expect(modal.getByRole("button",{name:"关闭",exact:true})).toBeDisabled();
  expect(state.posts).toBe(3);state.finish();
  await expect(recovery.getByRole("status")).toContainText("原批准已登记");await expect(restore).toHaveCount(0);
  await expect.poll(()=>state.overviewReads).toBeGreaterThan(2);
  await expect(modal.getByRole("region",{name:"当前有效方案",exact:true})).toContainText("当前文档");
  for(const scale of ["small","medium","large"]) {
   await page.evaluate(scale=>{document.documentElement.dataset.fontScale=scale;document.documentElement.dataset.consoleFontScale=scale;},scale);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({path:info.outputPath(`restored-${surface}-${width}-${theme}.png`)});
  await modal.getByRole("button",{name:"关闭",exact:true}).click();await expect(reply).toHaveValue("保留聊天草稿");
  await expect(page.getByRole("region",{name:label,exact:true})).toHaveCount(0);
  expect(new Set(state.keys.slice(0,2)).size).toBe(1);expect(state.commands).toBe(0);
  await expect(page.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
 });
}
for(const surface of ["console","panel"] as const) for(const [code,text] of [
 ["history_incomplete","批准证据不完整"],["evidence_missing","尚未找到当前文档版本"],["source_conflict","来源记录有冲突"],
 ["scope_changed","文档或范围已变化"],["identity_unavailable","原会话身份或执行权限不可用"],
] as const) {
 test(`${surface} ${code} is diagnostic only`,async({page})=>{
  const state=await setup(page,surface,code);
  await expect(page.getByRole("region",{name:label,exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"方案与审批",exact:true}).click();const modal=page.getByRole("dialog",{name:"方案与审批",exact:true});
  await expect(modal.getByRole("region",{name:label,exact:true})).toHaveCount(0);
  await modal.getByRole("region",{name:`v2 · ${fixture.detailKey}`,exact:true}).getByRole("button",{name:"查看版本原文",exact:true}).click();
  await expect(modal.getByRole("region",{name:label,exact:true})).toContainText(text);await expect(modal.getByRole("button",{name:label,exact:true})).toHaveCount(0);
  await page.keyboard.press("Escape");await expect(modal).toBeVisible();
  await modal.getByRole("region",{name:`v1 · ${fixture.detailKey}`,exact:true}).getByRole("button",{name:"查看版本原文",exact:true}).click();await expect(modal.getByRole("region",{name:label,exact:true})).toHaveCount(0);
  expect(state.posts).toBe(0);expect(state.commands).toBe(0);
 });
}
for(const options of [{canRecover:false},{archived:true}]) test(`recovery respects ${JSON.stringify(options)}`,async({page})=>{
 const state=await setup(page,"console","ready_to_restore",options);
 await page.getByRole("button",{name:"方案与审批",exact:true}).click();await expect(page.getByRole("button",{name:label,exact:true})).toHaveCount(0);expect(state.posts).toBe(0);
});

for(const surface of ["console","panel"] as const) test(`${surface} later approval clears a previous recovery failure`,async({page})=>{
 const state=await setup(page,surface);
 await page.getByRole("button",{name:"方案与审批",exact:true}).click();const modal=page.getByRole("dialog",{name:"方案与审批",exact:true});
 const restore=modal.getByRole("button",{name:label,exact:true});await restore.click();await expect(modal.getByRole("alert")).toContainText("恢复请求失败");
 await restore.click();await expect(modal).toContainText("未能恢复批准记录");
 state.approved=true;await advanceSessionDetailPoll(page);
 await expect(modal.getByRole("region",{name:label,exact:true})).toHaveCount(0);
 await expect(modal.getByRole("region",{name:"当前有效方案",exact:true})).toContainText("当前文档");
 expect(state.posts).toBe(2);expect(state.commands).toBe(0);
});
