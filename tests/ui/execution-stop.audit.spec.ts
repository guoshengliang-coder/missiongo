import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { MissionGoStore } from "../../services/server/dist/store.js";
import { DispatchStore } from "../../services/server/dist/dispatch-store.js";
import { ExternalAgentSessionStore } from "../../services/server/dist/external-agent-session-store.js";

const fixtureNodes: string[] = [];
test.afterEach(()=>{
  if (!fixtureNodes.length) return;
  const store=isolatedStore();
  try {
    const nodes=new DispatchStore(store.database);
    for (const id of fixtureNodes.splice(0)) nodes.revokeNode("ui-fixture",id);
  } finally {store.close();}
});

function isolatedStore() {
  const directory=process.env.MISSIONGO_UI_FIXTURE_DATA;
  if(!directory) throw new Error("Isolated UI fixture is required");
  return new MissionGoStore(join(directory,"missiongo.sqlite"));
}
function setup(interrupted=false) {
  const store=isolatedStore();
  try {
    const accountId="ui-fixture";
    const product=store.createProduct({name:"Execution stop verification",keyPrefix:`ES${randomUUID().slice(0,6).toUpperCase()}`,createdByAccountId:accountId});
    const item=store.createWorkItem({productId:product.id,title:"核实旧执行后重新派单",description:"Keep history and new execution distinct",type:"bug",priority:"normal",status:"ready",environment:{platform:"shared"}});
    const owner={accountId,clientId:"ui-fixture"};
    if (interrupted) store.transitionWorkItem({itemKey:item.key,to:"in_progress",reason:"claim",actor:"human",attribution:{accountId}});
    else store.claimWorkItem({itemKey:item.key,agentId:"Codex",idempotencyKey:randomUUID(),attribution:owner});
    const external=new ExternalAgentSessionStore(store);
    const sessionId=external.register(owner,{agentKind:"codex",refKind:"native",sessionRef:randomUUID()},item.key);
    const dispatches=new DispatchStore(store.database);
    const node=dispatches.registerNode({accountId,installationId:randomUUID(),name:"Fixture node"});
    fixtureNodes.push(node.nodeId);
    dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true}]);
    if (!interrupted) {
      external.report(owner,sessionId,item.key,"completed","Handling ended",randomUUID());
      store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Fixture delivery",attribution:{accountId}});
    }
    store.database.connection.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status:"unavailable",turnState:{},error:"Original conversation not loaded "+"long-diagnostic-".repeat(35)}),new Date().toISOString(),sessionId);
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:interrupted?"released":"verification_failed",actor:"human",note:"Rework",attribution:{accountId}});
    return {item,product,sessionId};
  } finally {store.close();}
}
function activity(sessionId:string,active:boolean) {
  const store=isolatedStore();
  try {store.database.connection.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id=?")
    .run(JSON.stringify({status:active?"active":"unavailable",turnState:{turnActive:active}}),new Date().toISOString(),sessionId);
  } finally {store.close();}
}

