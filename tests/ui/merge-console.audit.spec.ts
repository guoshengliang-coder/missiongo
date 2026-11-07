import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`merge selection and uncertain retry at ${width}px ${theme}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({width,height:900});
    await page.emulateMedia({colorScheme:theme});
    const product=await (await request.post("/api/v1/products",{data:{name:`Merge ${width} ${theme}`,keyPrefix:`MG${width}${theme[0]!.toUpperCase()}`}})).json();
    const now=new Date().toISOString();
    const delivery={id:"delivery-one",productId:product.id,sessionId:"development-session",revision:"revision-one",state:"confirmed",blocker:width===320?"pending":"stale",
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
    expect(bodies[0]).toMatchObject({selection:[{id:delivery.id,revision:delivery.revision}],publish:false,integrationProtocol:1,nodeId:"merge-node",agentKind:"codex",mode:"auto"});
  });
}

for (const width of [320,1440]) for (const theme of ["light","dark"] as const) for (const surface of ["console","panel"] as const) test(`delivery confirmation and withdrawal share the ${surface} card ${width} ${theme}`,async({page,request},testInfo)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const product=await(await request.post("/api/v1/products",{data:{name:`Delivery ${surface}`,keyPrefix:`D${surface[0]!.toUpperCase()}${width}${theme[0]!.toUpperCase()}`}})).json();
  const item=await(await request.post("/api/v1/items",{data:{productId:product.id,type:"task",priority:"normal",status:"ready",title:"Delivery fixture",description:"Synthetic",environment:{platform:"web"}}})).json();
  const id="delivery-session",stamp=new Date().toISOString();let state="proposed",decisions=0,blocker:string|undefined;
  const summary={id,agentSessionId:id,dispatchId:"delivery-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
    nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
    canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"none"},needsAttention:false,items:[{key:item.key,title:item.title,productId:product.id}]};
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,messages:[]}}));
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"auto",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[item.key]}]}}));
  await page.route("**/merge-deliveries",route=>route.fulfill({json:{deliveries:state==="withdrawn"?[]:[{id:"offer",productId:product.id,sessionId:id,revision:"frozen",state,blocker,
    summary:"Verified delivery",validation:"Regression passed",itemKeys:[item.key],head:"a".repeat(40),requiredArtifacts:["web"],pullRequestUrl:"https://github.com/example/project/pull/12",evidence:{checkedAt:stamp,source:"Fixture"}}],batches:state==="batched"?[{id:"batch",state:"active",sessionId:"merge-session",deliveries:["offer"],results:{},publish:false}]:[]}}));
  await page.route("**/merge-deliveries/offer/decision",route=>{const input=route.request().postDataJSON();expect(input.revision).toBe("frozen");state=input.decision==="confirm"?"confirmed":"withdrawn";decisions++;return route.fulfill({json:{state}});});
  if(surface==="console")await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
  else {await page.goto(`/?product=${product.id}&item=${item.key}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"Fixture"}).click();await page.locator(".agent-session-toggle").click();}
  const card=page.locator(".merge-delivery-card");await expect(card).toBeVisible();
  const draft=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");await draft.fill("Keep this unsent draft");
  const badge=page.locator(surface==="console"?".agent-console-session [data-merge-progress]":".item-row [data-merge-progress]");
  await expect(badge).toHaveCount(0);
  await card.getByRole("button",{name:"确认完成，等待合并",exact:true}).click();await expect(card).toContainText("本轮已确认");
  await expect(badge).toHaveText("待合并");
  for(const scale of ["small","medium","large"]) {
    await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.screenshot({path:testInfo.outputPath("confirmed-label.png"),fullPage:true});
  await expect(draft).toHaveValue("Keep this unsent draft");
  await card.getByRole("button",{name:"继续调整",exact:true}).click();await expect(card).toHaveCount(0);expect(decisions).toBe(2);await expect(badge).toHaveCount(0);
  state="confirmed";
  const listUrl=`/?product=${product.id}${surface==="console"?"&console=agent":""}`;
  await page.goto(listUrl);await expect(badge).toBeVisible();await expect(badge).toHaveText("待合并");
  await page.screenshot({path:testInfo.outputPath("list-label.png"),fullPage:true});
  state="batched";await page.reload();await expect(badge).toHaveText("合并中");
  state="merged";await page.reload();await expect(badge).toHaveCount(0);
  state="confirmed";blocker="changed";await page.reload();await expect(badge).toHaveCount(0);
  if(surface==="console") {
    await page.getByRole("button",{name:"待合并 0",exact:true}).click();
    await expect(page.getByRole("dialog").locator(".merge-row input")).toBeDisabled();
  }
  const current=await(await request.get(`/api/v1/items/${item.key}`)).json();expect(current.status??current.item?.status).toBe("ready");
});

