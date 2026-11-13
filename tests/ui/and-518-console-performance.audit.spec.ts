import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [320,1440])for(const supported of [true,false])test(`AND-518 content-free send/paint metrics width=${width} binding=${supported}`,async({page})=>{
 await page.clock.setFixedTime(new Date("2026-11-13T14:00:00Z"));
 await page.setViewportSize({width,height:900});
 const id="performance-session",privateText="不能进入指标的消息内容";
 const row={id,agentSessionId:id,dispatchId:"performance-dispatch",sessionName:"性能测量",productId:fixture.productId,source:"dispatch",agentKind:"codex",status:"idle",mode:"auto",dispatchStatus:"launched",nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,createdAt:"2026-11-13T14:00:00Z",updatedAt:"2026-11-13T14:00:00Z",activityAt:"2026-11-13T14:00:00Z",activities:[],items:[],settings:{mode:"auto",adjustable:false},canReply:true,canAttach:false,canArchive:true,canStop:false,canRetry:false,unread:false,needsAttention:false,attention:{state:"not_needed"}};
 const batches:any[]=[],sent:any[]=[];let submitted=false;
 await page.route("**/api/v1/console/performance",async route=>{batches.push(route.request().postDataJSON());await route.fulfill({status:202,json:{protocol:1}});});
 await page.route("**/api/v1/agent-sessions**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith("/commands")&&route.request().method()==="POST"){
   sent.push(route.request().postDataJSON());await new Promise(r=>setTimeout(r,150));submitted=true;
   return route.fulfill({status:201,json:{id:"performance-command",kind:"message",text:privateText,status:"delivered",createdAt:"2026-11-13T14:00:00Z"}});
  }
  if(route.request().method()!=="GET")return route.fulfill({status:204});
  return route.fulfill({json:path==="/api/v1/agent-sessions"?{sessions:[row]}:{...row,
   ...(supported&&submitted?{performanceTurns:[{commandId:"performance-command",turnId:"new-turn"}]}:{}),
   messages:submitted?[{id:"user",sourceId:"performance-command",role:"user",text:privateText,turnId:"new-turn",occurredAt:"2026-11-13T14:00:00Z"},{id:"agent",sourceId:"reply",role:"agent",text:"新的回复",turnId:"new-turn",occurredAt:"2026-11-13T14:00:00Z"}]:[]}});
 });
 await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
 const reply=page.locator(".agent-console-reply textarea");await reply.fill(privateText);
 await page.getByRole("button",{name:"发送回复",exact:true}).click();
 await expect(page.locator(".agent-console-messages")).toContainText("新的回复");
 await expect.poll(()=>batches.flatMap(b=>b.events).filter((e:any)=>e.stage==="submit").length).toBe(1);
 const events=()=>batches.flatMap(b=>b.events);
 expect(events().filter((e:any)=>e.stage==="send_started")).toHaveLength(1);
 expect(events().filter((e:any)=>e.stage==="http_attempt")).toHaveLength(1);
 if(supported)await expect.poll(()=>events().filter((e:any)=>e.stage==="reply_visible").length).toBe(1);
 else {await page.waitForTimeout(700);expect(events().some((e:any)=>e.stage==="reply_visible")).toBe(false);}
 expect(JSON.stringify(batches)).not.toContain(privateText);
 expect(JSON.stringify(batches)).not.toContain("new-turn");
 expect(sent).toHaveLength(1);expect(sent[0].requestKey).toBeTruthy();
 expect(events().find((e:any)=>e.stage==="submit").durationMs).toBeGreaterThan(100);
});
