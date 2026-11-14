import {readFileSync} from "node:fs";
import {expect,test,type Page} from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
const stamp="2026-11-13T02:00:00.000Z",id="and519-cache";
const summary={id,agentSessionId:id,dispatchId:"and519-dispatch",productId:fixture.productId,
 agentKind:"codex",status:"idle",updatedAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeId:"fixture-node",
 nodeConnectionState:"online",nodeRevoked:false,mode:"auto",dispatchStatus:"launched",createdAt:stamp,
 items:[],activities:[],settings:{},unread:false,canReply:true,canStop:false,canArchive:true,canRetry:false,
 sessionName:"列表缓存回归",attention:{state:"needed",kind:"instruction",reason:"Fixture reminder"},needsAttention:true,waitingForReply:true};
const detail={...summary,messages:[{id:"message",sourceId:"message",role:"agent",text:"已加载的会话正文",occurredAt:stamp}]};
async function fixturePage(page:Page){
 await page.clock.setFixedTime(new Date(stamp));
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=async(input,init)=>{
   if(!String(input).startsWith("/api/v1/console/events"))return original(input,init);
   const stream=new ReadableStream<Uint8Array>({start(controller){
    const send=(data:string)=>controller.enqueue(new TextEncoder().encode(data));
    send('event: hello\ndata: {"epoch":"and519","version":0}\n\n');
    (window as unknown as {listChange:(version:number)=>void}).listChange=version=>send(`id: and519:${version}\nevent: change\ndata: {"resources":[{"kind":"sessions","resourceId":"and519-cache"}]}\n\n`);
    init?.signal?.addEventListener("abort",()=>controller.close(),{once:true});
   }});
   return new Response(stream,{headers:{"content-type":"text/event-stream"}});
  };
 });
 let reads=0,fail=false,gate:Promise<void>|undefined,release=()=>{};
 await page.route("**/api/v1/agent-sessions**",async route=>{
  if(route.request().method()!=="GET")return route.fulfill({status:204});
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/v1/agent-sessions"){
   reads++;if(gate)await gate;
   return fail?route.fulfill({status:503,json:{error:{code:"unavailable",message:"Synthetic unavailable"}}}):route.fulfill({json:{sessions:[summary]}});
  }
  return route.fulfill({json:detail});
 });
 return {reads:()=>reads,fail:()=>{fail=true;},hold:()=>{gate=new Promise<void>(resolve=>{release=resolve;});},release:()=>release()};
}
async function change(page:Page,version:number){await page.evaluate(version=>(window as unknown as {listChange:(version:number)=>void}).listChange(version),version);}
for(const [width,colorScheme] of [[320,"dark"],[1440,"light"]] as const)test(`cached console return revalidates in background ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
 const f=await fixturePage(page);
 await page.goto(`/?product=${fixture.productId}&console=agent`);
 const row=page.locator(".agent-console-session").filter({hasText:summary.sessionName});await expect(row).toBeVisible();
 const initial=f.reads();
 await page.locator(".agent-console-topbar-back").click();await expect(page).not.toHaveURL(/console=agent/);
 await page.waitForTimeout(200);expect(f.reads()).toBe(initial);
 await page.goForward();await expect(row).toBeVisible();await page.waitForTimeout(200);expect(f.reads()).toBe(initial);
 await page.locator(".agent-console-topbar-back").click();
 await page.clock.setFixedTime(new Date(Date.parse(stamp)+120_000));f.hold();
 try{
  await page.goForward();await expect(row).toBeVisible();await expect.poll(f.reads).toBe(initial+1);
  await expect(row).toBeVisible();await expect(page.locator(".agent-console-list .agent-console-empty .spin")).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{f.release();}
});

test("a list event burst uses one read and list failures preserve conversation and draft",async({page})=>{
 const f=await fixturePage(page);
 await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
 await expect(page.locator(".agent-console-message")).toContainText("已加载的会话正文");
 const reply=page.locator(".agent-console-reply textarea");await reply.fill("读取失败仍保留草稿");
 const before=f.reads();
 for(let n=1;n<=8;n++)await change(page,n);
 await expect.poll(f.reads).toBe(before+1);await page.waitForTimeout(150);expect(f.reads()).toBe(before+1);
 f.fail();await change(page,9);
 await expect(page.locator(".agent-console-list .inline-error")).toBeVisible();
 await expect(page.locator(".agent-console-message")).toContainText("已加载的会话正文");
 await expect(reply).toHaveValue("读取失败仍保留草稿");
 await expect(page.locator(".agent-console-messages")).not.toContainText("Synthetic unavailable");
});
