import { postItemCommand } from "./item-command";
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function createItem(request: APIRequestContext) {
  const product = await (await request.post("/api/v1/products",{data:{name:"Delivery reconciliation",keyPrefix:`DR${randomBytes(3).toString("hex").toUpperCase()}`}})).json();
  const response=await request.post("/api/v1/items",{data:{productId:product.id,title:"核对交付进度",description:"Keep planning and verified delivery distinct",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}}});
  expect(response.status()).toBe(201);
  return {product,item:await response.json()};
}

for (const width of [375,1440]) {
  test(`a newer dispatch takes precedence over an owned historical conversation at ${width}px`,async({page,request})=>{
    const {product,item}=await createItem(request);
    const old={dispatchId:"old-dispatch",itemKey:item.key,itemStatus:"ready",nodeName:"Old Mac",agentKind:"codex",status:"launched",createdAt:"2026-10-31T01:00:00Z"};
    const current={...old,dispatchId:"new-dispatch",nodeName:"Current Mac",createdAt:"2026-10-31T02:00:00Z",claimed:false};
    await page.route("**/api/v1/dispatches/active",route=>route.fulfill({json:{active:[current],latest:[old],current:[old],handlers:[]}}));
    await page.route(`**/api/v1/items/${item.key}/dispatches`,route=>route.fulfill({json:{dispatches:[{...old,id:old.dispatchId,agentSessionId:"private-old-session",itemKeys:[item.key]}],current:old}}));
    await page.setViewportSize({width,height:900}); await page.goto(`/?product=${product.id}&status=ready`);
    const row=page.locator(".item-row").filter({hasText:item.key});
    await expect(row).toContainText("Codex · Current Mac");
    await row.locator(".item-row-main").click();
    const header=page.locator(".detail-dispatch-line");
    await expect(header).toContainText("Codex · Current Mac");
    await expect(header).not.toContainText("Old Mac");
    await expect(header.getByRole("button",{name:"在控制台查看",exact:true})).toHaveCount(0);
  });

  test(`waiting for an answer does not look like a claimed item at ${width}px`,async({page,request},info)=>{
    const {product,item}=await createItem(request);
    await page.setViewportSize({width,height:900}); await page.emulateMedia({colorScheme:width===375 ? "dark" : "light"});
    const current={dispatchId:"waiting-dispatch",itemKey:item.key,itemStatus:"ready",nodeName:"Example Mac",agentKind:"codex",status:"launched",sessionStatus:"active",waitingForInput:true,claimed:false,createdAt:new Date().toISOString()};
    await page.route("**/api/v1/dispatches/active",route=>route.fulfill({json:{active:[current],latest:[current],current:[current],handlers:[]}}));
    await page.goto(`/?product=${product.id}&status=ready`);
    const row=page.locator(".item-row").filter({hasText:item.key});
    await expect(row).toContainText("等待回答 · 条目尚未领取");
    await row.locator(".item-row-main").click();
    await expect(page.locator(".detail-toolbar .status-pill")).toHaveText("待处理");
    await expect(page.locator(".detail-dispatch-line")).toContainText("等待回答 · 条目尚未领取");
    expect(await page.locator(".detail-scroll").evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:info.outputPath(`waiting-${width}.png`)});
  });

  test(`a returned card keeps the human decision after checks are retired at ${width}px`,async({page,request},info)=>{
    const {product,item}=await createItem(request);
    expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"in_progress",reason:"claim"}})).ok()).toBe(true);
    expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to:"ready",reason:"released",note:"Adjust planning"}})).ok()).toBe(true);
    await page.clock.install();
    await page.setViewportSize({width,height:900}); await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
    await expect(page.locator(".detail-toolbar .status-pill")).toHaveText("待处理");
    const late=await request.post(`/api/v1/items/${item.key}/handovers/old/confirm`,{data:{stage:"integration",commit:"a".repeat(40),note:"Old check result"}});
    expect(late.status()).toBe(410);
    await page.clock.fastForward(15_100);
    await page.getByRole("button",{name:"刷新",exact:true}).last().click();
    await expect(page.locator(".detail-toolbar .status-pill")).toHaveText("待处理");
    await expect(page.locator(".detail-scroll")).not.toContainText("等待合并核验");
    await expect(page.locator(".detail-scroll")).not.toContainText("等待发布核验");
    await page.locator(".detail-toolbar .detail-more-menu > summary").click();
    await expect(page.getByRole("button",{name:"状态检查",exact:true})).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({path:info.outputPath(`returned-${width}.png`)});
  });

  test(`started dispatches cannot offer an ineffective override at ${width}px`,async({page,request},info)=>{
    const {product,item}=await createItem(request);
    const stamp=new Date().toISOString();
    const node={id:"fixture-node",name:"Example Mac",deviceName:"Example Mac",online:true,agents:[{kind:"codex", planApprovalProtocol: 1,ready:true,models:[]},{kind:"claude_code", planApprovalProtocol: 1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:"fixture-repository"}],repoCandidates:[],createdAt:stamp};
    await page.route("**/api/v1/nodes",route=>route.fulfill({json:{nodes:[node]}}));
    await page.route("**/api/v1/dispatch-defaults",route=>route.fulfill({json:{nodeId:node.id,agentKind:"codex",agents:{codex:{mode:"default"}}}}));
    await page.route("**/api/v1/dispatches/check",route=>route.fulfill({json:{allowed:false,requiresConfirmation:false,reason:"started",conflicts:[{dispatchId:"old",itemKey:item.key,nodeName:node.name,agentKind:"codex",status:"launched",createdAt:stamp,agentSessionId:"owned-session"}]}}));
    await page.setViewportSize({width,height:900}); await page.goto(`/?product=${product.id}&status=ready`);
    await page.locator(".item-row").filter({hasText:item.key}).getByRole("checkbox").check();
    await page.getByRole("button",{name:"派单",exact:true}).click();
    const form=page.locator(".dispatch-form");
    await expect(form).toContainText("旧派单已送达节点");
    await expect(form.locator(".dispatch-conflict input[type=checkbox]")).toHaveCount(0);
    await expect(form.getByRole("button",{name:"派单",exact:true})).toBeDisabled();
    await expect(form.getByRole("link",{name:"在控制台查看",exact:true})).toHaveAttribute("href",/owned-session/);
    expect(await form.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:info.outputPath(`redispatch-${width}.png`)});
  });
}
