import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const documentId="11111111-1111-4111-8111-111111111111",stamp="2026-11-13T12:00:00.000Z";
for(const surface of ["console","panel"] as const) for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
 test(`${surface} original approval recovery ${width} ${theme}`,async({page})=>{
  await page.clock.setFixedTime(new Date("2026-11-13T13:00:00Z"));
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const id="document-recovery";let approved=false,posts=0,commands=0;
  const summary={id,agentSessionId:id,dispatchId:"recovery-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,activityAt:stamp,
   nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
   canReply:true,canRetry:false,canStop:false,canArchive:true,items:[{key:fixture.detailKey,title:"Original approval",productId:fixture.productId}],attention:{state:"not_needed"},needsAttention:false};
  const source="固定方案\n\n[完整方案](/?planDocument="+documentId+")";
  await page.route("**/api/v1/agent-sessions**",route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path.endsWith("/plan-approval/recover")){
    posts++;expect(request.postDataJSON()).toMatchObject({documentId,revision:"document-v2",requestKey:expect.any(String)});
    if(posts===1)return route.fulfill({status:200,json:{code:"history_incomplete",documentId,revision:"document-v2"}});
    approved=true;return route.fulfill({json:{code:"restored",documentId,revision:"document-v2"}});
   }
   if(path.endsWith("/commands")){commands++;return route.fulfill({status:500});}
   if(path.endsWith("/plan-records"))return route.fulfill({json:{records:[],historyIncomplete:false}});
   if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:[summary]}});
   if(request.method()!=="GET")return route.fulfill({status:204});
   return route.fulfill({json:{...summary,hasPlanRecords:false,messages:[{id:"display",sourceId:"display",role:"agent",phase:"final_answer",text:source,occurredAt:stamp},
    {id:"acceptance",sourceId:"acceptance",role:"user",text:"批准",occurredAt:"2026-11-13T12:01:00Z"}],
    implementationPlan:{documentId,revision:"document-v2",plan:source,validation:"",itemKeys:[fixture.detailKey],approved,valid:true},
    documentPlanApproval:{documentId,revision:"document-v2",code:approved?"already_approved":"ready_to_restore"},canRecoverPlanApproval:true,
    canApprovePlan:false,planApprovalStatus:{code:approved?"approved":"not_approval"},...(approved?{planApprovalState:{approved:true,revision:"document-v2",continuationQueued:false}}:{})}});
  });
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"auto",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
  if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  const recovery=page.getByRole("region",{name:"核验原批准",exact:true});
  await expect(recovery).toContainText("原批准证据可核验");
  await recovery.getByRole("button",{name:"核验原批准",exact:true}).click();
  await expect(recovery).toContainText("批准证据不完整");
  await recovery.getByRole("button",{name:"核验原批准",exact:true}).click();
  await expect(recovery).toHaveCount(0);
  expect(posts).toBe(2);expect(commands).toBe(0);
  await expect(page.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 });
}
