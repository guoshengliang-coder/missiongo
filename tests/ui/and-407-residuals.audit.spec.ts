import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {expect,test} from "@playwright/test";
import {MissionGoStore} from "../../services/server/dist/store.js";
import {DispatchStore} from "../../services/server/dist/dispatch-store.js";
import {ExternalAgentSessionStore} from "../../services/server/dist/external-agent-session-store.js";

function setup() {
  const directory=process.env.MISSIONGO_UI_FIXTURE_DATA;
  if(!directory)throw new Error("Isolated UI fixture required");
  const store=new MissionGoStore(join(directory,"missiongo.sqlite")),accountId="ui-fixture";
  try {
    const product=store.createProduct({name:"Residual guidance",keyPrefix:`RG${randomUUID().slice(0,6).toUpperCase()}`,createdByAccountId:accountId});
    const create=(title:string)=>store.createWorkItem({productId:product.id,title,description:"Isolated guidance fixture",type:"bug",priority:"normal",status:"ready",environment:{platform:"web"}});
    const blocked=create("人工重新开始提示应可见");
    store.transitionWorkItem({itemKey:blocked.key,to:"in_progress",reason:"claim",actor:"human",attribution:{accountId}});
    const nodes=new DispatchStore(store.database),node=nodes.registerNode({accountId,installationId:randomUUID(),name:"Guidance fixture node"});
    nodes.recordHeartbeat(node.nodeId,[{kind:"codex",ready:true,planApprovalProtocol:1}]);
    const external=new ExternalAgentSessionStore(store),sessionId=external.register({accountId,clientId:"guidance-fixture"},
      {agentKind:"codex",refKind:"native",sessionRef:randomUUID()},blocked.key);
    store.database.connection.prepare("UPDATE external_agent_sessions SET native_node_id=?,native_snapshot_json=?,native_synced_at=? WHERE id=?")
      .run(node.nodeId,JSON.stringify({status:"active",turnState:{turnActive:true}}),new Date().toISOString(),sessionId);
    store.transitionWorkItem({itemKey:blocked.key,to:"ready",reason:"released",actor:"human",note:"Return card only",attribution:{accountId}});
    const stale=create("返工后旧交付保留解释"),partial=create("部分发布显示缺失产物"),noRelease=create("无需发布应独立说明");
    for(const item of [stale,partial,noRelease]) {
      store.claimWorkItem({itemKey:item.key,agentId:"Codex",executionIdentity:`native:${item.key}`,attribution:{accountId},idempotencyKey:randomUUID()});
      store.submitDevelopmentComplete({itemKey:item.key,completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},
        ...(item===noRelease?{requiredArtifacts:[],noReleaseReason:"Documentation only"}:{requiredArtifacts:["web","macosApp"]}),attribution:{accountId},idempotencyKey:randomUUID()});
    }
    store.transitionWorkItem({itemKey:stale.key,to:"pending_verification",reason:"manual_override",actor:"human",note:"Historical handover",attribution:{accountId}});
    store.transitionWorkItem({itemKey:stale.key,to:"ready",reason:"verification_failed",actor:"human",note:"Rework required",attribution:{accountId}});
    store.submitForVerification({itemKey:partial.key,developmentEventId:store.getDevelopmentEvidence(partial.key).handover!.id,
      completion:{kind:"commit",commit:"a".repeat(40),targetBranch:"main"},releases:[{artifact:"web",version:"1",sourceCommit:"a".repeat(40)}],deployedCommit:"a".repeat(40),receiptDigest:"a".repeat(64),attribution:{accountId},idempotencyKey:randomUUID()});
    const mixed=create("多份交付逐份提示缺失依据");
    store.claimWorkItem({itemKey:mixed.key,agentId:"Codex",executionIdentity:`native:${mixed.key}`,attribution:{accountId},idempotencyKey:randomUUID()});
    const mixedIds:string[]=[];
    for(const digit of ["a","b","c"]) {
      const completion={kind:"commit" as const,commit:digit.repeat(40),targetBranch:"main"};
      store.submitDevelopmentComplete({itemKey:mixed.key,completion,
        ...(digit==="a"?{}:{requiredArtifacts:digit==="b"?["web","macosApp"]:["web"]}),attribution:{accountId},idempotencyKey:randomUUID()});
      const delivery=store.getDeliveryRecords(mixed.key).at(-1)!;mixedIds.push(delivery.id);
      if(digit!=="a")store.submitForVerification({itemKey:mixed.key,developmentEventId:delivery.id,completion,
        releases:[{artifact:"web",version:digit,sourceCommit:digit.repeat(40)}],deployedCommit:digit.repeat(40),receiptDigest:digit.repeat(64),attribution:{accountId},idempotencyKey:randomUUID()});
    }
    return {product,blocked,stale,partial,noRelease,mixed,mixedIds,sessionId,nodeId:node.nodeId};
  } finally {store.close();}
}

