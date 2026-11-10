import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { refreshFromConsoleStream } from "./polling";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const id="and-497-session",stamp="2026-11-10T00:00:00Z";
for(const width of [320,1440])for(const surface of ["console","panel"] as const)test(`project delivery failure stays outside ${surface} conversation at ${width}`,async({page},info)=>{
 await page.clock.install({time:new Date(stamp)});await page.setViewportSize({width,height:900});
 const summary={id,agentSessionId:id,dispatchId:"recovery-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
 nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
 canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,items:[{key:fixture.detailKey,title:"Recovery",productId:fixture.productId}]};
 let body="Cached conversation",scopedFailure=false,hasOffer=false;
 await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,messages:[{id:"message",role:"agent",text:body,occurredAt:stamp}]}}));
 await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"auto",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
 await page.route(/\/merge-deliveries(?:\?.*)?$/,route=>{
  if(!new URL(route.request().url()).searchParams.has("sessionId"))return route.fulfill({status:503,json:{title:"Project list unavailable"}});
  if(scopedFailure)return route.fulfill({status:503,json:{title:"Session delivery unavailable"}});
  return route.fulfill({json:{deliveries:hasOffer?[{id:"offer",productId:fixture.productId,sessionId:id,revision:"r",state:"proposed",summary:"Standalone offer",validation:"Passed",itemKeys:[],head:"a".repeat(40),requiredArtifacts:["web"],evidence:{checkedAt:stamp,source:"Fixture"}}]:[],batches:[],sessionProgress:{}}});
 });
 if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
 else {await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
 const messages=page.locator(surface==="console"?".agent-console-messages":".agent-session-messages");
 await expect(messages).toContainText(body);
 const draft=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await draft.fill("Keep my draft");
 await page.clock.fastForward(1100);
 await expect(messages).not.toContainText("待集成清单加载失败");await expect(page.locator(".offline-banner")).toHaveCount(0);
 body="Fresh conversation";await refreshFromConsoleStream(page);await expect(messages).toContainText(body);await expect(draft).toHaveValue("Keep my draft");
 hasOffer=true;await refreshFromConsoleStream(page);await expect(page.locator(".merge-delivery-notice.proposed")).toBeVisible();
 scopedFailure=true;await refreshFromConsoleStream(page);await page.clock.fastForward(1100);
 const error=page.getByText("当前会话的交付状态更新失败。");await expect(error).toBeVisible();
 await expect(page.locator(".merge-delivery-notice.proposed")).toBeVisible();await expect(page.locator(".offline-banner")).toHaveCount(0);
 scopedFailure=false;await error.getByRole("button",{name:"重试",exact:true}).click();await expect(error).toHaveCount(0);
 await expect(draft).toHaveValue("Keep my draft");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`recovery-${surface}-${width}.png`)});
 if(surface==="console"){
  if(width===320)await page.getByRole("button",{name:"返回会话列表",exact:true}).click();
  await page.getByRole("button",{name:/^待集成/}).click();await expect(page.getByRole("dialog")).toContainText("待集成清单加载失败");
 }
});
