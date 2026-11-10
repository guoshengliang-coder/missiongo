import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { refreshFromConsoleStream } from "./polling";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const stamp="2026-11-10T00:00:00Z";
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date(stamp));});

test("late reset bootstrap does not roll back a freshly read product",async({page})=>{
 let delay=false,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>entered=resolve);
 await page.route("**/api/v1/bootstrap**",async route=>{
  const response=await route.fetch(),data=await response.json();
  if(delay){for(const product of data.products)if(product.id===fixture.productId)product.name="Older bootstrap name";entered();await gate;}
  await route.fulfill({response,json:data});
 });
 await page.route(/\/api\/v1\/products$/,async route=>{
  const response=await route.fetch(),data=await response.json();
  if(delay)for(const product of data)if(product.id===fixture.productId)product.name="Fresh product name";
  await route.fulfill({response,json:data});
 });
 await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
 await expect(page.locator(".detail-pane")).toBeVisible();delay=true;
 await refreshFromConsoleStream(page);await waiting;
 const selector=page.getByRole("combobox",{name:"当前产品"});await expect(selector).toContainText("Fresh product name");
 const done=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/bootstrap");release();await (await done).finished();
 // Observe a render after the released response, not only before it settles.
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(selector).toContainText("Fresh product name");await expect(selector).not.toContainText("Older bootstrap name");
});

test("identity merge refreshes the open canonical transcript after a targeted SSE event",async({page})=>{
 const a="audit-canonical",b="audit-tracking";let merged=false;
 const summary=(id:string)=>({id,agentSessionId:id,dispatchId:`dispatch-${id}`,agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
  nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
  canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,
  items:[{key:fixture.detailKey,title:"Identity audit",productId:fixture.productId}]});
 await page.route("**/api/v1/agent-sessions**",route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:merged?[{...summary(a),relatedSessionIds:[a,b]}]:[summary(a),summary(b)]}});
  return route.fulfill({json:{...summary(a),messages:[{id:"message",role:"agent",text:merged?"Merged transcript":"Old transcript",occurredAt:stamp}]}});
 });
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=async(input,init)=>{
   if(!String(input).startsWith("/api/v1/console/events"))return original(input,init);
   return new Response(new ReadableStream({start(controller){
    (window as unknown as {emitAuditChange:(id:string)=>void}).emitAuditChange=id=>controller.enqueue(new TextEncoder().encode(`id: audit:1\nevent: change\ndata: ${JSON.stringify({resources:[{kind:"sessions",resourceId:id}]})}\n\n`));
    init?.signal?.addEventListener("abort",()=>controller.close(),{once:true});
   }}),{headers:{"content-type":"text/event-stream"}});
  };
 });
 await page.goto(`/?product=${fixture.productId}&console=agent&session=${a}`);
 const transcript=page.locator(".agent-console-messages");await expect(transcript).toContainText("Old transcript");
 const draft=page.locator(".agent-console-reply textarea");await draft.fill("Keep this draft");merged=true;
 await page.evaluate(id=>(window as unknown as {emitAuditChange:(id:string)=>void}).emitAuditChange(id),b);
 await expect(transcript).toContainText("Merged transcript");await expect(draft).toHaveValue("Keep this draft");
});