for(const width of [320,1440])for(const theme of ["light","dark"] as const)test.describe(`AND-407 ${width} ${theme}`,()=>{
  test.use({viewport:{width,height:900},isMobile:width===320,hasTouch:width===320,colorScheme:theme});
  test("distinguishes manual blocking, historical evidence and partial publication",async({page,request},info)=>{
    await page.clock.setFixedTime(new Date("2026-11-09T10:00:00Z"));
    const f=setup();
    try {
      await page.goto(`/?product=${f.product.id}&status=ready&item=${f.blocked.key}`);
      const notice=page.getByRole("region",{name:"原执行情况"});
      await expect(notice).toContainText("人工重新开始被原执行阻止");
      await expect(notice).toContainText("不阻止已授权 Agent 独立派单或并行领取");
      await expect(notice.getByRole("link",{name:"查看原会话"})).toHaveAttribute("href",new RegExp(f.sessionId));
      for(const scale of ["small","medium","large"]) {
        await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
        expect(await notice.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({path:info.outputPath("manual-guidance.png")});
      const endpoint=`/api/v1/items/${f.blocked.key}/delivery`,data=await (await request.get(endpoint)).json();
      await page.route(`**${endpoint}`,route=>route.fulfill({json:{...data,executionBlockers:data.executionBlockers.map((row:object)=>({...row,canOpenSession:false}))}}));
      await page.reload();await expect(notice.getByRole("link",{name:"查看原会话"})).toHaveCount(0);
      await expect(notice).toContainText("此处没有可访问的原会话");
      await page.goto(`/?product=${f.product.id}&status=ready&item=${f.stale.key}`);
      const history=page.locator(".execution-history").filter({has:page.locator("summary",{hasText:"旧交付为何不适用于本轮"})});
      await history.locator("summary").click();await expect(history).toContainText("验收打回");
      await expect(history).toContainText("旧回执不自动复用");
      expect(await history.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      await expect(page.getByRole("button",{name:"交给 Agent 接手",exact:true})).toHaveCount(0);
      await page.goto(`/?product=${f.product.id}&status=development_complete&item=${f.partial.key}`);
      await expect(page.getByRole("status").filter({hasText:"尚缺发布证据"})).toContainText("macosApp");
      await page.screenshot({path:info.outputPath("partial-publication-guidance.png")});
      await page.goto(`/?product=${f.product.id}&status=development_complete&item=${f.noRelease.key}`);
      const panel=page.getByRole("region",{name:"执行记录",exact:true});
      await expect(panel).toContainText("本交付已明确无需发布");
      await expect(panel).not.toContainText("已合并，尚待发布");
      await panel.locator(".execution-history > summary").first().click();
      await expect(panel).toContainText("无需发布，尚待提交验证");
      await page.goto(`/?product=${f.product.id}&status=pending_verification&item=${f.mixed.key}`);
      const gaps=page.getByRole("status").filter({hasText:"对应交付："});
      await expect(gaps).toHaveCount(2);
      await expect(gaps.filter({hasText:f.mixedIds[0]})).toContainText("本轮必需发布产物尚未确认");
      await expect(gaps.filter({hasText:f.mixedIds[1]})).toContainText("尚缺发布证据：macosApp");
      await expect(gaps.filter({hasText:f.mixedIds[2]})).toHaveCount(0);
      for(const scale of ["small","medium","large"]) {
        await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
        for(const gap of await gaps.all())expect(await gap.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({path:info.outputPath("multiple-delivery-gaps.png")});
      expect((await (await request.get(`/api/v1/items/${f.stale.key}`)).json()).status).toBe("ready");
      expect((await (await request.get(`/api/v1/items/${f.partial.key}`)).json()).status).toBe("development_complete");
    } finally {
      const store=new MissionGoStore(join(process.env.MISSIONGO_UI_FIXTURE_DATA!,"missiongo.sqlite"));
      try {new DispatchStore(store.database).revokeNode("ui-fixture",f.nodeId);} finally {store.close();}
    }
  });
});
