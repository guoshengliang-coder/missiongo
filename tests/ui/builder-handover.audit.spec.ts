import { test, expect } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const viewport of [{name:"desktop",width:1440,height:900},{name:"phone",width:375,height:812}]) for (const theme of ["light","dark"] as const) {
  test.describe(`${viewport.name} ${theme}`,()=>{
    test.use({viewport:{width:viewport.width,height:viewport.height},hasTouch:viewport.name === "phone",isMobile:viewport.name === "phone",colorScheme:theme});
  test(`Builder handover progress and explicit recovery`,async({page,request})=>{
    const suffix=Date.now().toString(36)+viewport.name+theme;
    const product=await (await request.post("/api/v1/products",{data:{name:`Handover ${suffix}`,keyPrefix:`HO${viewport.name[0]!.toUpperCase()}${theme[0]!.toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`}})).json();
    const item=await (await request.post("/api/v1/items",{data:{productId:product.id,status:"ready",type:"task",priority:"normal",title:"First pickup and handover",description:"Check explicit recovery",environment:{platform:"web"}}})).json();
    expect(item.builderAccountId).toBeUndefined();
    const started=await request.post(`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}});
    expect(started.ok()).toBe(true);
    const stored=await started.json();
    const realDelivery=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
    expect(stored.builderAccountId).toBe(realDelivery.currentAccountId);
    let status:"stopping"|"blocked"|"completed"="blocked";
    let retries=0;
    await page.route(`**/api/v1/items/${item.key}/delivery`,async route=>route.fulfill({json:{...realDelivery,
      canManageBuilder:true,canTakeOver:status === "completed",builderHandover:{id:"ui-handover",status,
        reason:status === "blocked" ? "旧执行节点离线，节点恢复后请手动重试。" : "",targetAccountId:realDelivery.currentAccountId,canTakeOver:status === "completed"}}}));
    await page.route(`**/api/v1/items/${item.key}/builder-handover/ui-handover/retry`,async route=>{
      retries++;status="stopping";await route.fulfill({json:stored});
    });
    await page.goto(`/?product=${product.id}&status=in_progress&item=${item.key}`);
    const notice=page.getByRole("status").filter({has:page.getByText("交接受阻",{exact:true})});
    await expect(notice).toContainText("旧执行节点离线");
    await expect(page.getByRole("button",{name:"选择机器和 Agent 接手",exact:true})).toHaveCount(0);
    const retryButton=page.getByRole("button",{name:"重试交接",exact:true});
    expect((await retryButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await retryButton.click();
    await expect(page.getByRole("status").filter({has:page.getByText("交接中",{exact:true})})).toContainText("等待旧执行停止确认");
    expect(retries).toBe(1);
    status="completed";await page.reload();
    const completed=page.getByRole("status").filter({has:page.getByText("交接完成",{exact:true})});
    await expect(completed).toContainText("条目状态和历史成果已保留");
    await expect(page.getByRole("button",{name:"重试交接",exact:true})).toHaveCount(0);
    await completed.screenshot({path:test.info().outputPath("handover-completed.png")});
    await page.screenshot({path:test.info().outputPath(`${viewport.name}-${theme}.png`)});
    const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{sample:string;fontSize:number;contrast:number}>};
    const noticeText=audit.text.filter(row=>/^(交接完成|Builder 已转交|选择机器和 Agent 接手)/.test(row.sample));
    expect(noticeText.length).toBeGreaterThanOrEqual(3);
    expect(noticeText.filter(row=>row.fontSize<11 || row.contrast<4.5)).toEqual([]);
    expect((await page.getByRole("button",{name:"选择机器和 Agent 接手",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.getByRole("button",{name:"选择机器和 Agent 接手",exact:true}).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(retries).toBe(1);
  });
  });
}
