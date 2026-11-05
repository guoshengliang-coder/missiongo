import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MissionGoStore } from "../../services/server/dist/store.js";
import { ExternalAgentSessionStore } from "../../services/server/dist/external-agent-session-store.js";
import { ImplementationPlans } from "../../services/server/dist/implementation-plans.js";
import { DispatchStore } from "../../services/server/dist/dispatch-store.js";
import { chooseOption } from "./select-helpers";

function setup() {
  const data=process.env.MISSIONGO_UI_FIXTURE_DATA;
  if(!data) throw new Error("Isolated UI fixture is required");
  const store=new MissionGoStore(join(data,"missiongo.sqlite"));
  try {
    const accountId="ui-fixture",clientId="handoff-ui";
    const product=store.createProduct({name:"Agent handoff review",keyPrefix:`AH${randomUUID().slice(0,6).toUpperCase()}`,createdByAccountId:accountId});
    const item=store.createWorkItem({productId:product.id,title:"人工已开始后交给指定 Agent",description:"Preserve in-progress status and explicit authority",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}});
    store.transitionWorkItem({itemKey:item.key,to:"in_progress",actor:"human",reason:"claim",attribution:{accountId}});
    const identity={agentKind:"codex" as const,refKind:"native" as const,sessionRef:randomUUID(),name:"原终端会话 · 清楚保留已登记的方案范围"};
    const plans=new ImplementationPlans(store.database),scope={keys:[item.key],plan:"明确方案：保持处理中，使用原会话接手。",validation:"验证停止核实、领域授权和领取凭据。"};
    const sessionId=new ExternalAgentSessionStore(store).prepareApproval({accountId,clientId},identity,[item.key],"handoff-ui-plan");
    plans.request(accountId,`native:${clientId}:codex:native:${identity.sessionRef}`,"handoff-ui-plan",scope);
    const nodes=new DispatchStore(store.database),node=nodes.registerNode({accountId,installationId:randomUUID(),name:"Handoff UI node"});
    nodes.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1,models:[]}]);
    nodes.replaceOwnRepos(node.nodeId,[{productId:product.id,repoPath:"/synthetic/ui-handoff"}]);
    return {item,product,sessionId,nodeId:node.nodeId};
  } finally {store.close();}
}

for(const width of [320,375,1440]) for(const theme of ["light","dark"] as const) test.describe(`Agent handoff ${width}px ${theme}`,()=>{
  test.use({viewport:{width,height:width===1440?900:812},hasTouch:width<400,isMobile:width<400,colorScheme:theme});
  test("keeps status and draft, verifies old work, and authorizes the selected original conversation",async({page,request},info)=>{
    const f=setup();
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`/?product=${f.product.id}&status=in_progress&item=${f.item.key}`);
    const trigger=page.getByRole("button",{name:"交给 Agent 接手",exact:true});
    await trigger.click();
    const dialog=page.getByRole("dialog").first();
    const note=dialog.getByRole("textbox",{name:"交接范围与原因",exact:true});
    await expect(note).toBeFocused();
    await note.fill("已检查旧执行，接续完成当前条目的实现与验证。");
    const submit=dialog.getByRole("button",{name:"选择机器和 Agent",exact:true});
    await expect(submit).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("button",{name:"继续编辑",exact:true})).toBeVisible();
    await dialog.getByRole("button",{name:"继续编辑",exact:true}).click();
    await expect(note).toHaveValue("已检查旧执行，接续完成当前条目的实现与验证。");
    await dialog.getByRole("button",{name:"核实停止",exact:true}).click();
    const stop=page.getByRole("dialog",{name:"核实停止",exact:true});
    await stop.getByRole("textbox",{name:"停止核实依据",exact:true}).fill("已在原设备核实该人工执行停止。");
    await stop.getByRole("checkbox").check();
    await stop.getByRole("button",{name:"记录停止确认",exact:true}).click();
    await expect(stop).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await expect(note).toHaveValue("已检查旧执行，接续完成当前条目的实现与验证。");
    await submit.click();
    await chooseOption(dialog.getByRole("combobox",{name:"Agent",exact:true}),"codex");
    await expect(dialog.getByRole("button",{name:"授权此会话接手",exact:true})).toBeEnabled();
    await dialog.getByRole("button",{name:"返回交接信息",exact:true}).click();
    await chooseOption(dialog.getByRole("combobox",{name:"接手会话",exact:true}),f.sessionId);
    const authorize=dialog.getByRole("button",{name:"授权此会话接手",exact:true});
    for(const scale of ["small","medium","large"]) {
      await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
      expect(await dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      await authorize.scrollIntoViewIfNeeded();
      const box=await authorize.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
      expect(await note.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(width<400?16:11);
    }
    await page.screenshot({path:info.outputPath("agent-handoff.png")});
    await page.route("**/agent-handoffs",route=>route.fulfill({status:503,json:{code:"unavailable",title:"Service unavailable"}}),{times:1});
    await authorize.click();await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(note).toHaveValue("已检查旧执行，接续完成当前条目的实现与验证。");
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    await page.route("**/agent-handoffs",async route=>{await held;await route.continue();},{times:1});
    await authorize.click();await expect(authorize).toBeDisabled();await expect(note).toBeDisabled();
    await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeDisabled();
    release();await expect(dialog.getByRole("status")).toContainText("交接授权已保存");
    const current=await (await request.get(`/api/v1/items/${f.item.key}`)).json();expect(current.status).toBe("in_progress");
    const delivery=await (await request.get(`/api/v1/items/${f.item.key}/delivery`)).json();
    expect(delivery.executions.find((row:{kind:string})=>row.kind==="human").status).toBe("working");
    await dialog.getByRole("button",{name:"关闭",exact:true}).last().click();
    await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();expect(errors).toEqual([]);
  });
});