for(const width of [320,1440]) for(const theme of ["light","dark"] as const) test(`integration plan and recovery ${width} ${theme}`,async({page,request},testInfo)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const product=await(await request.post("/api/v1/products",{data:{name:"Integration",keyPrefix:`IP${width}${theme[0]!.toUpperCase()}`}})).json();
  const id="integration-session",at=new Date().toISOString();
  const session={id,agentSessionId:id,dispatchId:"integration-dispatch",productId:product.id,agentKind:"codex",status:"idle",updatedAt:at,createdAt:at,
    nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
    canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"none"},needsAttention:false,items:[]};
  const entry=(key:string,progress:string)=>({itemKeys:[key],originalHead:"a".repeat(40),head:"b".repeat(40),progress,detail:"根据已确认需求核实接口兼容与回归，不扩大功能范围",repairs:[]});
  const batch={id:"integration",sessionId:id,state:"active",deliveries:["a","b","c"],publish:true,results:{a:{status:"merged",detail:"基础改动已合并"},c:{status:"blocked",detail:"外部提交需要核对"}},
    integration:{protocol:1,revision:7,plans:[{base:"c".repeat(40),summary:"先合基础接口，再核实依赖功能；独立改动单独处理",validation:"最终主线组合行为与仓库检查",at,
      entries:["a","b","c"].map((deliveryId,i)=>({deliveryId,head:"b".repeat(40),dependsOn:i===1?["a"]:[],group:i<2?"接口兼容":"独立变更",reason:"读取相互影响后确定顺序",validation:"保留已有行为并验证新增功能"}))}],
      entries:{a:entry("IP-1","ready"),b:{...entry("IP-2","waiting_ci"),repairs:[{id:"repair",fromHead:"a".repeat(40),head:"b".repeat(40),base:"c".repeat(40),reason:"修复重复渲染",commits:["b".repeat(40)],validation:"回归测试已通过，远程 CI 排队中",source:"Fixture",at}]},c:entry("IP-3","investigating")},events:[{id:"event",digest:"digest",action:"plan",at,detail:"整批计划已保存，断线恢复沿用原批次"}]}};
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session]}:{...session,messages:[{id:"native-latest",sourceId:"native-latest",role:"agent",text:"原生会话的最新回复",occurredAt:at}]}}));
  await page.route("**/merge-deliveries",route=>route.fulfill({json:{deliveries:[],batches:[batch]}}));
  await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
  const draft=page.locator(".agent-console-reply textarea");await draft.fill("保留此草稿");
  const progress=page.getByRole("region",{name:"集成进度"});
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".agent-console-messages .integration-progress")).toHaveCount(0);
  await expect(page.locator(".agent-console-message").last()).toContainText("原生会话的最新回复");
  await page.getByRole("button",{name:"集成详情",exact:true}).click();await expect(progress).toBeVisible();
  await expect(progress).toContainText("先合基础接口");await expect(progress).toContainText("等待 CI");await expect(progress).toContainText("发布等待你决定");
  await progress.locator("li").filter({hasText:"IP-2"}).getByText("查看修复与验证详情",{exact:true}).click();
  await expect(progress).toContainText("修复重复渲染");
  for(const scale of ["small","medium","large"]) {
    await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{fontSize:number;contrast:number;fontWeight:number}>};
    expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
    expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||(r.fontWeight>=700&&r.fontSize>=18.66)?3:4.5))).toEqual([]);
  }
  await expect(draft).toHaveValue("保留此草稿");await page.screenshot({path:testInfo.outputPath("integration-progress.png"),fullPage:true});
  await page.keyboard.press("Escape");await expect(progress).toHaveCount(0);await expect(draft).toHaveValue("保留此草稿");
  batch.state="finished";
  await page.reload();await expect(progress).toHaveCount(0);await page.getByRole("button",{name:"集成详情",exact:true}).click();await expect(progress).toContainText("先合基础接口");await expect(progress).toContainText("IP-2");
});

