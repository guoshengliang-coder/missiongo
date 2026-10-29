import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {AUDIT_SOURCE} from "./audit-page.mjs";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [375,1440])for(const theme of ["light","dark"] as const){
 test.describe(`${width}px ${theme} statistics`,()=>{
  test.use({viewport:{width,height:900},hasTouch:width===375,isMobile:width===375,colorScheme:theme});
  test("renders shared totals, expands chart points and preserves filters through item navigation",async({page,request})=>{
   const result=await request.get(`/api/v1/project-insights?period=today&productIds=${fixture.productId}`);expect(result.status()).toBe(200);
   const data=await result.json();
   await page.goto(`/?statistics=1&statsProject=${fixture.productId}&statsPeriod=today`);
   await expect(page.getByRole("heading",{name:"产品统计",exact:true})).toBeVisible();
   await expect(page.locator(".statistics-metric").filter({has:page.getByRole("heading",{name:"新增条目",exact:true})}).getByRole("button")).toHaveText(String(data.aggregate.counts.created));
   await page.waitForLoadState("networkidle");
   const audit=await page.evaluate(AUDIT_SOURCE) as {horizontalOverflow:number;text:Array<{fontSize:number;fontWeight:number;contrast:number;where:string;sample:string}>;targets:Array<{width:number;height:number;where:string}>};
   expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
   expect(audit.text.filter(x=>x.fontSize>0&&x.fontSize<11)).toEqual([]);
   expect(audit.text.filter(x=>x.contrast<(x.fontSize>=24||(x.fontWeight>=700&&x.fontSize>=18.66)?3:4.5))).toEqual([]);
   if(width===375)expect(audit.targets.filter(x=>x.width>0&&x.height>0&&(x.width<44||x.height<44))).toEqual([]);
   await page.screenshot({path:test.info().outputPath(`statistics-${width}-${theme}.png`),fullPage:true});
   await page.getByRole("button",{name:`${data.period.startDate} 新增条目 ${data.aggregate.counts.created}`,exact:true}).click();
   const details=page.getByRole("region",{name:"条目明细",exact:true});
   await expect(details.getByText(`共 ${data.aggregate.counts.created} 条；状态列为当前状态。`,{exact:true})).toBeVisible();
   await expect(details.locator(".statistics-item-link").first()).toBeVisible();
   await details.locator(".statistics-item-link").first().click();
   await expect(page.locator(".detail-toolbar")).toBeVisible();await page.goBack();
   await expect(page.getByRole("heading",{name:"产品统计",exact:true})).toBeVisible();
   await expect(page.getByRole("combobox",{name:"产品范围",exact:true})).toHaveValue(fixture.productId);
   await expect(page.getByRole("combobox",{name:"统计时间",exact:true})).toHaveValue("today");
   await expect(page).toHaveURL(/statsDay=/);
  });
 });
}
test("statistics entry, paging, empty filters and date validation",async({page,request})=>{
 const created=await request.post("/api/v1/products",{data:{name:"Report pagination",keyPrefix:"RPT"}});expect(created.status()).toBe(201);const product=await created.json();
 for(let i=0;i<26;i++){const item=await request.post("/api/v1/items",{data:{productId:product.id,title:`Report task ${i}`,description:"Task for report paging",type:"task",priority:"normal",status:"inbox",environment:{platform:"web"}}});expect(item.status()).toBe(201);}
 await page.goto(`/?product=${product.id}`);await page.getByRole("button",{name:"统计",exact:true}).click();
 await expect(page.getByRole("heading",{name:"产品统计",exact:true})).toBeVisible();
 await page.getByRole("combobox",{name:"产品范围",exact:true}).selectOption(product.id);await page.getByRole("combobox",{name:"条目类型",exact:true}).selectOption("task");await page.getByRole("button",{name:"应用筛选",exact:true}).click();
 await page.locator(".statistics-metric").filter({has:page.getByRole("heading",{name:"新增条目",exact:true})}).getByRole("button").click();
 const details=page.getByRole("region",{name:"条目明细",exact:true});await expect(details.locator(".statistics-item-link")).toHaveCount(25);
 await details.getByRole("button",{name:"下一页",exact:true}).click();await expect(details.locator(".statistics-item-link")).toHaveCount(1);
 await details.locator(".statistics-item-link").click();await expect(page.locator(".detail-toolbar")).toBeVisible();await page.goBack();await expect(page.getByRole("region",{name:"条目明细",exact:true}).locator(".statistics-item-link")).toHaveCount(1);await expect(page).toHaveURL(/statsOffset=25/);
 await page.getByRole("combobox",{name:"条目类型",exact:true}).selectOption("idea");await page.getByRole("button",{name:"应用筛选",exact:true}).click();await page.locator(".statistics-metric").filter({has:page.getByRole("heading",{name:"新增条目",exact:true})}).getByRole("button").click();await expect(page.getByText("此筛选下没有条目。",{exact:true})).toBeVisible();
 await page.getByRole("combobox",{name:"统计时间",exact:true}).selectOption("custom");await page.getByLabel("开始日期",{exact:true}).fill("2026-10-10");await page.getByLabel("结束日期",{exact:true}).fill("2026-10-09");await page.getByRole("button",{name:"应用筛选",exact:true}).click();await expect(page.getByRole("alert")).toContainText("请选择有效日期");
 await page.getByRole("button",{name:"返回工作区",exact:true}).click();await expect(page.getByRole("heading",{name:"产品统计",exact:true})).toHaveCount(0);
});
test("revoked scope or failed fetch hides old report data and supports retry",async({page})=>{
 await page.goto(`/?statistics=1&statsProject=${fixture.productId}&statsPeriod=today`);await expect(page.locator(".statistics-metrics")).toBeVisible();
 await page.route("**/api/v1/project-insights?**",route=>route.fulfill({status:404,contentType:"application/json",body:JSON.stringify({code:"not_found",title:"Product not found."})}));
 await page.getByRole("button",{name:"刷新",exact:true}).click();await expect(page.getByRole("alert")).toContainText("无法读取统计");await expect(page.locator(".statistics-metrics")).toHaveCount(0);
 await page.unroute("**/api/v1/project-insights?**");await page.getByRole("button",{name:"重试",exact:true}).click();await expect(page.locator(".statistics-metrics")).toBeVisible();
});

test.describe("mobile statistics navigation",()=>{
 test.use({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
 test("replaces the drawer history entry and returns directly to the workspace",async({page})=>{
  await page.goto(`/?product=${fixture.productId}`);
  await page.getByRole("button",{name:"打开导航",exact:true}).click();
  await page.getByRole("button",{name:"统计",exact:true}).click();
  await expect(page.locator(".statistics-metrics")).toBeVisible();
  await page.getByRole("button",{name:"返回工作区",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  await expect(page).not.toHaveURL(/statistics=/);
  await page.goForward();await expect(page.locator(".statistics-metrics")).toBeVisible();
 });
});
