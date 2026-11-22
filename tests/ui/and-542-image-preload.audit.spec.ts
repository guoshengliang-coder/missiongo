import { readFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const stamp="2026-11-22T12:00:00Z";
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=";
for(const width of [375,1440])test(`preloads an unopened conversation without reading it and reuses bytes on switch at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.clock.setFixedTime(new Date(stamp));
  const rows=["current","unopened"].map(id=>({id,agentSessionId:id,dispatchId:`dispatch-${id}`,agentKind:"codex",status:"idle",mode:"auto",dispatchStatus:"launched",nodeName:"Fixture",
    sessionName:id==="current"?"当前会话":"尚未打开的图片会话",createdAt:stamp,updatedAt:stamp,activityAt:stamp,activities:[],
    items:[{key:fixture.detailKey,title:id==="current"?"当前会话":"尚未打开的图片会话",productId:fixture.productId}],settings:{mode:"auto",adjustable:false},
    canReply:true,canAttach:false,canResolveDelivery:false,canArchive:true,canStop:false,canRetry:false,attention:{state:"not_needed"},turnState:{},unread:id==="unopened",unreadAt:stamp}));
  let bundleReads=0,unopenedDetails=0,unopenedRead=0,largeReads=0;
  await page.route("**/api/v1/agent-artifact-preloads?**",route=>route.fulfill({json:{images:[
    {id:"saved-image",sessionId:"unopened",sourceId:"image",href:"/tmp/fixture-output/image.png",sizeBytes:200},
    {id:"large-image",sessionId:"unopened",sourceId:"large",href:"/tmp/fixture-output/large.png",sizeBytes:3*1024*1024}]}}));
  await page.route("**/api/v1/agent-sessions**",async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith("/read")) {if(path.includes("unopened"))unopenedRead++;return route.fulfill({status:204});}
    if(path.endsWith("/bundle")) {
      if(path.includes("large-image"))largeReads++;else bundleReads++;
      return route.fulfill({json:{entry:"image.png",files:[{name:"image.png",contentType:"image/png",base64:png}]}});
    }
    if(path.endsWith("/artifacts") || path.includes("/artifacts/"))return route.fulfill({json:{id:"saved-image",status:"ready",filename:"image.png"}});
    if(path==="/api/v1/agent-sessions")return route.fulfill({json:{sessions:rows}});
    if(path.endsWith("/unopened"))unopenedDetails++;
    const row=rows.find(row=>path.endsWith(`/${row.id}`));
    if(row)return route.fulfill({json:{...row,messages:[{id:`message-${row.id}`,sourceId:"image",role:"agent",text:row.id==="unopened"?"[图片](/tmp/fixture-output/image.png)":"当前内容",occurredAt:stamp}]}});
    return route.fulfill({status:204});
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=current`);
  await expect.poll(()=>bundleReads).toBe(1);
  expect(unopenedDetails).toBe(0);expect(unopenedRead).toBe(0);expect(largeReads).toBe(0);
  const input=page.locator(".agent-console-reply textarea");await input.fill("保留当前草稿");
  if(width<=520)await page.getByRole("button",{name:"返回会话列表",exact:true}).click();
  await page.locator(".agent-console-session").filter({hasText:"尚未打开的图片会话"}).click();
  const image=page.locator(".agent-output-image img");await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(1);
  expect(bundleReads).toBe(1);expect(largeReads).toBe(0);
  await page.locator(".agent-output-image-open").click();
  await expect(page.getByRole("dialog")).toBeVisible();expect(bundleReads).toBe(1);
  await page.getByRole("dialog").getByRole("button",{name:/^关闭(?:预览)?$/}).click();
  await page.screenshot({path:test.info().outputPath(`preloaded-image-${width}.png`)});
  if(width<=520)await page.getByRole("button",{name:"返回会话列表",exact:true}).click();
  await page.locator(".agent-console-session").filter({hasText:"当前会话"}).click();
  await expect(input).toHaveValue("保留当前草稿");
});
