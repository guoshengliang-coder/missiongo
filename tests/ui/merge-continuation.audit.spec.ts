import {test,expect} from "@playwright/test";
import {queueRoute} from "./integration-queue-fixture";

test.use({hasTouch:true});
for(const width of [320,375,1440])for(const theme of ["light","dark"] as const){
  test(`continuation failure, retry and refresh at ${width}px ${theme}`,async({page,request},testInfo)=>{
    const stamp="2026-11-22T02:00:00.000Z";await page.clock.setFixedTime(new Date(stamp));
    await page.setViewportSize({width,height:width===375?812:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post("/api/v1/products",{data:{name:`Continue ${width} ${theme}`,keyPrefix:`CT${width}${theme[0]!.toUpperCase()}`}})).json();
    const id="continuation-session",snapshot="a".repeat(64),batchId="continuation-batch",rowId="continuation-decision";
    const session={id,agentSessionId:id,dispatchId:"continue-dispatch",productId:product.id,agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
      nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
      canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,items:[],sessionPurpose:"integration"};
    const row={id:rowId,digest:"d",snapshot,action:{kind:"defer_publication",reason:"Publish later"},at:stamp,decision:"approved"};
    const older={...row,id:"older-approved",snapshot:"b".repeat(64)};
    const batch={id:batchId,sessionId:id,state:"active",publish:true,deliveries:[],results:{},reconciliation:{requests:[older,row],history:[],handoffs:{}}};
    let state="failed",reason:string|undefined="pending",commandId:string|undefined,sends=0,unreadable=false;
    const continuation=()=>({state,...(reason?{reason}:{}),...(commandId?{commandId}:{})});
    await page.route("**/api/v1/agent-sessions**",route=>queueRoute(route).fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session]}:{...session,messages:[]}}));
    await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[],batches:[batch]}}));
    await page.route(`**/reconciliation/${rowId}/decision`,async route=>{
      expect(route.request().postDataJSON()).toMatchObject({snapshot,decision:"approved",continueInSession:true});
      sends++;state="queued";reason=undefined;commandId="one-command";
      if(width===320)unreadable=true;
      // The server has committed the send even if the browser loses its response.
      if(width===1440)await route.abort("failed");
      else await queueRoute(route).fulfill({json:{batchId,continuation:{...continuation(),queued:true}}});
    });
    await page.route(`**/merge-batches/${batchId}/reconciliation`,route=>unreadable?queueRoute(route).fulfill({status:503,json:{code:"unavailable"}}):queueRoute(route).fulfill({json:{batchId,sessionId:id,state:"active",publish:true,snapshot,entries:[],reconciliation:batch.reconciliation,continuations:{[older.id]:{state:"failed",reason:"scope_changed"},[rowId]:continuation()}}}));
    await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
    const card=page.locator(".merge-delivery-notice.confirmed");
    await expect(card).toContainText("继续消息未能发送");await expect(card).toContainText("已有待发送或待确认的回复");
    const draft=page.locator(".agent-console-reply textarea");await draft.fill("保留我的草稿");
    // Horizontal overflow alone misses a flex copy squeezed down to one character per line.
    for(const scale of ["small","medium","large"]) {
      await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;document.documentElement.dataset.consoleFontScale=value;},scale);
      const copy=await card.locator(".merge-delivery-copy").boundingBox();expect(copy!.width).toBeGreaterThan(230);
      const title=await card.locator("strong").boundingBox();expect(title!.height).toBeLessThan(100);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect(card.getByRole("button",{name:"通知原会话继续",exact:true})).toBeInViewport();
    }
    await page.evaluate(()=>{document.documentElement.dataset.fontScale="medium";document.documentElement.dataset.consoleFontScale="medium";});
    await page.screenshot({path:testInfo.outputPath("continuation-failure.png"),fullPage:true});
    await card.getByRole("button",{name:"通知原会话继续",exact:true}).click();
    await expect(card).toContainText("继续消息已在原会话排队");await expect(draft).toHaveValue("保留我的草稿");
    if(width===320) {
      await expect(card).toContainText("暂时无法核对发送结果",{timeout:15000});
      await expect(card).toContainText("继续消息已在原会话排队");
      unreadable=false;await card.getByRole("button",{name:"核对发送结果",exact:true}).click();
    }
    expect(sends).toBe(1);await expect(card.getByRole("button",{name:"通知原会话继续",exact:true})).toHaveCount(0);
    await page.reload();await expect(card).toContainText("继续消息已在原会话排队");expect(sends).toBe(1);
    state="delivery_unknown";await card.getByRole("button",{name:"核对发送结果",exact:true}).click();
    await expect(card).toContainText("结果待核对");await expect(card.getByRole("button",{name:"通知原会话继续",exact:true})).toHaveCount(0);
    // Check a failed-command projection separately from a pre-enqueue rejection: no new send is offered.
    state="failed";reason="delivery_failed";await card.getByRole("button",{name:"核对发送结果",exact:true}).click();
    await expect(card).toContainText("请在原会话核对该条消息");await expect(card).not.toContainText("可以重试");
    await expect(card.getByRole("button",{name:"通知原会话继续",exact:true})).toHaveCount(0);
    reason=undefined;
    state="delivered";await card.getByRole("button",{name:"核对发送结果",exact:true}).click();
    await expect(card).toContainText("实际执行进展以原会话为准");
    unreadable=true;await card.getByRole("button",{name:"核对发送结果",exact:true}).click();
    await expect(card).toContainText("暂时无法核对发送结果",{timeout:15000});await expect(card).toContainText("继续消息已送达");
    expect(sends).toBe(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("continuation-delivered.png"),fullPage:true});
  });
}
