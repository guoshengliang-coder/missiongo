import {expect,test} from "@playwright/test";

for (const width of [375,1440]) for (const theme of ["light","dark"] as const) {
 test(`release artifact inventory is read only ${width}px ${theme}`, async({page,request}) => {
  const created = await request.post("/api/v1/products",{data:{name:"Artifact inventory",keyPrefix:`AI${width}${theme[0]!.toUpperCase()}`}});
  expect(created.status()).toBe(201);
  const product = await created.json() as {id:string};
  await page.setViewportSize({width,height:900});
  await page.emulateMedia({colorScheme:theme});
  await page.goto(`/settings/products/${product.id}/artifacts?product=${product.id}`);
  const section = page.locator(".release-artifacts-settings");
  await expect(section.getByText("暂无产物记录，无需在这里配置。",{exact:true})).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({path:test.info().outputPath("artifacts-empty.png")});
  const item = await (await request.post("/api/v1/items",{data:{productId:product.id,title:"Gateway publication",description:"Release scope discovered from the repository",type:"task",priority:"normal",status:"ready",environment:{platform:"other"}}})).json() as {key:string};
  await request.post(`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}});
  const registered = await request.put(`/api/v1/items/${item.key}/handover`,{data:{completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},requiredArtifacts:["gateway"]}});
  expect(registered.ok()).toBe(true);
  await page.reload();
  await expect(section.locator("code")).toHaveText(["gateway"]);
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByText("暂无产物记录，无需在这里配置。",{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("artifacts-recorded.png")});
 });
}
