import {test,expect} from "@playwright/test";
import {queueRoute} from "./integration-queue-fixture";
import {AUDIT_SOURCE} from "./audit-page.mjs";

test.use({hasTouch:true});
for(const width of [320,1440])for(const theme of ["light","dark"] as const){
  test(`original conversation publication details ${width}px ${theme}`,async({page,request},testInfo)=>{
    const stamp="2026-11-21T08:00:00.000Z";await page.clock.setFixedTime(new Date(stamp));
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const product=await(await request.post("/api/v1/products",{data:{name:`Original ${width} ${theme}`,keyPrefix:`OC${width}${theme[0]!.toUpperCase()}`}})).json();
    const id="original-conversation";
    // Deliberately no integration sessionPurpose: this is still the original project conversation.
    const session={id,agentSessionId:id,dispatchId:"original-dispatch",productId:product.id,agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,
      nodeName:"Fixture",nodeId:"fixture-node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
      canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,items:[]};
    const batch={id:"original-batch",sessionId:id,state:"active",publish:true,operation:"publish_only",deliveries:[],results:{},
      integration:{protocol:1,revision:1,plans:[],entries:{},events:[]},presentation:{entries:{},ownedExtras:[{id:"old-event",title:"已集成的历史改动",pendingArtifacts:["web"],publication:"pending"}]}};
    await page.route("**/api/v1/agent-sessions**",route=>queueRoute(route).fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[session]}:{...session,messages:[]}}));
    await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[],batches:[batch]}}));
    await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
    const draft=page.locator(".agent-console-reply textarea");await draft.fill("保留原会话草稿");
    const trigger=page.getByRole("button",{name:"集成详情",exact:true});await expect(trigger).toBeVisible();await trigger.click();
    const dialog=page.getByRole("dialog");await expect(dialog).toContainText("仅发布");await expect(dialog).toContainText("不重复合并");
    await expect(dialog).toContainText("已集成的历史改动");
    for(const scale of ["small","medium","large"]){
      await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:{fontSize:number;contrast:number;fontWeight:number}[]};
      expect(audit.text.filter(r=>r.fontSize>0&&r.fontSize<11)).toEqual([]);
      expect(audit.text.filter(r=>r.contrast<(r.fontSize>=24||r.fontWeight>=700&&r.fontSize>=18.66?3:4.5))).toEqual([]);
    }
    await page.screenshot({path:testInfo.outputPath(`original-publication-${width}-${theme}.png`),fullPage:true,animations:"disabled"});
    await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(draft).toHaveValue("保留原会话草稿");await expect(trigger).toBeFocused();
  });
}
