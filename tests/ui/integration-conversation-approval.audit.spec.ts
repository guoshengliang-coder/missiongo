import {test,expect} from "@playwright/test";
import {queueRoute} from "./integration-queue-fixture";

test.use({hasTouch:true});
for(const width of [320,375,1440])for(const theme of ["light","dark"] as const){
  test(`integration decision stays in conversation at ${width}px ${theme}`,async({page,request},testInfo)=>{
    const stamp="2026-11-20T08:00:00.000Z";await page.clock.setFixedTime(new Date(stamp));
    await page.setViewportSize({width,height:width===375?812:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post("/api/v1/products",{data:{name:`Decision ${width} ${theme}`,keyPrefix:`DA${width}${theme[0]!.toUpperCase()}`}})).json();
    const id="integration-conversation",snapshot="a".repeat(64);
    const session={id,agentSessionId:id,dispatchId:"decision-dispatch",productId:product.id,agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
      nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
      canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,items:[],sessionPurpose:"integration"};
    const row={id:"decision-one",digest:"d",snapshot,action:{kind:"defer_publication",reason:"先完成本次集成，暂缓发布。"},at:stamp};
    const batch={id:"decision-batch",sessionId:id,state:"active",publish:true,deliveries:[],results:{},reconciliation:{requests:[row],history:[],handoffs:{}}};
    let approved=false,reviewed=0;
    await page.route("**/api/v1/agent-sessions**",route=>queueRoute(route).fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session]}:{...session,messages:[]}}));
    await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[],batches:[batch]}}));
    await page.route("**/reconciliation/decision-one/review",route=>{reviewed++;return queueRoute(route).fulfill({json:{reviewed:true}});});
    await page.route("**/reconciliation/decision-one/decision",route=>{
      expect(route.request().postDataJSON()).toMatchObject({snapshot,decision:"approved",reviewConfirmed:true});approved=true;
      return queueRoute(route).fulfill({json:{batchId:batch.id,saved:true,continuation:{queued:true,state:"queued"}}});
    });
    await page.route("**/merge-batches/decision-batch/reconciliation",route=>queueRoute(route).fulfill({json:{batchId:batch.id,sessionId:id,state:"active",publish:true,snapshot,entries:[{deliveryId:"delivery-one",itemKeys:["UX-1"],requiredArtifacts:["web"],items:[],repository:"https://github.com/example/project",pullRequest:12,originalHead:"a".repeat(40),executionHead:"a".repeat(40),targetBranch:"main"}],
      reconciliation:{...batch.reconciliation,requests:[{...row,...(approved?{decision:"approved"}:{})}]}}}));
    await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
    const card=page.locator(".merge-reconciliation");await expect(card).toBeVisible();await expect(card).toContainText("暂缓发布");
    await expect.poll(()=>reviewed).toBeGreaterThan(0);
    const draft=page.locator(".agent-console-reply textarea");await draft.fill("保留我的草稿");
    await page.screenshot({path:testInfo.outputPath("conversation-decision-review.png"),fullPage:true});
    await card.getByRole("button",{name:"批准本次恢复",exact:false}).click();
    await expect(card).toHaveCount(0);await expect(draft).toHaveValue("保留我的草稿");
    expect(approved).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("conversation-decision-approved.png"),fullPage:true});
  });
}