for(const width of [320,375,1440]) for(const theme of ["light","dark"] as const) test(`reconciliation approval and reload ${width} ${theme}`,async({page,request},testInfo)=>{
  await page.setViewportSize({width,height:width===375?812:900});await page.emulateMedia({colorScheme:theme});
  const product=await(await request.post("/api/v1/products",{data:{name:"Recovery",keyPrefix:`RC${width}${theme[0]!.toUpperCase()}`}})).json();
  const id="recovery-session",at=new Date().toISOString(),snapshot="a".repeat(64);
  const session={id,agentSessionId:id,dispatchId:"recovery-dispatch",productId:product.id,agentKind:"codex",status:"idle",updatedAt:at,createdAt:at,
    nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
    canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"none"},needsAttention:false,items:[]};
  const batch={id:"recovery-batch",sessionId:id,state:"active",deliveries:["delivery"],publish:true,results:{}};
  let decision:string|undefined,reads=0;
  const row={id:"recovery-request",snapshot,digest:"digest",at,action:{kind:"accept_merge",deliveryId:"delivery",evidence:{head:"b".repeat(40),commit:"c".repeat(40),targetHead:"d".repeat(40),checkedAt:at,source:"https://github.com/example/project/pull/12",validation:"外部合并及真实目标回归已核实",checks:"passed",local:"passed",originalIncluded:true,targetIncludesMerge:true}}};
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session]}:{...session,messages:[]}}));
  await page.route("**/merge-deliveries",route=>route.fulfill({json:{deliveries:[],batches:[batch]}}));
  await page.route("**/merge-batches/recovery-batch/reconciliation",route=>{reads++;return route.fulfill({json:{batchId:batch.id,state:"active",publish:true,snapshot,sessionId:id,
    entries:[{deliveryId:"delivery",itemKeys:["RC-1","RC-2"],originalHead:"a".repeat(40),executionHead:"a".repeat(40),repository:"https://github.com/example/project",pullRequest:12,targetBranch:"main",requiredArtifacts:["web"],
      items:[{itemKey:"RC-1",status:"development_complete",revision:4,missingEvidence:true,next:"补齐交付证据并核实必需产物发布"},{itemKey:"RC-2",status:"on_hold",revision:5,missingEvidence:false,blocker:"条目已暂缓；保留人工状态。",next:"等待人工决定"}]}],
    reconciliation:{requests:[{...row,...(decision?{decision}:{})}],history:[],handoffs:{}}}});});
  await page.route("**/merge-batches/recovery-batch/reconciliation/recovery-request/decision",route=>{
    expect(route.request().postDataJSON()).toEqual({snapshot,decision:"approved",noExecutionRemaining:true});decision="approved";
    // The server accepted the decision but the response was lost.
    return route.fulfill({status:503,json:{title:"Synthetic lost response"}});
  });
  await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
  const draft=page.locator(".agent-console-reply textarea");await draft.fill("保留恢复审阅草稿");
  await page.getByRole("button",{name:"集成详情",exact:true}).click();
  await expect(page.getByText("查看对账与恢复",{exact:true})).toBeVisible();expect(reads).toBe(0);
  await page.getByText("查看对账与恢复",{exact:true}).click();
  const region=page.getByRole("region",{name:"批次对账"});await expect(region).toContainText("条目已暂缓");
  await expect(region).toContainText("交付证据尚不完整");
  await expect(region.getByRole("button",{name:"批准本次恢复"})).toBeDisabled();
  for(const scale of ["small","medium","large"]) {
    await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{fontSize:number;contrast:number;fontWeight:number}>};
    expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
    expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||(r.fontWeight>=700&&r.fontSize>=18.66)?3:4.5))).toEqual([]);
  }
  await region.getByRole("button",{name:"批准本次恢复"}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath(`reconciliation-${width}-${theme}.png`),fullPage:true});
  await region.getByRole("checkbox").check();await region.getByRole("button",{name:"批准本次恢复"}).click();
  await expect(region).toContainText("已批准，请原批次会话继续");await expect(draft).toHaveValue("保留恢复审阅草稿");
  await page.reload();await page.getByRole("button",{name:"集成详情",exact:true}).click();await page.getByText("查看对账与恢复",{exact:true}).click();await expect(region).toContainText("已批准，请原批次会话继续");
  await expect(region.getByRole("button",{name:"批准本次恢复"})).toHaveCount(0);
});
