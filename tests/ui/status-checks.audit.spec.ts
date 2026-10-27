import {readFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for (const width of [375,1440]) for (const theme of ["light","dark"] as const) {
 test(`status check association and offline queue ${width}px ${theme}`,async({page,request})=>{
  const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"Status check fixture",description:"Publication handover",type:"requirement",priority:"normal",status:"ready",environment:{platform:"web"}}});
  expect(created.status()).toBe(201);const item=await created.json() as {key:string};
  const moved=await request.post(`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}});expect(moved.status()).toBe(200);
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
  await page.locator(".detail-toolbar").getByRole("button",{name:"检查状态",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"状态检查",exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.getByText("暂无交接记录。未关联 PR 的条目无法自动推断合并或发布情况。")).toBeVisible();
  await dialog.getByRole("button",{name:"关联 PR / 确认发布范围",exact:true}).click();
  await dialog.getByLabel("PR 地址",{exact:true}).fill("https://github.com/example/project/pull/42");
  await dialog.getByLabel("web",{exact:true}).check();
  await dialog.getByRole("button",{name:"确认并保存关联",exact:true}).click();
  await expect(dialog.getByText("等待核实 PR 合并",{exact:true})).toBeVisible();
  await dialog.getByRole("button",{name:"立即检查并校正",exact:true}).click();
  await expect(dialog.getByText("等待本机节点检查",{exact:true})).toBeVisible();
  await expect(dialog.getByText("已排队，等待关联节点；这不代表已经核实。",{exact:true})).toBeVisible();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`status-${width}-${theme}.png`)});
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
 });
}
test("product check entry shows daily schedule",async({page})=>{
 await page.setViewportSize({width:375,height:812});
 await page.goto(`/?product=${fixture.productId}`);
 const heading=page.locator(".workspace-head h1");
 expect(await heading.evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)+2)).toBe(true);
 await page.getByRole("button",{name:"检查状态",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"状态检查",exact:true});await expect(dialog).toBeVisible();
 await expect(dialog.getByText("每天 09:00 · Asia/Shanghai",{exact:true})).toBeVisible();
});
