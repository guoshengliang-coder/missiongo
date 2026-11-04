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
  // Rendering fixture for inventory recorded by explicit development handoff.
  // The real MCP-to-inventory path is covered in app.test.ts; the retired check
  // registration endpoint must not be used to prepare UI fixtures.
  await page.route(/\/api\/v1\/products(?:\?.*)?$/,async route=>{
   const response=await route.fetch();
   const products=await response.json();
   await route.fulfill({response,json:products.map((entry:{id:string})=>entry.id===product.id ? {...entry,releaseArtifacts:["gateway"]} : entry)});
  });
  await page.reload();
  await expect(section.locator("code")).toHaveText(["gateway"]);
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByText("暂无产物记录，无需在这里配置。",{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("artifacts-recorded.png")});
 });
}
