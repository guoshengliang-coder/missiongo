import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {advanceSessionDetailPoll} from "./polling";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const doc="11111111-1111-4111-8111-111111111111", stamp="2026-11-08T00:00:00Z";
for(const surface of ["console","panel"] as const) for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
 test(`${surface} plan transition and historical reading ${width} ${theme}`,async({page},info)=>{
  await page.clock.install();await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const id="records-test";let synced=false,approved=false,revision="v2";
  const summary={id,agentSessionId:id,dispatchId:"records-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"plan",dispatchStatus:"launched",activities:[],settings:{},unread:false,canReply:true,canRetry:false,canStop:false,canArchive:true,items:[{key:fixture.detailKey,title:"Plans",productId:fixture.productId}],attention:{state:"needed",kind:"approval",reason:"待审"},needsAttention:true};
  const source="方案摘要\n\n[完整方案](/?planDocument="+doc+")";
  const records=[{id:2,revision:"v2",keys:[fixture.detailKey],kind:"proposal",current:true,effective:false,scopeValid:true,legacy:false,version:2,documentId:doc,submittedAt:stamp},
   {id:1,revision:"v1",keys:[fixture.detailKey],kind:"proposal",current:false,effective:false,scopeValid:true,legacy:true,version:1,approval:{source:"web",approvedAt:stamp}}];
  await page.route("**/api/v1/agent-sessions**",route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path.endsWith("/plan-records")){const key=url.searchParams.get("recordId");return route.fulfill({json:{historyIncomplete:true,records:key?records.filter(r=>r.id===Number(key)).map(r=>({...r,markdown:"## 固定版本原文\n\n版本 "+r.version+" 的完整范围。\n\n"+"保留验证与授权边界。\n\n".repeat(30),sha256:"a".repeat(64)})):records}})}
   if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:[summary]}});
   if(route.request().method()!=="GET")return route.fulfill({status:204});
   const plan={revision,documentId:doc,plan:source,validation:"",itemKeys:[fixture.detailKey],approved,valid:true};
   return route.fulfill({json:{...summary,hasPlanRecords:true,messages:synced?[{id:"native-plan",sourceId:"native-plan",role:"agent",phase:"final_answer",text:source,occurredAt:stamp}]:[],implementationPlan:plan,canApprovePlan:!approved,planApprovalStatus:{code:approved?"approved":"ready"},...(!approved?{planApproval:plan}:{planApprovalState:{approved:true,revision,continuationQueued:false}})}});
  });
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"plan",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
  if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  const pending=page.getByRole("region",{name:"方案记录",exact:true});
  await expect(pending).toContainText("正在关联会话消息");
  await expect(page.locator(".agent-console-attention-banner.agent-plan-record")).toHaveCount(0);
  await page.clock.fastForward(3000);await expect(pending).not.toContainText("方案待审阅");
  await page.clock.fastForward(2200);await expect(pending).toContainText("尚未关联到当前已加载消息");
  await expect(pending.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  expect((await pending.getByRole("link",{name:"查看已登记方案",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Polling must not reset the already elapsed grace period.
  await advanceSessionDetailPoll(page);await expect(pending).toContainText("方案待审阅");
  revision="v3";await advanceSessionDetailPoll(page);await expect(pending).toContainText("正在关联会话消息");
  synced=true;await advanceSessionDetailPoll(page);
  await expect(pending).toHaveCount(0);
  const message=page.locator('[data-agent-message-id="agent:native-plan"]');await expect(message).toContainText("方案摘要");
  await expect(message.getByRole("button",{name:"批准",exact:true})).toBeVisible();
  approved=true;await advanceSessionDetailPoll(page);await expect(message).toContainText("方案已批准");
  const reply=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await reply.fill("保留草稿");
  const entry=page.getByRole("button",{name:"方案与审批",exact:true});await entry.click();
  const modal=page.getByRole("dialog",{name:"方案与审批",exact:true});await expect(modal).toBeVisible();
  await expect(modal).toContainText("历史批准，不授予当前版本执行权限");await expect(modal.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  const old=modal.getByRole("button",{name:"查看版本原文",exact:true}).nth(1);await old.click();
  await expect(modal).toContainText("版本 1 的完整范围");
  for(const scale of ["small","medium","large"]){await page.evaluate(scale=>{document.documentElement.dataset.fontScale=scale;document.documentElement.dataset.consoleFontScale=scale;},scale);expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}
  await page.screenshot({path:info.outputPath(`history-${surface}-${width}-${theme}.png`)});
  await page.keyboard.press("Escape");await expect(old).toBeFocused();await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");await expect(modal).toHaveCount(0);await expect(entry).toBeFocused();await expect(reply).toHaveValue("保留草稿");
  // Settled records with no source match stay in details, never reappear as a banner.
  synced=false;await advanceSessionDetailPoll(page);await page.clock.fastForward(6000);await expect(pending).toHaveCount(0);await expect(entry).toBeVisible();
  await page.screenshot({path:info.outputPath(`settled-${surface}-${width}-${theme}.png`)});
 });
}
