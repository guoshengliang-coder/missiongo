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
    dispatches.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1}]);
    dispatches.replaceOwnRepos(node.nodeId,[{productId:product.id,repoPath:"/synthetic/takeover-ui"}]);
    if (!interrupted) {
      external.report(owner,sessionId,item.key,"completed","Handling ended",randomUUID());
      store.transitionWorkItem({itemKey:item.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Fixture delivery",attribution:{accountId}});
    }
    store.database.connection.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status:"unavailable",turnState:{},error:"Original conversation not loaded "+"long-diagnostic-".repeat(35)}),new Date().toISOString(),sessionId);
    store.transitionWorkItem({itemKey:item.key,to:"ready",reason:interrupted?"released":"verification_failed",actor:"human",note:"Rework",attribution:{accountId}});
    return {item,product,sessionId,nodeId:node.nodeId};
  } finally {store.close();}
}
function activity(sessionId:string,active:boolean) {
  const store=isolatedStore();
  try {store.database.connection.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id=?")
    .run(JSON.stringify({status:active?"active":"unavailable",turnState:{turnActive:active}}),new Date().toISOString(),sessionId);
  } finally {store.close();}
}

for (const width of [320,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`execution takeover ${width}px ${theme}`,()=>{
    test.use({viewport:{width,height:812},hasTouch:width===320,isMobile:width===320,colorScheme:theme});
    test("keeps original execution history without blocking independent participation",async({page,request},info)=>{
      const {item,product,sessionId}=setup(true);
      await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
      const notice=page.getByRole("region",{name:"原执行情况"});
      await expect(notice).toHaveCount(0);
      const data=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
      expect(data.executions.length).toBeGreaterThan(0);
      activity(sessionId,true);await page.reload();
      await expect(notice).toContainText("人工重新开始被原执行阻止");
      await expect(notice).toContainText("不阻止已授权 Agent 独立派单或并行领取");
      expect((await (await request.get(`/api/v1/items/${item.key}/delivery`)).json()).executions.length).toBeGreaterThan(0);
      activity(sessionId,false);
      await page.screenshot({path:info.outputPath("parallel-history.png")});
    });
  });
}


test("ordinary dispatch starts independent work without replacing earlier execution",async({page,request})=>{
  const {item,product,nodeId}=setup(true);
  const previousDefaults = await (await request.get("/api/v1/dispatch-defaults")).json();
  try {
    expect((await request.put("/api/v1/dispatch-defaults", {
      data: { nodeId, agentKind: "codex", agents: { codex: { mode: "auto" } } },
    })).ok()).toBeTruthy();
    await page.goto(`/?product=${product.id}&status=ready`);
    await page.locator(".item-row").filter({hasText:item.key}).getByRole("checkbox").check();
    await page.getByRole("button",{name:"派单",exact:true}).click();
    const form=page.locator(".dispatch-form");
    await expect(form).not.toContainText("启动新执行并接手");
    const submit=form.getByRole("button",{name:"派单",exact:true});
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator(".dispatch-result")).toBeVisible();
    const delivery=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
    expect(delivery.executions.find((row:{kind:string})=>row.kind==="human").status).toBe("working");
  } finally {
    // This account is shared across files; dispatch also initializes defaults.
    // Restore the saved choices even if an assertion fails.
    expect((await request.put("/api/v1/dispatch-defaults", { data: previousDefaults })).ok()).toBeTruthy();
  }
});
