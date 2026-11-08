import {randomBytes} from "node:crypto";
import {expect,test} from "@playwright/test";
import {postItemCommand} from "./item-command";
for(const width of [375,1440]) test(`continuous delivery remains visible at ${width}px`,async({page,request},info)=>{
 const product=await (await request.post("/api/v1/products",{data:{name:"Parallel delivery",keyPrefix:`PD${randomBytes(3).toString("hex").toUpperCase()}`}})).json();
 const item=await (await request.post("/api/v1/items",{data:{productId:product.id,title:"连续交付版本",description:"Isolated fixture",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}})).json();
 expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}})).ok()).toBe(true);
 const base=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
 await page.route(`**/api/v1/items/${item.key}/delivery`,route=>route.fulfill({json:{...base,canHandoffToAgent:true,deliveries:[
  {id:"published-first",createdAt:"2026-11-08T01:00:00Z",published:true,status:"published",requiredArtifacts:["web"],releases:[{artifact:"web",version:"1.0",sourceCommit:"a".repeat(40)}]},
  {id:"pending-second",createdAt:"2026-11-08T02:00:00Z",published:false,status:"partial",requiredArtifacts:["web","macosApp"],releases:[{artifact:"web",version:"1.1",sourceCommit:"b".repeat(40)}]}
 ]}}));
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:width===375?"dark":"light"});
 await page.goto(`/?product=${product.id}&status=in_progress`);
 await page.locator(".item-row").filter({hasText:item.key}).locator(".item-row-main").click();
 if(width===375)await page.locator(".detail-toolbar .detail-more-menu > summary").click();
 await expect(page.locator(".detail-toolbar").getByRole("button",{name:"派单",exact:true})).toBeVisible();
 if(width===375)await page.keyboard.press("Escape");
 const panel=page.locator(".delivery-panel");await expect(panel).toContainText("新增合并");
 await panel.getByText("交付版本",{exact:true}).click();await expect(panel).toContainText("最近完整交付版本: published-first");
 await expect(panel).toContainText("部分产物已发布");await expect(panel).toContainText("web: 1.1");
 expect(await page.locator(".detail-scroll").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
 await panel.screenshot({path:info.outputPath(`delivery-${width}.png`)});
 expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
 await page.reload();await expect(page.locator(".detail-toolbar .status-pill")).toHaveText("待验证");
 if(width===375)await page.locator(".detail-toolbar .detail-more-menu > summary").click();
 await expect(page.locator(".detail-toolbar").getByRole("button",{name:"派单",exact:true})).toHaveCount(0);
});
