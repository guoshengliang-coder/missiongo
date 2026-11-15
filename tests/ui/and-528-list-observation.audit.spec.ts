import { readFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8"));
for(const phone of [true,false])test(`AND-528 visible visits, equal-data refresh and cache-only return phone=${phone}`,async({page})=>{
 await page.clock.setFixedTime(new Date("2026-11-15T02:00:00Z"));
 await page.setViewportSize({width:phone?375:1440,height:900});
 const batches:any[]=[];let requests=0;
 await page.route("**/api/v1/console/performance",async route=>{batches.push(route.request().postDataJSON());await route.fulfill({status:202,json:{protocol:1}});});
 const row={id:"and528",agentSessionId:"and528",dispatchId:"dispatch-528",productId:fixture.productId,agentKind:"codex",status:"idle",updatedAt:"2026-11-15T02:00:00Z",activityAt:"2026-11-15T02:00:00Z",nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,mode:"auto",dispatchStatus:"launched",createdAt:"2026-11-15T02:00:00Z",items:[],activities:[],settings:{},unread:false,canReply:false,canStop:false,canArchive:false,canRetry:false,sessionName:"AND528 list observation",attention:{state:"not_needed"},needsAttention:false};
 await page.route("**/api/v1/agent-sessions",async route=>{requests++;await route.fulfill({json:{sessions:[row]}});});
 await page.goto(`/?product=${fixture.productId}&console=agent`);
 const item=page.locator(".agent-console-session").filter({hasText:row.sessionName});await expect(item).toBeVisible();
 const events=()=>batches.flatMap(b=>b.events);
 await expect.poll(()=>events().filter(e=>e.stage==="list_visit").length).toBe(1);
 const initial=requests;
 await page.locator(".agent-console-topbar-back").click();await expect(page).not.toHaveURL(/console=agent/);
 await page.goForward();await expect(item).toBeVisible();
 await expect.poll(()=>events().filter(e=>e.stage==="list_visit").length).toBe(2);
 expect(requests).toBe(initial);
 await expect.poll(()=>events().some(e=>e.stage==="list_entry_fresh_visible"&&e.result==="no_refresh")).toBe(true);
 // Advance wall time beyond freshness without changing the monotonic performance clock.
 await page.locator(".agent-console-topbar-back").click();await page.clock.setFixedTime(new Date("2026-11-15T02:02:00Z"));
 await page.goForward();await expect(item).toBeVisible();await expect.poll(()=>requests).toBe(initial+1);
 await expect.poll(()=>events().filter(e=>e.stage==="list_fresh_visible").length).toBeGreaterThan(0);
 expect(events().some(e=>e.stage==="list_entry_fresh_visible"&&e.result==="timeout")).toBe(false);
 expect(JSON.stringify(batches)).not.toContain(row.sessionName);expect(JSON.stringify(batches)).not.toContain("userAgent");
 expect(events().filter(e=>e.stage==="list_visit").every(e=>e.list.dataset==="account_feed")).toBe(true);
});
