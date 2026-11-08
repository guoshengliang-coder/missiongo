import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [320,1440]) test(`message time survives metadata/settings refresh at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.clock.install({time:new Date("2026-11-08T12:00:00.000Z")});
  await page.clock.setFixedTime(new Date("2026-11-08T12:00:00.000Z"));
  const yesterday="2026-11-07T03:39:51.894Z",today="2026-11-08T11:24:23.000Z";
  let refreshed=false;
  const summary=()=>({id:"old-clock",agentSessionId:"old-clock",productId:fixture.productId,sessionName:"Old clock fixture",
    agentKind:"codex",status:"idle",createdAt:yesterday,activityAt:yesterday,updatedAt:refreshed?today:yesterday,
    nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,mode:refreshed?"auto":"default",dispatchStatus:"launched",
    activities:[],settings:{},unread:false,canReply:true,canStop:false,canArchive:true,items:[],
    attention:{state:"not_needed"},needsAttention:false,waitingForReply:false});
  await page.route("**/api/v1/agent-sessions**",route=>{
    if(route.request().method()!=="GET")return route.fulfill({status:204});
    return route.fulfill({json:new URL(route.request().url()).pathname==="/api/v1/agent-sessions"?{sessions:[summary()]}:
      {...summary(),messages:[{id:"answer",sourceId:"answer",role:"agent",text:"Yesterday result",occurredAt:yesterday}]}});
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=old-clock`);
  if(width===320) await page.getByRole("button",{name:"返回会话列表"}).click();
  const row=page.locator(".agent-console-session").filter({hasText:"Old clock fixture"});
  await expect(row.locator("time")).toContainText("昨天");
  refreshed=true;
  await advanceSessionDetailPoll(page);
  await expect(row.locator("time")).toContainText("昨天");
});
