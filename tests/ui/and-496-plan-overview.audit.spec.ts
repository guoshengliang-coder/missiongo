import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const stamp="2026-11-09T06:00:00Z",doc="11111111-1111-4111-8111-111111111111";
const exact="原始结论：减少重复提醒，直接处理待办。\n\n| 问题 | 诊断 | 修改建议 |\n|---|---|---|\n| 重复提醒 | 两处列表重复 | 保留独立评论 |\n\n**范围与风险：** 只改站内，不改变外部通知。\n\n**授权边界：** 不授权发布。";
for(const surface of ["console","panel"] as const) for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
 test(`overview exact summary, grouping, reading ${surface} ${width} ${theme}`,async({page},info)=>{
  await page.clock.setFixedTime(new Date(stamp));await page.setViewportSize({width,height:760});await page.emulateMedia({colorScheme:theme});
  const id="overview-session";let fail=false,historyCalls=0,onlyOne=false,invalid=false;
  const base={keys:[fixture.detailKey],scopeValid:true,legacy:false,submittedAt:stamp,current:false,effective:false,pending:false,currentValid:false};
  const effective={...base,id:1,revision:"approved",kind:"proposal",current:true,effective:true,currentValid:true,documentId:doc,version:1,summary:exact,approval:{approvedAt:stamp,source:"web"}};
  const note={...base,id:24,revision:"note",kind:"rework",version:24,documentId:"note-doc",parentDocumentId:doc,parentApproved:true,summary:"最新补修原文：保留草稿，未新增范围。"};
  const pending={...base,id:25,revision:"new-scope",kind:"proposal",version:2,current:true,pending:true,currentValid:true,summary:"另一范围的新方案待审，不能套用旧批准。"};
  const all=[pending,note,...Array.from({length:22},(_,i)=>({...base,id:23-i,revision:`old-${i}`,kind:"rework",version:23-i,parentDocumentId:doc,parentApproved:true})),effective];
  const session={id,agentSessionId:id,dispatchId:"overview-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"plan",dispatchStatus:"launched",activities:[],settings:{},unread:false,canReply:true,canRetry:false,canStop:false,canArchive:true,items:[{key:fixture.detailKey,title:"Plans",productId:fixture.productId}],hasPlanRecords:true,attention:{state:"none",kind:"none",reason:""},needsAttention:false,messages:[]};
  await page.route("**/api/v1/agent-sessions**",route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path.endsWith("/plan-records")) {
      if(url.searchParams.get("view")==="overview")return fail?route.fulfill({status:500,json:{message:"Temporary read failure"}}):route.fulfill({json:{records:onlyOne?[{...effective,...(invalid?{effective:false,currentValid:false}:{})}]:[pending,effective,note],hasHistory:!onlyOne,historyIncomplete:false}});
      const key=url.searchParams.get("recordId");
      if(key)return route.fulfill({json:{records:all.filter(r=>r.id===Number(key)).map(r=>({...r,markdown:"## 完整原文\n\n"+"完整验证与权限边界，不截断。\n\n".repeat(70),sha256:"a".repeat(64)})),historyIncomplete:false}});
      historyCalls++;
      const before=Number(url.searchParams.get("before")??Number.MAX_SAFE_INTEGER),rows=all.filter(r=>r.id<before);
      return route.fulfill({json:{records:rows.slice(0,20),historyIncomplete:false,...(rows.length>20?{nextBefore:rows[19]!.id}:{})}});
    }
    if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:[session]}});
    return route.fulfill({json:session});
  });
  await page.route("**/api/v1/plan-documents/*",route=>route.fulfill({json:{markdown:"## 原获批方案\n\n父方案完整范围。"}}));
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:session.dispatchId,agentSessionId:id,agentKind:"codex",mode:"plan",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
  if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  const reply=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await reply.fill("保留聊天草稿");
  const entry=page.getByRole("button",{name:"方案与审批",exact:true});await entry.click();
  const modal=page.getByRole("dialog",{name:"方案与审批",exact:true}),scroller=modal.locator('[data-screen="list"]');
  await expect(modal.locator('.agent-plan-version')).toHaveCount(3);
  expect(historyCalls).toBe(0);
  await expect(modal.locator('.agent-plan-group > h3')).toHaveText(["待审批方案","当前有效方案","最近补修"]);
  const approved=modal.locator('.agent-plan-version').filter({hasText:"原始结论"});
  await expect(approved).toContainText("只改站内，不改变外部通知。");await expect(approved).toContainText("不授权发布。");await expect(approved).toContainText("网页端批准");await expect(approved.locator('table')).toHaveCount(1);
  await expect(modal.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  await expect(modal.locator('.agent-plan-parent-reference')).toContainText("引用 v1");
  const parentEntry=modal.locator('.agent-plan-parent-reference').getByRole('button',{name:'查看原获批方案'});
  await parentEntry.click();await expect(modal).toContainText('父方案完整范围');
  await page.keyboard.press('Escape');await expect(parentEntry).toBeFocused();
  const history=modal.locator('.agent-plan-history');await expect(history).not.toHaveAttribute('open');await history.locator('summary').click();
  await expect(modal.locator('.agent-plan-history-row')).toHaveCount(18);
  await modal.getByRole('button',{name:'加载更早版本'}).click();await expect(modal.locator('.agent-plan-history-row')).toHaveCount(22);
  // Position and focus survive reading an old version.
  const old=modal.locator('.agent-plan-history-row').last().getByRole('button',{name:'查看版本原文'});
  await old.scrollIntoViewIfNeeded();const offset=await scroller.evaluate(el=>el.scrollTop);await old.click();
  await expect(modal).toContainText('完整原文');
  const detail=modal.locator('[data-screen="detail"]');await detail.evaluate(el=>el.scrollTop=el.scrollHeight);
  await expect(modal.getByRole('button',{name:'返回版本列表'})).toBeInViewport();await expect(modal.getByRole('button',{name:'关闭',exact:true})).toBeInViewport();
  await page.keyboard.press('Escape');await expect(old).toBeFocused();expect(Math.abs(await scroller.evaluate(el=>el.scrollTop)-offset)).toBeLessThan(2);
  await scroller.evaluate(el=>el.scrollTop=0);
  for(const scale of ['small','medium','large']){await page.evaluate(scale=>{document.documentElement.dataset.fontScale=scale;},scale);expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}
  await page.setViewportSize({width,height:460});await expect(modal.getByRole('button',{name:'关闭',exact:true})).toBeInViewport();
  await page.screenshot({path:info.outputPath(`overview-${surface}-${width}-${theme}.png`)});
  // Refreshed single/invalid records must not leave empty groups or stale authority.
  if(surface==="console" && width===1440 && theme==="light") {
    onlyOne=true;await page.clock.install();await page.clock.fastForward(6000);
    await expect(modal.locator('.agent-plan-version')).toHaveCount(1);
    await expect(modal.locator('.agent-plan-group > h3')).toHaveText(["当前有效方案"]);
    await expect(modal.locator('.agent-plan-history')).toHaveCount(0);
    await page.setViewportSize({width,height:1000});await scroller.evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:info.outputPath("implemented-single-plan.png")});
    invalid=true;await page.clock.fastForward(6000);
    await expect(modal.locator('.agent-plan-group > h3')).toHaveText(["当前记录 · 无有效批准"]);
    await expect(modal).toContainText("历史批准，不授予当前版本执行权限");
    fail=true;
    for(let n=0;n<4;n++)await page.clock.fastForward(12000);
    await expect(modal).toContainText('原始结论');
    await expect(modal.locator('.inline-error')).toBeVisible();
    fail=false;await modal.getByRole('button',{name:'重试',exact:true}).click();
    await expect(modal.locator('.inline-error')).toHaveCount(0);
  }
  await page.keyboard.press('Escape');await expect(entry).toBeFocused();await expect(reply).toHaveValue('保留聊天草稿');
 });
}
