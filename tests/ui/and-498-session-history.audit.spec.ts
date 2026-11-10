import { readFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string;detailKey:string};
const stamp="2026-11-10T00:00:00.000Z";
for (const width of [320,1440]) for (const surface of ["console","panel"] as const) {
  test(`${surface} keeps an off-page current question readable once and old forms read-only at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.emulateMedia({colorScheme:width===320?"dark":"light"});
    await page.clock.setFixedTime(new Date(stamp));
    const id="bounded-history",request={id:"old-request",sourceId:"old-request",role:"agent",text:"Off-page current request",occurredAt:stamp,
      questions:[{title:"Current source question",key:"choice",options:["Current option","Other option"]}]};
    const summary={id,agentSessionId:id,dispatchId:"bounded-dispatch",agentKind:"opencode",status:"idle",updatedAt:stamp,activityAt:stamp,createdAt:stamp,
      nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"default",dispatchStatus:"launched",activities:[],settings:{},unread:false,
      canReply:true,canStop:true,canArchive:true,items:[{key:fixture.detailKey,title:"History",productId:fixture.productId}],
      attention:{state:"not_needed"},needsAttention:false,waitingForReply:false};
    let current=true;
    await page.route("**/api/v1/agent-sessions**",route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith("/progress-reports"))return route.fulfill({json:{progressReports:[{id:"progress-old",text:"Earlier progress retained",occurredAt:stamp}]}});
      if(url.pathname.endsWith("/history"))return route.fulfill({json:{status:"ready",messages:[request,
        {id:"old-question",sourceId:"old-question",role:"agent",text:"Historical form",occurredAt:stamp,
          questions:[{title:"Old source question",options:["Historical option"]}]}]}});
      if(route.request().method()!=="GET")return route.fulfill({status:204});
      return route.fulfill({json:url.pathname==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,
        messages:Array.from({length:50},(_,n)=>({id:`tail-${n}`,sourceId:`tail-${n}`,role:"agent",text:`Recent message ${n}`,occurredAt:stamp})),
        currentRequests:current?[request]:[],history:{nextCursor:"stored:tail-0"},
        progressReports:[{id:"progress-latest",text:"Latest progress",occurredAt:stamp}],progressHistory:{nextCursor:"reports:progress-latest"}}});
    });
    await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{id:summary.dispatchId,agentSessionId:id,
      agentKind:"opencode",mode:"default",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey]}]}}));
    if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    else{
      await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
      await page.locator(".execution-history > summary").click();
      await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();
      await page.locator(".agent-session-toggle").click();
    }
    const area=page.locator(surface==="console"?".agent-console-messages":".agent-session-messages");
    const reply=page.locator(surface==="console"?".agent-console-reply textarea":".agent-session-reply textarea");
    await expect(area.getByRole("button",{name:"Current option",exact:true})).toBeEnabled();
    await expect(area.getByText("Off-page current request",{exact:true})).toHaveCount(1);
    await reply.fill("Keep this draft");
    await area.getByRole("button",{name:"加载更早消息",exact:true}).click();
    await expect(area.getByRole("button",{name:"Historical option",exact:true})).toBeDisabled();
    await expect(area.getByText("Off-page current request",{exact:true})).toHaveCount(1);
    current=false;await advanceSessionDetailPoll(page);
    await expect(area.getByRole("button",{name:"Current option",exact:true})).toBeDisabled();
    await expect(reply).toHaveValue("Keep this draft");
    const progress=area.getByTestId("agent-progress-reports");
    await progress.locator("summary").click();
    await progress.getByRole("button",{name:"加载更早消息",exact:true}).click();
    await expect(progress.getByText("Earlier progress retained",{exact:true})).toBeVisible();
    await expect(reply).toHaveValue("Keep this draft");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  });
}

test("progress pages keep chronological order when a live update overlaps cached history",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.clock.setFixedTime(new Date(stamp));
  const id="progress-overlap";
  let shifted=false;
  const report=(n:number)=>({id:`progress-${n}`,text:`Audit progress ${n}`,occurredAt:stamp});
  const summary={id,agentSessionId:id,productId:fixture.productId,sessionName:"Progress audit",agentKind:"codex",status:"idle",updatedAt:stamp,activityAt:stamp,createdAt:stamp,
    nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,dispatchStatus:"launched",activities:[],settings:{},unread:false,canReply:true,canStop:true,canArchive:true,items:[],attention:{state:"not_needed"},needsAttention:false};
  await page.route("**/api/v1/agent-sessions**",route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith("/progress-reports")){
      const after=url.searchParams.get("cursor");
      return route.fulfill({json:{progressReports:Array.from({length:10},(_,n)=>report(n+(after==="reports:progress-90"?80:81))),nextCursor:after==="reports:progress-90"?"reports:progress-80":"reports:progress-81"}});
    }
    if(route.request().method()!=="GET")return route.fulfill({status:204});
    return route.fulfill({json:url.pathname==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,
      messages:[{id:"message",sourceId:"message",role:"agent",text:"Native answer",occurredAt:stamp}],
      progressReports:Array.from({length:10},(_,n)=>report(n+(shifted?91:90))),progressHistory:{nextCursor:`reports:progress-${shifted?91:90}`}}});
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const progress=page.getByTestId("agent-progress-reports");
  await progress.locator("summary").click();
  await progress.getByRole("button",{name:"加载更早消息",exact:true}).click();
  await expect(progress.locator("article")).toHaveCount(20);
  shifted=true;await advanceSessionDetailPoll(page);
  await expect(progress.locator("article")).toHaveCount(21);
  await progress.getByRole("button",{name:"加载更早消息",exact:true}).click();
  await expect(progress.locator("article p")).toHaveText(Array.from({length:21},(_,n)=>`Audit progress ${n+80}`));
});
