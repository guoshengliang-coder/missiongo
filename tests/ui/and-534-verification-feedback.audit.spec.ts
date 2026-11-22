import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { postItemCommand } from "./item-command";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
const explanation="验收未完成：存在尚未完整发布的新增交付。请核对本条目的交付版本和发布记录，完成发布交接后再验收。";
for(const width of [320,1440])for(const source of ["list","detail"] as const)test(`AND-534 ${source} at ${width}: failure persists without a success icon, then an explicit retry succeeds`,async({page,request},info)=>{
  await page.clock.setFixedTime(new Date("2026-11-22T12:00:00Z"));
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:width===320?"dark":"light"});
  const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"验收反馈",description:"Isolated UI fixture",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});expect(created.ok()).toBe(true);
  const item=await created.json();
  expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
  let fail=true,writes=0;
  await page.route(`**/api/v1/items/${item.key}/transitions`,route=>{
    writes++;
    return fail?route.fulfill({status:409,json:{code:"verification_delivery_unpublished",title:"存在新增交付尚未完整发布，请核对待验版本后再验收。"}}):route.continue();
  });
  await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}${source==="detail"?`&item=${item.key}`:""}`);
  const action=async()=>{
    if(source==="list") {
      const menu=page.locator(".item-row .row-more-menu");await menu.locator(":scope > summary").click();
      await menu.getByRole("button",{name:"验证通过",exact:true}).click();
    } else await page.locator(".detail-toolbar").getByRole("button",{name:"验证通过",exact:true}).click();
  };
  if(width===320)await page.evaluate(()=>{document.documentElement.dataset.fontScale="large";});
  await action();
  const notice=page.locator(".toast-error");await expect(notice).toHaveAttribute("role","alert");await expect(notice).toContainText(explanation);
  await expect(notice.locator(".lucide-check")).toHaveCount(0);
  await expect(page.locator(".inline-error").filter({hasText:explanation})).toBeVisible();
  // Allow the old 4-second success-notice timeout to expire; this failure must remain.
  await page.waitForTimeout(4200);await expect(notice).toBeVisible();expect(writes).toBe(1);
  expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("pending_verification");
  expect(await notice.evaluate(el=>el.getBoundingClientRect().right<=innerWidth&&el.getBoundingClientRect().left>=0)).toBe(true);
  if(source==="list") {
    const row=page.locator(".item-row");
    await expect(row.locator(".item-row-main")).toContainText("验收反馈");
    const boxes=await row.evaluate(el=>({main:el.querySelector(".item-row-main")!.getBoundingClientRect().bottom,error:el.querySelector(".item-transition-error")!.getBoundingClientRect().top}));
    expect(boxes.error).toBeGreaterThanOrEqual(boxes.main);
  }
  await page.screenshot({path:info.outputPath(`failure-${source}-${width}.png`)});
  await notice.getByRole("button",{name:"关闭提示",exact:true}).click();await expect(notice).toHaveCount(0);
  await expect(page.locator(".inline-error").filter({hasText:explanation})).toBeVisible();
  fail=false;await action();await expect(page.locator(".toast[role=status]")).toContainText("已完成");
  await expect(page.locator(".toast .lucide-check")).toHaveCount(1);
  await expect(page.locator(".inline-error").filter({hasText:explanation})).toHaveCount(0);expect(writes).toBe(2);
});

test("AND-534 bulk verification retains per-item reasons and never reports a failed batch as success",async({page,request})=>{
  await page.clock.setFixedTime(new Date("2026-11-22T12:00:00Z"));
  await page.setViewportSize({width:320,height:375});
  const items=[];
  for(let i=0;i<10;i++) {
    const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:`批量反馈 ${i}`,description:"Synthetic batch",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});
    const item=await created.json();items.push(item);
    expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
  }
  await page.route("**/api/v1/items/transitions",route=>route.fulfill({json:{results:items.map(item=>({itemKey:item.key,ok:false,code:"verification_delivery_unpublished",message:"Unpublished new delivery"}))}}));
  await page.goto(`/?product=${fixture.productId}&status=all&q=${encodeURIComponent("批量反馈")}`);
  await page.evaluate(()=>{document.documentElement.dataset.fontScale="large";});
  for(const item of items)await page.locator(".item-row").filter({hasText:item.key}).locator(".item-select").check();
  await page.getByRole("button",{name:"验证通过（10）",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.getByRole("button",{name:"验证通过（10）",exact:true}).click();await expect(dialog).toHaveCount(0);
  const notice=page.locator(".toast-error");await expect(notice).toContainText(explanation);
  for(const item of items){await expect(notice).toContainText(item.key);await expect(page.locator(".item-row").filter({hasText:item.key}).locator(".item-select")).toBeChecked();}
  await expect(notice.locator(".lucide-check")).toHaveCount(0);
  const close=notice.getByRole("button",{name:"关闭提示",exact:true});
  const rect=await close.boundingBox();expect(rect).not.toBeNull();expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.y+rect!.height).toBeLessThanOrEqual(375);
  const content=notice.locator("span");await content.focus();await page.keyboard.press("End");
  await expect.poll(()=>content.evaluate(el=>el.scrollHeight>el.clientHeight&&el.scrollTop>0)).toBe(true);
  await close.click();await expect(notice).toHaveCount(0);
});

test("AND-534 a late failure stays bound to the submitted item after switching detail",async({page,request})=>{
  await page.clock.setFixedTime(new Date("2026-11-22T12:00:00Z"));
  const items=[];
  for(let i=0;i<2;i++) {
    const created=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:`迟到反馈 ${i}`,description:"Synthetic delayed response",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});
    const item=await created.json();items.push(item);
    expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
  }
  const [first,second]=items;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let submitted=false;
  await page.route(`**/api/v1/items/${first.key}/transitions`,async route=>{submitted=true;await gate;await route.fulfill({status:409,json:{code:"verification_delivery_unpublished",title:"Unpublished"}});});
  await page.goto(`/?product=${fixture.productId}&status=all&q=${encodeURIComponent("迟到反馈")}&item=${first.key}`);
  await page.locator(".detail-toolbar").getByRole("button",{name:"验证通过",exact:true}).click();await expect.poll(()=>submitted).toBe(true);
  await page.locator(".item-row").filter({hasText:second.key}).locator(".item-row-main").click();
  await expect(page.locator(".detail-toolbar > code")).toHaveText(second.key);release();
  const notice=page.locator(".toast-error");await expect(notice).toContainText(first.key);await expect(notice).not.toContainText(second.key);
  await expect(page.locator(".detail-pane .inline-error").filter({hasText:explanation})).toHaveCount(0);
  expect((await (await request.get(`/api/v1/items/${first.key}`)).json()).status).toBe("pending_verification");
});
