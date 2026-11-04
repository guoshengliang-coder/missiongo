import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { postItemCommand } from "./item-command";

const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [320,1440]) for(const theme of ["light","dark"] as const) test.describe(`retired checks ${width} ${theme}`,()=>{
 test.use({viewport:{width,height:900},hasTouch:width===320,isMobile:width===320,colorScheme:theme});
 for(const source of ["list","detail"] as const) test(`${source} completes and submits work without checks`,async({page,request})=>{
  const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"Explicit delivery regression",description:"Human decides the card stage",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});
  expect(created.ok()).toBe(true);const item=await created.json() as {key:string};
  expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}})).ok()).toBe(true);
  const checkRequests:string[]=[];
  page.on("request",r=>{if(/\/(status-checks|completion-discovery|handover)(?:[/?]|$)/.test(r.url()))checkRequests.push(r.url());});
  await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}${source==="detail"?`&item=${item.key}`:""}`);
  await expect(page.getByRole("button",{name:/^(检查状态|状态检查)$/})).toHaveCount(0);
  for(const scale of ["small","medium","large"]) {
   await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
  for(const target of ["development_complete","pending_verification"]) {
   if(source==="list") {
    const row=page.locator(".item-row").filter({hasText:item.key});
    await row.locator(".row-more-menu > summary").click();
    await row.locator("button.menu-primary").click();
   } else await page.locator(".detail-toolbar button.toolbar-primary-action").click();
   await expect.poll(async()=> (await (await request.get(`/api/v1/items/${item.key}`)).json()).status).toBe(target);
   await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  if(source==="detail") {
   await page.locator(".detail-toolbar .detail-more-menu > summary").click();
   await expect(page.getByRole("button",{name:"状态检查",exact:true})).toHaveCount(0);
   await page.keyboard.press("Escape");
  }
  expect(checkRequests).toEqual([]);
  await page.screenshot({path:test.info().outputPath(`${source}-${width}-${theme}.png`)});
 });
});
