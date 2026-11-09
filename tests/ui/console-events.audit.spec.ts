import { expect, test } from "@playwright/test";
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
