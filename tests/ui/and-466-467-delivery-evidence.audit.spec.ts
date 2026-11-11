import { readFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
import { postItemCommand } from "./item-command";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [320,1440])for(const theme of ["light","dark"] as const)test.describe(`no-release evidence ${width} ${theme}`,()=>{
 test.use({viewport:{width,height:900},hasTouch:width===320,isMobile:width===320,colorScheme:theme});
 for(const supplement of [false,true])test(`keeps complete local evidence and failed checks readable without claiming publication (supplement=${supplement})`,async({page,request})=>{
  const response=await request.post("/api/v1/items",{data:{productId:fixture.productId,title:"No-release evidence regression",description:"Synthetic local delivery",type:"task",priority:"normal",status:"ready",environment:{platform:"shared"}}});
  expect(response.ok()).toBe(true);const item=await response.json() as {key:string};
  for(const [to,reason]of [["in_progress","claim"],["development_complete","resolution_submitted"]])expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`,{data:{to,reason}})).ok()).toBe(true);
  const payload={reason:supplement?"non_release_supplemented":"resolution_submitted",completion:{kind:"local_change",evidence:{version:1,target:"Synthetic local shared tools",summary:"Applied local configuration",rollback:"Restore verified backup",files:[{name:"tools/release-helper.mjs",beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),sizeBytes:27}],validation:{checks:[{name:"Timing target",method:"Measured CI",result:"failed",evidence:"Observed 31.7%, original target 10%"}],remainingVerification:["Human must decide whether further work is needed"],limitations:["This result does not meet the original target"]}}},requiredArtifacts:[],noReleaseReason:"Local tools only",evidenceDigest:"c".repeat(64)};
  await page.route(`**/api/v1/items/${item.key}/timeline`,async route=>{
   const upstream=await route.fetch();const body=await upstream.json();
   await route.fulfill({response:upstream,json:{...body,events:body.events.map((event:Record<string,unknown>)=>event.toStatus === "development_complete"?{...event,...(supplement?{eventType:"delivery_evidence_added",fromStatus:undefined,toStatus:undefined}:{}),payload}:event)}});
  });
  await page.route(`**/api/v1/items/${item.key}`,async route=>{const upstream=await route.fetch();await route.fulfill({response:upstream,json:{...await upstream.json(),deliveryBasis:"no_release"}});});
  await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}&item=${item.key}`);
  await expect(page.locator(".detail-toolbar button.toolbar-primary-action")).toHaveText("提交验证");
  if(supplement)await expect(page.locator(".detail-pane")).toContainText("已补充交付依据");
  const evidence=page.locator(".timeline-handover-evidence");
  await evidence.locator("summary").focus();
  await evidence.locator("summary").press("Enter");
  await expect(evidence).toContainText("不代表正式发布或人工验收通过");
  await expect(evidence).toContainText("检查失败");
  await expect(evidence).toContainText("31.7%, original target 10%");
  await expect(evidence).toContainText("Restore verified backup");
  await expect(evidence).toContainText("b".repeat(64));
  for(const scale of ["small","medium","large"]){
   await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   expect(await evidence.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  }
  await page.screenshot({path:test.info().outputPath("delivery-evidence.png"),fullPage:true});
  await page.locator(".detail-toolbar button.toolbar-primary-action").click();
  // The submit also refreshes the detail reads still in flight through the
  // console stream; leaving the routes installed lets them keep fetching past
  // the end of the test.
  await page.unrouteAll({behavior:"ignoreErrors"});
  await expect.poll(async()=> (await (await request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("pending_verification");
  const timeline=await (await request.get(`/api/v1/items/${item.key}/timeline`)).json();
  expect(timeline.events.at(-1).payload.reason).toBe("non_release_submitted");
 });
});
