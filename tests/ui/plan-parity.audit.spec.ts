import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const documentId="11111111-1111-4111-8111-111111111111";
const sample="| 项目 | 判断 | 建议 |\n|---|---|---|\n| 示例一 | 图片未显示 | 检查图片链接 |\n| 示例二 | 按钮未关闭窗口 | 修复关闭动作 |\n\n[完整说明](https://example.test/?planDocument="+documentId+")";
const outputs:Record<string,string[]>=process.env.PLAN_PARITY_MESSAGES ? JSON.parse(readFileSync(process.env.PLAN_PARITY_MESSAGES,"utf8")) : {codex:[sample],claude:[sample],opencode:[sample,"等待进一步输入。[完整说明](https://example.test/?planDocument="+documentId+")"]};
for(const surface of ["console","panel"] as const) for(const [agent,texts] of Object.entries(outputs)) {
 test(`${surface} preserves every ${agent} source message across delayed plan sync`,async({page})=>{
  const id="parity-"+agent,stamp="2026-11-07T12:00:00Z";
  const summary={id,agentSessionId:id,dispatchId:"parity-dispatch",agentKind:agent==="claude"?"claude_code":agent,status:"idle",createdAt:stamp,updatedAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",nodeRevoked:false,mode:"plan",dispatchStatus:"launched",activities:[],settings:{},unread:false,canReply:true,canRetry:false,canStop:false,canArchive:true,canApprovePlan:true,items:[{key:fixture.detailKey,title:"Fixture",productId:fixture.productId}],attention:{state:"needed",kind:"approval"},needsAttention:true};
  const plan={revision:"v2",documentId,plan:sample,validation:"",itemKeys:[fixture.detailKey],valid:true,approved:false};
  let synced=false;
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions" ? {sessions:[summary]} : {...summary,messages:synced?texts.map((text,n)=>({id:`source-${n}`,sourceId:`source-${n}`,role:"agent",phase:n===0?"final_answer":"commentary",text,occurredAt:stamp})):[],implementationPlan:plan,planApproval:plan,planApprovalStatus:{code:"ready"}}}));
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:summary.agentKind,mode:"plan",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
  async function open(){
   if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
   else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  }
  await open();
  await expect(page.getByText("方案已登记，正在关联会话消息。",{exact:true})).toBeVisible();
  await expect(page.locator("article[data-agent-message-id]")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  await expect(page.locator(".agent-console-attention-banner.agent-plan-record")).toHaveCount(0);
  synced=true;await open();
  const articles=page.locator("article[data-agent-message-id]");await expect(articles).toHaveCount(texts.length);
  await expect(articles.first().getByRole("link",{name:"完整说明"})).toHaveAttribute("href",`https://example.test/?planDocument=${documentId}`);
  await expect(articles.first().getByRole("button",{name:"批准",exact:true})).toBeEnabled();
  await expect(articles.first().locator("table")).toHaveCount(1);
  await expect(page.getByText("方案已登记，正在关联会话消息。",{exact:true})).toHaveCount(0);
  // Source output, including additional native messages, must never be hidden.
  for(let n=0;n<texts.length;n++)await expect(articles.nth(n)).toHaveAttribute("data-agent-message-id",`agent:source-${n}`);
 });
}
