import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
for(const surface of ["console","panel"])for(const width of [320,768,1440])for(const theme of ["light","dark"] as const){
  test(`review facts without execution controls ${surface} ${width} ${theme}`,async({page})=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
    const id="review-fixture",stamp=new Date().toISOString();
    const session={id,agentSessionId:id,dispatchId:"review-dispatch",agentKind:"codex",status:"idle",updatedAt:stamp,createdAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeId:"fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"default",dispatchStatus:"launched",activities:[],settings:{},unread:false,canReply:true,canRetry:false,canStop:false,canArchive:true,items:[{key:fixture.detailKey,title:"Review",productId:fixture.productId}],attention:{state:"none",kind:"none",reason:""},needsAttention:false,messages:[],
      developmentReview:{required:true,records:[{version:1,taskId:"review",agentKind:"codex",sessionRef:"native",requestId:"human",scopeDigest:"a".repeat(64),revision:4,generation:2,status:"passed",round:1,base:"b".repeat(40),checksPassed:true,blockingFindings:0,checks:[{name:"behavior",method:"node test.mjs",result:"passed",evidence:"exit=0; outputSha256="+"a".repeat(64)}],limitations:["浏览器验证仍需保留明确范围，不将模型结论当作人工验收。"]}]}};
    await page.route("**/api/v1/agent-sessions**",route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.endsWith("/plan-records"))return route.fulfill({json:{records:[],hasHistory:false,historyIncomplete:false}});
      return route.fulfill({json:path==="/api/v1/agent-sessions"?{sessions:[session]}:session});
    });
    await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:session.dispatchId,agentSessionId:id,agentKind:"codex",mode:"default",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
    if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    else{await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);await page.locator(".execution-history > summary").click();await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();await page.locator(".agent-session-toggle").click();}
    const summary=page.getByRole("region",{name:"研发审查",exact:true});await expect(summary).toBeVisible();
    await expect(summary).toContainText("第 1/3 轮");await expect(summary).toContainText("当前干净提交");await expect(summary).toContainText("不代表合并、发布或人工验收授权");
    await expect(summary.getByRole("button")).toHaveCount(0);
    await summary.locator("summary").click();
    await expect(summary).toContainText("outputSha256=");
    expect((await summary.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const bounds=await summary.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
    expect(await summary.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  });
}
