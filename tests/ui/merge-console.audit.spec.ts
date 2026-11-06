import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`merge selection and uncertain retry at ${width}px ${theme}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({width,height:900});
    await page.emulateMedia({colorScheme:theme});
    const product=await (await request.post("/api/v1/products",{data:{name:`Merge ${width} ${theme}`,keyPrefix:`MG${width}${theme[0]!.toUpperCase()}`}})).json();
    const now=new Date().toISOString();
    const delivery={id:"delivery-one",productId:product.id,sessionId:"development-session",revision:"revision-one",state:"confirmed",
      itemKeys:["MG-1"],head:"a".repeat(40),summary:"会话交付确认与待合并清单",validation:"服务端回归测试通过",requiredArtifacts:["web"],
      pullRequestUrl:"https://github.com/example/project/pull/12",evidence:{checkedAt:now,source:"GitHub"}};
    await page.route("**/merge-deliveries",route=>route.fulfill({json:{deliveries:[delivery],batches:[]}}));
    await page.route("**/api/v1/nodes",route=>route.fulfill({json:{nodes:[{id:"merge-node",name:"Fixture Mac",online:true,supportsFreeSessions:true,
      agents:[{kind:"codex",planApprovalProtocol:1,ready:true,models:[]}],repos:[{productId:product.id,repoPath:"fixture"}],repoCandidates:[],createdAt:now}]}}));
    await page.route("**/api/v1/dispatch-defaults",route=>route.fulfill({json:{nodeId:"merge-node",agentKind:"codex",agents:{codex:{mode:"auto"}}}}));
    const bodies:unknown[]=[];
    await page.route("**/merge-batches",route=>{bodies.push(route.request().postDataJSON());return route.fulfill({status:503,json:{title:"Synthetic lost acknowledgement"}});});
    await page.goto(`/?product=${product.id}&console=agent`);
    const entry=page.getByRole("button",{name:"待合并 1",exact:true});
    const bar=page.locator(".agent-console-topbar");
    const bounds=await bar.boundingBox();
    for(const control of [entry,page.locator(".agent-console-topbar-actions")]) {
      const box=await control.boundingBox();expect(box).not.toBeNull();
      expect(box!.y+box!.height).toBeLessThanOrEqual(bounds!.y+bounds!.height+1);
    }
    await entry.click();
    const dialog=page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button",{name:"开始合并（0 项）"})).toBeDisabled();
    await dialog.locator(".merge-row input").check();
    await expect(dialog.getByRole("checkbox",{name:/合并后发布/})).not.toBeChecked();
    await expect(dialog.getByRole("button",{name:"开始合并（1 项）"})).toBeEnabled();
    for (const scale of ["small","medium","large"]) {
      await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{fontSize:number;contrast:number;fontWeight:number}>};
      expect(audit.text.filter(row=>row.fontSize>0&&row.fontSize<11)).toEqual([]);
      expect(audit.text.filter(row=>row.contrast<(row.fontSize>=24||(row.fontWeight>=700&&row.fontSize>=18.66)?3:4.5))).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("heading",{name:/放弃/})).toBeVisible();
    await dialog.getByRole("button",{name:"继续编辑",exact:true}).click();
    await expect(dialog.locator(".merge-row input")).toBeChecked();
    await page.screenshot({path:testInfo.outputPath(`merge-${width}-${theme}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await dialog.getByRole("button",{name:"开始合并（1 项）"}).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button",{name:"重试原批次"}).click();
    await expect.poll(()=>bodies.length).toBe(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({selection:[{id:delivery.id,revision:delivery.revision}],publish:false,nodeId:"merge-node",agentKind:"codex",mode:"auto"});
  });
}

for (const surface of ["console","panel"] as const) test(`delivery confirmation and withdrawal share the ${surface} card`,async({page,request})=>{
  const product=await(await request.post("/api/v1/products",{data:{name:`Delivery ${surface}`,keyPrefix:surface==="console"?"DC":"DP"}})).json();
  const item=await(await request.post("/api/v1/items",{data:{productId:product.id,type:"task",priority:"normal",status:"ready",title:"Delivery fixture",description:"Synthetic",environment:{platform:"web"}}})).json();
  const id="delivery-session",stamp=new Date().toISOString();let state="proposed",decisions=0;
  const summary={id,agentSessionId:id,dispatchId:"delivery-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
    nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
    canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"none"},needsAttention:false,items:[{key:item.key,title:item.title,productId:product.id}]};
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,messages:[]}}));
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"auto",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[item.key]}]}}));
  await page.route("**/merge-deliveries",route=>route.fulfill({json:{deliveries:state==="withdrawn"?[]:[{id:"offer",productId:product.id,sessionId:id,revision:"frozen",state,
    summary:"Verified delivery",validation:"Regression passed",itemKeys:[item.key],head:"a".repeat(40),requiredArtifacts:["web"],pullRequestUrl:"https://github.com/example/project/pull/12",evidence:{checkedAt:stamp,source:"Fixture"}}],batches:[]}}));
  await page.route("**/merge-deliveries/offer/decision",route=>{const input=route.request().postDataJSON();expect(input.revision).toBe("frozen");state=input.decision==="confirm"?"confirmed":"withdrawn";decisions++;return route.fulfill({json:{state}});});
  if(surface==="console")await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
  else {await page.goto(`/?product=${product.id}&item=${item.key}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  const card=page.locator(".merge-delivery-card");await expect(card).toBeVisible();
  const draft=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await draft.fill("Keep this unsent draft");
  await card.getByRole("button",{name:"确认完成，等待合并",exact:true}).click();await expect(card).toContainText("本轮已确认");
  await expect(draft).toHaveValue("Keep this unsent draft");
  await card.getByRole("button",{name:"继续调整",exact:true}).click();await expect(card).toHaveCount(0);expect(decisions).toBe(2);
  const current=await(await request.get(`/api/v1/items/${item.key}`)).json();expect(current.status??current.item?.status).toBe("ready");
});
