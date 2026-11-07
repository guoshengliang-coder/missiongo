import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const stamp="2026-11-07T08:00:00Z";
const documentId="11111111-1111-4111-8111-111111111111";
const summary="**判断：属实。**\n\n建议修复离线恢复，真实进展仍更新时间。";
const markdown=summary+"\n\n## 完整验证\n\n| 场景 | 预期 | 方法 |\n|---|---|---|\n| 断线恢复 | 时间不变 | 模拟节点 |\n\n重大边界：不扩大执行权限。\n";
for(const width of [320,1440]) for(const theme of ["light","dark"] as const) {
 test(`fixed document is readable without approving at ${width}px ${theme}`,async({page,context},info)=>{
  await page.setViewportSize({width,height:900}); await page.emulateMedia({colorScheme:theme});
  const plan=summary+`\n\n[查看完整诊断与方案 · 第 1 轮 v1](/?planDocument=${documentId})\n\n批准覆盖摘要及固定文档。`;
  let posts=0;
  const session={id:"and452",agentSessionId:"and452",dispatchId:"fixture",agentKind:"codex",status:"idle",createdAt:stamp,updatedAt:stamp,activityAt:stamp,
    nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
    canReply:true,canRetry:false,canStop:false,canArchive:true,canApprovePlan:true,needsAttention:true,
    items:[{key:fixture.detailKey,title:"Fixture",productId:fixture.productId}],attention:{state:"needed",kind:"approval",revision:"r1"},planApprovalPending:true};
  await context.route("**/api/v1/plan-documents/**",route=>route.fulfill({json:{id:documentId,version:1,rounds:[{key:fixture.detailKey,number:1}],markdown,sha256:"a".repeat(64)}}));
  await page.route("**/api/v1/agent-sessions**",route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith("/plan-approval")){ posts++;return route.fulfill({status:201,json:{approved:true,revision:"r1",continuationQueued:false}}); }
    return route.fulfill({json:path==="/api/v1/agent-sessions" ? {sessions:[session]} : {...session,
      messages:[{id:"plan",sourceId:"plan",role:"agent",text:plan,occurredAt:stamp}],
      implementationPlan:{revision:"r1",plan,validation:"",documentId,approved:false,valid:true,submittedAt:stamp},
      planApproval:{revision:"r1",plan,validation:""},planApprovalStatus:{code:"ready"}}});
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=and452`);
  const reply=page.locator(".agent-console-reply textarea");await reply.fill("保留我的修改建议");
  const article=page.locator("article[data-agent-message-id]").filter({has:page.locator(".agent-plan-inline-approval")});
  await expect(article).toContainText("真实进展仍更新时间");
  await expect(article).not.toContainText("模拟节点");
  const popupPromise=page.waitForEvent("popup");await article.getByRole("link",{name:/查看完整诊断/}).click();const popup=await popupPromise;await popup.setViewportSize({width,height:900});await popup.emulateMedia({colorScheme:theme});
  await expect(popup.getByRole("heading",{name:"完整验证"})).toBeVisible();expect(posts).toBe(0);
  for(const scale of ["small","medium","large"]){await popup.evaluate(scale=>document.documentElement.dataset.fontScale=scale,scale);expect(await popup.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}
  await popup.screenshot({path:info.outputPath("document.png"),animations:"disabled"});await popup.close();
  await expect(reply).toHaveValue("保留我的修改建议");await article.getByRole("button",{name:"提出修改"}).click();await expect(reply).toBeFocused();expect(posts).toBe(0);
  await article.getByRole("button",{name:"批准",exact:true}).click();expect(posts).toBe(1);
  await page.screenshot({path:info.outputPath("summary.png"),animations:"disabled"});
 });
}
