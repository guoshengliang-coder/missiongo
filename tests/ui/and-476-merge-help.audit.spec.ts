import { queueRoute } from "./integration-queue-fixture";
import { expect, test } from "@playwright/test";

test.describe("AND-476 click help and integration defaults",()=>{
  test.use({hasTouch:true});
  for(const width of [320,1440])for(const theme of ["light","dark"] as const)test(`selection, help, preferences and active empty list ${width} ${theme}`,async({page,request},testInfo)=>{
    await page.clock.setFixedTime(new Date("2026-11-08T08:00:00Z"));
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post("/api/v1/products",{data:{name:"AND-476 fixture",keyPrefix:`HP${width}${theme[0]!.toUpperCase()}`}})).json();
    const at="2026-11-08T08:00:00Z";let active=false,empty=false;
    const deliveries=["conflicting","stale","failed","dependency","pending","changed",undefined,"unknown"].map((blocker,i)=>({id:`help-${i}`,productId:product.id,sessionId:`dev-${i}`,revision:`rev-${i}`,state:"confirmed",blocker,
      itemKeys:[`HP-${i+1}`],head:"a".repeat(40),summary:`改动 ${i+1}`,validation:"验证说明",requiredArtifacts:["web"],pullRequestUrl:`https://github.com/example/repo/pull/${i+1}`,evidence:{checkedAt:at,source:"Fixture"}}));
    await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:empty?[]:deliveries,batches:active?[{id:"active",sessionId:"active-session",state:"active",deliveries:[],results:{},publish:false}]:[]}}));
    await page.route("**/api/v1/nodes",route=>queueRoute(route).fulfill({json:{nodes:[{id:"help-node",name:"Fixture Mac",online:true,supportsFreeSessions:true,agents:[{kind:"codex",ready:true,models:[]}],repos:[{productId:product.id,repoPath:"fixture"}],repoCandidates:[],createdAt:at}]}}));
    await page.route("**/api/v1/dispatch-defaults",route=>queueRoute(route).fulfill({json:{nodeId:"help-node",agentKind:"codex",agents:{codex:{mode:"auto"}}}}));
    await page.route("**/api/v1/integration-defaults",route=>queueRoute(route).fulfill({json:{agents:{}}}));
    const bodies:Record<string,unknown>[]=[];
    await page.route("**/merge-batches",route=>{bodies.push(route.request().postDataJSON());return queueRoute(route).fulfill({status:503,json:{title:"Synthetic lost acknowledgement"}});});
    await page.goto(`/?product=${product.id}&console=agent`);
    await page.getByRole("button",{name:"待集成 7",exact:true}).click();
    const dialog=page.getByRole("dialog").first();
    await expect(dialog.locator(".merge-check")).toHaveCount(4);
    for(const index of [1,4,6,7])await expect(dialog.locator(".merge-row").nth(index).locator(".merge-check")).toHaveCount(0);
    for(const index of [0,2,3,5])await expect(dialog.locator(".merge-row").nth(index).locator(".merge-check")).toBeVisible();
    await expect(dialog.getByText("自动检查结果待核实",{exact:true})).toHaveCount(0);
    await expect(dialog.getByText("可选择，由集成 Agent 重新核验检查结果。",{exact:true})).toHaveCount(0);
    await expect(dialog.getByText("可选择，实际合并前需解决冲突。",{exact:true})).toBeVisible();
    await dialog.getByRole("button",{name:"全选可选内容"}).click();
    await expect(dialog.locator(".merge-row input:checked")).toHaveCount(7);
    await expect(dialog.locator(".merge-row").nth(5).getByRole("checkbox")).toBeDisabled();
    await dialog.locator(".merge-row").nth(1).getByRole("button",{name:"查看改动与验证详情"}).click();
    const details=page.getByRole("dialog").last();
    await expect(details.getByText("自动检查结果待核实",{exact:true})).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".merge-row input:checked")).toHaveCount(7);
    await dialog.getByRole("button",{name:"下一步：配置 Agent"}).click();
    const checkbox=dialog.getByRole("checkbox",{name:"设为默认集成 Agent",exact:true});
    const help=dialog.getByRole("button",{name:"查看设为默认集成 Agent说明",exact:true});
    await expect(checkbox).not.toBeChecked();
    for(const scale of ["small","medium","large"]){
      await page.evaluate(v=>{document.documentElement.dataset.fontScale=v;},scale);
      await help.click();
      const panel=page.getByRole("region",{name:"设为默认集成 Agent",exact:true});await expect(panel).toBeVisible();
      await expect(panel).toContainText("不影响派单默认值");await expect(checkbox).not.toBeChecked();
      const box=await panel.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
      const trigger=await help.boundingBox();expect(trigger!.height).toBeGreaterThanOrEqual(44);expect(trigger!.width).toBeGreaterThanOrEqual(44);
      const size=await help.locator("svg").boundingBox();expect(size!.width).toBe(14);
      const label=await checkbox.locator("..").locator("span").boundingBox(),check=await checkbox.boundingBox();
      expect(Math.abs((label!.y+label!.height/2)-(check!.y+check!.height/2))).toBeLessThanOrEqual(1);
      expect(size!.x-(label!.x+label!.width)).toBeGreaterThanOrEqual(4);
      expect(size!.x-(label!.x+label!.width)).toBeLessThanOrEqual(8);
      expect(Math.abs((label!.y+label!.height/2)-(size!.y+size!.height/2)-(-1))).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);await expect(help).toBeFocused();
      await expect(dialog.getByRole("heading",{name:"待集成",exact:true})).toBeVisible();
    }
    await checkbox.check();
    const publish=dialog.getByRole("checkbox",{name:"合并后发布",exact:true});
    await expect(publish).not.toBeChecked();
    await dialog.getByRole("button",{name:"查看合并后发布说明",exact:true}).click();
    await expect(checkbox).toBeChecked();await expect(publish).not.toBeChecked();
    await help.click();await expect(page.locator(".help-hint-panel")).toHaveCount(1);
    await page.goBack();await expect(page.locator(".help-hint-panel")).toHaveCount(0);await expect(help).toBeFocused();
    // Configuration changes clear the explicit save choice.
    if(await dialog.locator("button.agent-settings-mode").isVisible())await dialog.locator("button.agent-settings-mode").click();
    else {await dialog.locator(".agent-settings-more > button").click();await dialog.locator(".agent-settings-more-panel").getByRole("combobox").first().click();}
    await page.locator('[role="option"][data-value="default"]').click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await page.evaluate(()=>{document.documentElement.dataset.fontScale="medium";});
    await page.screenshot({path:testInfo.outputPath("and-476-step-two.png"),fullPage:true});
    await dialog.getByRole("button",{name:"开始处理",exact:true}).click();await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button",{name:"重试原批次",exact:true}).click();
    await expect.poll(()=>bodies.length).toBe(2);expect(bodies[0]).toEqual(bodies[1]);expect(bodies[0]).toMatchObject({saveAsDefault:true,publish:false});
    active=true;empty=false;await page.reload();await page.getByRole("button",{name:"待集成 7",exact:true}).click();
    await expect(dialog.locator(".merge-active-notice")).toBeVisible();await expect(dialog.locator(".merge-row")).toHaveCount(8);
    await dialog.getByRole("button",{name:"全选可选内容"}).click();await expect(dialog.getByRole("button",{name:"下一步：配置 Agent"})).toBeDisabled();
    await dialog.getByRole("button",{name:"查看改动与验证详情"}).first().click();await expect(page.getByRole("dialog")).toHaveCount(2);await page.keyboard.press("Escape");
    await page.screenshot({path:testInfo.outputPath("and-476-active-list.png"),fullPage:true});
    empty=true;await page.reload();await page.getByRole("button",{name:"待集成 0",exact:true}).click();
    await expect(dialog.getByText("当前没有待集成的改动",{exact:true})).toBeVisible();await expect(dialog.getByRole("button",{name:"全选可选内容"})).toBeDisabled();
    await expect(dialog.getByRole("button",{name:"进入合并会话"})).toBeEnabled();await expect(dialog.getByRole("button",{name:"下一步：配置 Agent"})).toBeDisabled();
    await page.screenshot({path:testInfo.outputPath("and-476-active-empty.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
});

test("AND-476 saved integration preference takes priority and read failures can be retried",async({page,request})=>{
  await page.clock.setFixedTime(new Date("2026-11-08T08:00:00Z"));
  const product=await(await request.post("/api/v1/products",{data:{name:"Integration saved preference",keyPrefix:"IPREF"}})).json();
  let failed=true,posts=0;
  const at="2026-11-08T08:00:00Z";
  await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[{id:"saved",productId:product.id,sessionId:"source",revision:"rev",state:"confirmed",summary:"Saved preference fixture",validation:"Passed",itemKeys:["IPREF-1"],head:"a".repeat(40),requiredArtifacts:["web"],evidence:{checkedAt:at,source:"Fixture"}}],batches:[]}}));
  await page.route("**/api/v1/nodes",route=>queueRoute(route).fulfill({json:{nodes:["dispatch-node","integration-node"].map(id=>({id,name:id,online:true,supportsFreeSessions:true,agents:[{kind:"codex",ready:true,models:[]}],repos:[{productId:product.id,repoPath:"fixture"}],createdAt:at}))}}));
  await page.route("**/api/v1/dispatch-defaults",route=>queueRoute(route).fulfill({json:{nodeId:"dispatch-node",agentKind:"codex",agents:{codex:{mode:"auto"}}}}));
  await page.route("**/api/v1/integration-defaults",route=>failed?queueRoute(route).fulfill({status:503,json:{title:"Synthetic preference read failure"}}):queueRoute(route).fulfill({json:{nodeId:"integration-node",agentKind:"codex",agents:{codex:{mode:"default"}}}}));
  await page.route("**/merge-batches",route=>{posts++;return queueRoute(route).fulfill({status:503,json:{title:"Unexpected start"}});});
  await page.goto(`/?product=${product.id}&console=agent`);await page.getByRole("button",{name:"待集成 1",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.getByRole("button",{name:"全选可选内容"}).click();await dialog.getByRole("button",{name:"下一步：配置 Agent"}).click();
  await expect(dialog.getByText("集成默认配置加载失败，请重试后再开始处理。",{exact:false})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"开始处理",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("combobox",{name:"运行设备",exact:true})).toBeDisabled();
  failed=false;await dialog.getByRole("button",{name:"重试",exact:true}).click();
  await expect(dialog.getByRole("combobox",{name:"运行设备",exact:true})).toHaveText("integration-node");
  await expect(dialog.getByRole("checkbox",{name:"设为默认集成 Agent",exact:true})).toHaveCount(0);
  await expect(dialog.getByRole("button",{name:"开始处理",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"取消",exact:true}).click();await dialog.getByRole("button",{name:"放弃修改",exact:true}).click();await expect(dialog).toHaveCount(0);expect(posts).toBe(0);
});
