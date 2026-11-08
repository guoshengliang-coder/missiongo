import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const {productId}=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};

for(const scenario of ["unknown", "unavailable", "model-change", "codex"] as const) {
 test(`AND-400 ${scenario}: modes remain explicit and unavailable choices cannot start`,async({page},testInfo)=>{
  await page.setViewportSize({width:353,height:820});
  const kind=scenario==="codex" ? "codex" : "claude_code";
  const modes=scenario==="unknown" ? [] : scenario==="unavailable" ? [{mode:"auto",state:"unavailable",reason:"native_rejected"}] : [
   {mode:"auto",state:"available",model:"model-a"},{mode:"auto",state:"unavailable",model:"model-b",reason:"native_rejected"}];
  const node={id:"mode-node",name:"Mode fixture",online:true,supportsFreeSessions:true,createdAt:new Date().toISOString(),repos:[{productId,repoPath:"fixture-repository"}],repoCandidates:[],agents:[{
   kind,ready:true,planApprovalProtocol:1,modes,models:[{id:"model-a",label:"Model A",efforts:[]},{id:"model-b",label:"Model B",efforts:[]}]}]};
  const defaults={nodeId:node.id,agentKind:kind,agents:scenario==="model-change" ? {[kind]:{mode:"auto",model:"model-a"}} : {}};
  await page.route("**/api/v1/nodes",route=>route.fulfill({json:{nodes:[node]}}));
  await page.route("**/api/v1/dispatch-defaults",route=>route.fulfill({json:defaults}));
  await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:{sessions:[]}}));
  await page.goto(`/?product=${productId}&console=agent`);
  const direct=page.locator(".agent-console-topbar-new");
  if(await direct.isVisible()) await direct.click();
  else {await page.locator(".agent-console-topbar-more > summary").click();await page.locator(".agent-console-topbar-more-menu").getByRole("button",{name:"新会话",exact:true}).click();}
  const form=page.locator(".dispatch-form"), mode=form.getByRole("combobox",{name:"权限模式",exact:true}), enter=form.getByRole("button",{name:"进入会话",exact:true});
  if(scenario==="model-change") {
   await expect(mode).toHaveAttribute("data-value","auto");await expect(enter).toBeEnabled();
   await form.getByRole("combobox",{name:"模型",exact:true}).click();await page.getByRole("option",{name:"Model B",exact:true}).click();
   await expect(mode).toHaveAttribute("data-value","auto");await expect(enter).toBeDisabled();
  } else if(scenario==="unknown") {
   await expect(mode).toHaveAttribute("data-value","");await expect(enter).toBeDisabled();
   await mode.click();await expect(page.getByRole("option").filter({hasText:/^Auto/})).toHaveAttribute("aria-disabled","true");
   await page.getByRole("option",{name:"Default",exact:true}).click();await expect(enter).toBeEnabled();
  } else if(scenario==="unavailable") {
   await expect(mode).toHaveAttribute("data-value","bypassPermissions");await expect(enter).toBeEnabled();
  } else {
   await expect(mode).toHaveAttribute("data-value","auto");await mode.click();
   const full=page.getByRole("option").filter({hasText:/完整访问权限/});await expect(full).toHaveAttribute("aria-disabled","true");await expect(full).toContainText("受管工作区");
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`modes-${scenario}.png`)});
 });
}

test("registered plan presents its exact scope and validation without classifier attention",async({page})=>{
 const stamp=new Date().toISOString(), id="registered-plan";
 const session={id,agentSessionId:id,dispatchId:"registered-dispatch",agentKind:"codex",status:"idle",mode:"read-only",nodeId:"mode-node",nodeName:"Fixture",nodeConnectionState:"online",createdAt:stamp,updatedAt:stamp,activityAt:stamp,items:[{key:"AND-400",title:"Exact plan",productId}],activities:[],settings:{},canReply:true,canArchive:true,attention:{state:"not_needed"},needsAttention:false,messages:[],planApprovalStatus:{code:"ready"},planApproval:{revision:"exact-v1",plan:"Implement only the approved native mode transition",validation:"Verify actual mode before claim",itemKeys:["AND-400"]}};
 await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions" ? {sessions:[session]} : session}));
 await page.goto(`/?product=${productId}&console=agent&session=${id}`);
 const banner=page.locator(".agent-plan-inline-approval");await expect(banner).toBeVisible({timeout:10000});
 await expect(page.locator("article[data-agent-message-id]")).toHaveCount(0);
 const plan=page.getByRole("region",{name:"方案记录",exact:true});
 await plan.getByText("查看已登记方案",{exact:true}).click();
 await expect(plan).toBeVisible();await expect(plan).toContainText(session.planApproval.plan);await expect(plan).toContainText(session.planApproval.validation);await expect(plan).toContainText("AND-400");
 await expect(banner.getByRole("button",{name:"批准",exact:true})).toBeEnabled();
});

for (const [kind, mode] of [["claude_code", "bypassPermissions"], ["codex", "auto"], ["opencode", "build"]]) {
 for (const width of [320, 1280]) {
  test(`${kind}: selected ${mode} stays visible while plan approval is pending at ${width}px`, async ({page}) => {
   await page.setViewportSize({width,height:900});
   await page.emulateMedia({colorScheme:width===320 ? "dark" : "light"});
   const stamp=new Date().toISOString(), id=`independent-${kind}`;
   const session={id,agentSessionId:id,dispatchId:"independent-dispatch",agentKind:kind,status:"idle",nodeId:"mode-node",nodeName:"Fixture",
    nodeConnectionState:"online",createdAt:stamp,updatedAt:stamp,activityAt:stamp,items:[{key:"AND-400",title:"Scoped work",productId}],
    activities:[],settings:{mode,requestedMode:mode,adjustable:true},canReply:true,canArchive:true,canApprovePlan:true,
    attention:{state:"not_needed"},needsAttention:false,messages:[],planApprovalStatus:{code:"ready"},
    planApproval:{revision:"independent-v1",plan:"Implement the scoped change",validation:"Verify approved behavior",itemKeys:["AND-400"]}};
   await page.route("**/api/v1/nodes",route=>route.fulfill({json:{nodes:[{id:"mode-node",name:"Fixture",online:true,
    repos:[],repoCandidates:[],agents:[{kind,ready:true,models:[]}]}]}}));
   await page.route("**/api/v1/agent-sessions**",route=>route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions" ? {sessions:[session]} : session}));
   await page.goto(`/?product=${productId}&console=agent&session=${id}`);
   if(width===320) await page.locator(".agent-session-quick-settings").getByRole("button",{name:"更多操作",exact:true}).click();
   await expect(page.locator(".agent-session-quick-settings").getByRole("combobox",{name:"权限模式",exact:true})).toHaveAttribute("data-value",mode!);
   if(width===320) await page.keyboard.press("Escape");
   await expect(page.locator(".agent-plan-inline-approval").getByRole("button",{name:"批准",exact:true})).toBeEnabled({timeout:10000});
   await expect(page.getByText("方案批准后才生效",{exact:false})).toHaveCount(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
 }
}
