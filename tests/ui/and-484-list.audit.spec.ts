import sharp from "sharp";
import { expect, test } from "@playwright/test";

for(const [width,theme,scale] of [[320,"light","small"],[320,"dark","large"],[1440,"light","small"],[1440,"dark","large"],[320,"light","medium"],[1440,"dark","medium"]] as const)
  test(`AND-484 list rows preserve detail actions ${width} ${theme} ${scale}`,async({page,request},info)=>{
    await page.clock.setFixedTime(new Date("2026-11-09T02:00:00Z"));
    await page.setViewportSize({width,height:900});
    const product=await(await request.post("/api/v1/products",{data:{name:"Lightweight list",keyPrefix:`LP${width}${scale[0]!.toUpperCase()}`}})).json();
    const item=await(await request.post("/api/v1/items",{data:{productId:product.id,type:"bug",priority:"high",status:"ready",title:"Lightweight row preserves details",
      description:"Full description remains editable",report:{overview:"Visible overview",reproductionSteps:"Full reproduction must load in editor"},environment:{platform:"web"}}})).json();
    const uploaded=await request.post(`/api/v1/items/${item.key}/attachments`,{headers:{"content-type":"application/octet-stream","x-missiongo-content-type":"image/png","x-missiongo-filename":"preview.png"},data:await sharp({create:{width:32,height:32,channels:3,background:"#3484c9"}}).png().toBuffer()});
    expect(uploaded.ok(),await uploaded.text()).toBe(true);
    let detailReads=0;
    await page.route(`**/api/v1/items/${item.key}`,route=>{detailReads++;return route.continue();});
    await page.goto(`/?product=${product.id}&status=ready&appearance=${theme}`);
    await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
    const row=page.locator(".item-row").filter({hasText:item.title});
    await expect(row).toContainText("Visible overview");
    await expect(row.locator("img")).toBeVisible();expect(detailReads).toBe(0);
    await row.locator(".row-more-menu > summary").click();
    await expect(row.getByRole("button",{name:"编辑",exact:true})).toBeVisible();expect(detailReads).toBeGreaterThan(0);
    await row.getByRole("button",{name:"编辑",exact:true}).click();
    const editor=page.getByRole("dialog").filter({hasText:`编辑 ${item.key}`});
    await expect(editor).toBeVisible();
    await expect(editor.locator("textarea").filter({visible:true}).first()).toHaveValue("Visible overview");
    await expect(editor.locator("textarea").nth(1)).toHaveValue("Full reproduction must load in editor");
    await page.screenshot({path:info.outputPath("list-detail-editor.png")});
    await editor.getByRole("button",{name:"取消",exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
