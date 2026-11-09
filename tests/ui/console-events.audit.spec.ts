import { expect, test } from "@playwright/test";
import { refreshFromConsoleStream } from "./polling";
import { readFileSync } from "node:fs";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
test.beforeEach(async({page})=>{await page.clock.install({time:new Date("2026-11-09T02:00:00Z")});});
for(const width of [320,1440])test(`SSE refreshes comments, preserves drafts and stops idle business reads at ${width}`,async({page,request})=>{
 await page.setViewportSize({width,height:900});
 await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
 await expect(page.locator(".detail-pane")).toBeVisible();
 // Wait until the real stream has opened and its initial reconciliation has settled.
 await expect.poll(()=>page.locator(".offline-banner").count()).toBe(0);
 const comment=page.locator('textarea').filter({visible:true}).last();
 await comment.fill("保留未发送草稿");
 const reads:string[]=[];page.on("request",r=>{if(r.method()==="GET"&&r.url().includes("/api/v1/")&&!r.url().includes("/console/events"))reads.push(new URL(r.url()).pathname);});
 await page.clock.fastForward(1000);await page.waitForTimeout(300);reads.length=0;
 await page.clock.fastForward(180_000);await page.waitForTimeout(300);
 expect(reads).toEqual([]);
 const text=`SSE 新评论 ${width}`;
 const started=Date.now();
 const sent=await request.post(`/api/v1/items/${fixture.detailKey}/comments`,{data:{text}});expect(sent.ok()).toBe(true);
 await expect(page.locator(".detail-pane")).toContainText(text);
 expect(Date.now()-started).toBeLessThan(1000);
 await expect(comment).toHaveValue("保留未发送草稿");
 await page.context().setOffline(true);await page.waitForTimeout(200);
 const offlineText=`断线补拉 ${width}`;
 const offline=await request.post(`/api/v1/items/${fixture.detailKey}/comments`,{data:{text:offlineText}});expect(offline.ok()).toBe(true);
 await page.context().setOffline(false);
 await page.clock.fastForward(1500);
 await expect(page.locator(".detail-pane")).toContainText(offlineText);
 await expect(comment).toHaveValue("保留未发送草稿");
});

for(const [width,theme] of [[320,"dark"],[1440,"light"]] as const)test(`SSE failure is readable and retry preserves drafts ${width} ${theme}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
 let unavailable=true;
 await page.route("**/api/v1/console/events**",route=>unavailable?route.fulfill({status:503}):route.continue());
 await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
 const banner=page.locator(".offline-banner");await expect(banner).toContainText("实时更新连接已中断");
 const comment=page.locator('textarea').filter({visible:true}).last();await comment.fill("连接失败也保留草稿");
 for(const scale of ["small","medium","large"]){
  await page.evaluate(scale=>{document.documentElement.dataset.fontScale=scale;},scale);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const button=await banner.getByRole("button",{name:"重试",exact:true}).boundingBox();expect(button!.width).toBeGreaterThanOrEqual(44);expect(button!.height).toBeGreaterThanOrEqual(44);expect(button!.x).toBeGreaterThanOrEqual(0);expect(button!.x+button!.width).toBeLessThanOrEqual(width);
 }
 await page.screenshot({path:info.outputPath(`sse-failure-${width}-${theme}.png`)});
 unavailable=false;await banner.getByRole("button",{name:"重试",exact:true}).click();await expect(banner).toHaveCount(0);await expect(comment).toHaveValue("连接失败也保留草稿");
});

test("journal reset rebuilds the mounted page and preserves the saved comment draft",async({page})=>{
 await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
 await expect(page.locator(".detail-pane")).toBeVisible();
 const draft=page.locator('textarea').filter({visible:true}).last();
 await draft.fill("日志裁剪后保留草稿");
 const composer=page.locator(".comment-form");
 await composer.locator('input[type="file"]').setInputFiles({name:"reset-audit.txt",mimeType:"text/plain",buffer:Buffer.from("attachment retained across reset")});
 await expect(composer.locator(".agent-chat-draft-files")).toContainText("reset-audit.txt");
 const bootstrap=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/bootstrap");
 await refreshFromConsoleStream(page);await bootstrap;
 await expect(page.locator(".detail-pane")).toBeVisible();
 await expect(page.locator('textarea').filter({visible:true}).last()).toHaveValue("日志裁剪后保留草稿");
 await expect(composer.locator(".agent-chat-draft-files")).toContainText("reset-audit.txt");
 await expect(composer).not.toContainText("上次选择的附件未恢复");
 const sent=page.waitForResponse(r=>r.request().method()==="POST" && new URL(r.url()).pathname===`/api/v1/items/${fixture.detailKey}/comments`);
 await composer.locator('button[type="submit"]').click();
 expect((await sent).ok()).toBe(true);
 await expect(composer.locator(".agent-chat-draft-files")).toHaveCount(0);
});

for(const loseResponse of [false,true])test(`active send survives reset and settles once, lost response ${loseResponse}`,async({page})=>{
 const item=await (await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title:"Send across reset",description:"",environment:{platform:"web"}}})).json();
 await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
 const composer=page.locator(".comment-form"),send=composer.locator('button[type="submit"]'),text=composer.locator("textarea");
 await text.fill("one intended comment");
 await composer.locator('input[type=file]').setInputFiles({name:"send.txt",mimeType:"text/plain",buffer:Buffer.from("send evidence")});
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>entered=r);
 let held=false;const keys:string[]=[];
 await page.route(`**/api/v1/items/${item.key}/comments`,async route=>{
  if(route.request().method()!=="POST"){await route.continue();return;}
  keys.push(route.request().postDataJSON().idempotencyKey);
  if(!held){held=true;const response=await route.fetch();entered();await gate;
   if(loseResponse)await route.abort("failed");else await route.fulfill({response});
  }else await route.continue();
 });
 await send.click();await waiting;
 const bootstrap=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/bootstrap");
 await refreshFromConsoleStream(page);await bootstrap;
 await expect(composer).toBeVisible();await expect(send).toBeDisabled();await expect(text).toBeDisabled();
 // Even a synthetic submit must not launch another mutation while remounted.
 await composer.dispatchEvent("submit");expect(keys).toHaveLength(1);
 release();
 if(loseResponse){
  await expect(composer.locator(":scope > .inline-error")).toBeVisible();
  await expect(text).toHaveValue("one intended comment");
  await expect(composer.locator(".agent-chat-draft-files")).toContainText("send.txt");
  await expect(send).toBeEnabled();await send.click();
  await expect.poll(()=>keys.length).toBe(2);expect(keys[1]).toBe(keys[0]);
 }
 await expect(text).toHaveValue("");await expect(text).toBeEnabled();
 await expect(composer.locator(".agent-chat-draft-files")).toHaveCount(0);
 const comments=await (await page.request.get(`/api/v1/items/${item.key}/comments`)).json();expect(comments.comments).toHaveLength(1);
 const attachments=await (await page.request.get(`/api/v1/items/${item.key}/attachments`)).json();expect(attachments.attachments).toHaveLength(1);
 await text.fill("new unsent draft");
 await composer.locator('input[type=file]').setInputFiles({name:"next.txt",mimeType:"text/plain",buffer:Buffer.from("next draft")});
 await page.waitForTimeout(100);
 await expect(text).toHaveValue("new unsent draft");await expect(composer.locator(".agent-chat-draft-files")).toContainText("next.txt");
 const persisted=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("missiongo.comment-draft")).map(k=>localStorage.getItem(k)));
 expect(persisted.some(raw=>raw?.includes("new unsent draft"))).toBe(true);
});