for (const width of [320,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`execution stop ${width}px ${theme}`,()=>{
    test.use({viewport:{width,height:812},hasTouch:width===320,isMobile:width===320,colorScheme:theme});
    test("verifies one exact old execution with draft protection and clear pending/failure feedback",async({page,request},info)=>{
      const {item,product,sessionId}=setup();
      await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
      const notice=page.getByRole("region",{name:"启动新执行前，请核实原执行"});
      await expect(notice).toContainText(sessionId);
      await expect(notice).toContainText("来源状态：unavailable · 进展上报：completed");
      await notice.getByText("同步诊断",{exact:true}).click();
      await expect(notice).toContainText("Original conversation not loaded");
      expect(await notice.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      await notice.getByRole("button",{name:"核实停止",exact:true}).click();
      const dialog=page.getByRole("dialog");
      const note=dialog.getByRole("textbox",{name:"停止核实依据",exact:true});
      await expect(note).toBeFocused();
      const submit=dialog.getByRole("button",{name:"记录停止确认",exact:true});
      await expect(submit).toBeDisabled();
      await note.fill("已在原设备核实旧执行停止，当前无进行中的任务。");
      await expect(submit).toBeDisabled();
      const attestation=dialog.getByRole("checkbox");
      await attestation.check();
      await expect(submit).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog.getByText("继续编辑",{exact:true})).toBeVisible();
      await dialog.getByRole("button",{name:"继续编辑",exact:true}).click();
      await expect(note).toHaveValue("已在原设备核实旧执行停止，当前无进行中的任务。");
      await page.route("**/execution-blockers/*/confirm-stopped",route=>route.fulfill({status:503,json:{code:"unavailable",title:"Service unavailable"}}),{times:1});
      await submit.click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(note).toHaveValue("已在原设备核实旧执行停止，当前无进行中的任务。");
      for (const scale of ["small","medium","large"]) {
        await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
        expect(await dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
        expect(await note.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(width===320?16:11);
      }
      await page.evaluate(()=>{document.documentElement.dataset.fontScale="medium";});
      if (width===320) {
        await page.setViewportSize({width:812,height:375});
        await submit.scrollIntoViewIfNeeded();
        const footerBox=await submit.boundingBox();
        expect(footerBox!.y+footerBox!.height).toBeLessThanOrEqual(375);
        expect(await dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
        await page.setViewportSize({width,height:812});
      }
      expect(await dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      const box=await attestation.locator("..").boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);
      const checkBox=await attestation.boundingBox(), labelText=await attestation.locator("..").locator("span").boundingBox();
      expect(checkBox!.x+checkBox!.width).toBeLessThanOrEqual(labelText!.x);
      await page.screenshot({path:info.outputPath("verify-stop.png")});
      let release!:()=>void;
      const wait=new Promise<void>(resolve=>{release=resolve;});
      await page.route("**/execution-blockers/*/confirm-stopped",async route=>{await wait;await route.continue();},{times:1});
      await submit.click();
      await expect(submit).toBeDisabled();
      await expect(note).toBeDisabled();
      await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeDisabled();
      release();
      await expect(dialog).toHaveCount(0);
      await expect(notice).toHaveCount(0);
      const delivery=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
      expect(delivery.executionBlockers).toEqual([]);
      expect(delivery.executions[0]).toMatchObject({sessionId,status:"completed"});
      const stored=await (await request.get(`/api/v1/items/${item.key}`)).json();expect(stored.status).toBe("ready");
      activity(sessionId,true);
      await page.reload();
      await expect(notice).toContainText("来源仍上报活动");
      await expect(notice.getByRole("button",{name:"核实停止",exact:true})).toHaveCount(0);
      activity(sessionId,false);
      await page.reload();
      await expect(notice.getByRole("button",{name:"核实停止",exact:true})).toBeVisible();
    });
  });
}

test("rejects stale source observations without replacing the user's check or silently rebinding a polling update",async({page})=>{
  const {item,product,sessionId}=setup();
  await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
  await page.getByRole("button",{name:"核实停止",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("textbox",{name:"停止核实依据",exact:true}).fill("Original observation was checked");
  await dialog.getByRole("checkbox").check();
  activity(sessionId,true);activity(sessionId,false);
  await dialog.getByRole("button",{name:"记录停止确认",exact:true}).click();
  await expect(dialog.getByRole("alert")).toHaveText("条目或执行状态已变更，请刷新条目并重新核实原会话后再确认。");
  await expect(dialog.getByRole("textbox",{name:"停止核实依据",exact:true})).toHaveValue("Original observation was checked");
});


for (const width of [320,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`interrupted execution ${width}px ${theme}`,()=>{
    test.use({viewport:{width,height:812},hasTouch:width===320,isMobile:width===320,colorScheme:theme});
    test("checks each interrupted working execution separately without fabricating completed history",async({page,request},info)=>{
      const {item,product,sessionId}=setup(true);
      await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
      const notice=page.getByRole("region",{name:"启动新执行前，请核实原执行"});
      await expect(notice.getByRole("button",{name:"核实停止",exact:true})).toHaveCount(2);
      await expect(notice).toContainText("人工领取处理");
      await expect(notice).toContainText("进展上报：working");
      const original=notice.locator(".execution-stop-observation").filter({hasText:sessionId});
      await original.getByRole("button",{name:"核实停止",exact:true}).click();
      const dialog=page.getByRole("dialog");
      await dialog.getByRole("textbox",{name:"停止核实依据",exact:true}).fill("已在原设备核实该会话停止，当前无活动或待执行命令。");
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button",{name:"记录停止确认",exact:true}).click();
      await expect(dialog).toHaveCount(0);
      await expect(notice.getByRole("button",{name:"核实停止",exact:true})).toHaveCount(1);
      activity(sessionId,false);await page.reload();
      await expect(notice.getByRole("button",{name:"核实停止",exact:true})).toHaveCount(1);
      await expect(notice).toContainText("人工领取处理");
      await notice.getByRole("button",{name:"核实停止",exact:true}).click();
      await dialog.getByRole("textbox",{name:"停止核实依据",exact:true}).fill("已核实这条旧执行的工作停止，确认结束其在途阻塞。");
      await dialog.getByRole("checkbox").check();
      await page.screenshot({path:info.outputPath("interrupted-stop-check.png")});
      await dialog.getByRole("button",{name:"记录停止确认",exact:true}).click();
      await expect(dialog).toHaveCount(0);await expect(notice).toHaveCount(0);
      const delivery=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
      expect(delivery.executionBlockers).toEqual([]);
      expect(delivery.executions).toHaveLength(2);
      expect(delivery.executions.every((row:{status:string})=>row.status==="working")).toBe(true);
      expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("ready");
    });
  });
}
