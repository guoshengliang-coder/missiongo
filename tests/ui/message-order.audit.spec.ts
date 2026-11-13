import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { AgentSessionCommand, AgentSessionMessage } from "../../apps/web/src/types";
import { advanceSessionDetailPoll } from "./polling";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as {productId: string; detailKey: string};

for (const width of [320, 900, 1440]) for (const colorScheme of ["light", "dark"] as const) {
  test(`old receipt stays before a newer reply ${width} ${colorScheme}`, async ({page}, testInfo) => {
    await page.setViewportSize({width, height: 900});
    await page.emulateMedia({colorScheme});
    await page.clock.install({time: new Date("2026-11-13T03:19:00Z")});
    const id = "message-order";
    const createdAt = "2026-11-12T12:46:00Z";
    const command = {id: "original-command", kind: "message", text: "允许，仅用于标准发布性能门禁", status: "delivered", createdAt};
    let mirrored = false;
    const summary = {id, agentSessionId:id, agentKind:"codex", status:"idle", createdAt,
      updatedAt:"2026-11-12T16:54:00Z", activityAt:"2026-11-12T16:54:00Z", nodeName:"Fixture", nodeConnectionState:"online",
      nodeRevoked:false, mode:"plan", dispatchStatus:"launched", settings:{}, activities:[],
      turnState:{turnActive:false, observedAt:"2026-11-13T03:19:00Z"}, canReply:true, canStop:false,
      canArchive:true, canRetry:false, unread:false, items:[], productId:fixture.productId,
      attention:{state:"not_needed"}, needsAttention:false, waitingForReply:false};
    await page.route("**/api/v1/agent-sessions**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/read")) return route.fulfill({status:204});
      if (path === "/api/v1/agent-sessions") return route.fulfill({json:{sessions:[{...summary, command}]}});
      return route.fulfill({json:{...summary, command, messages:[
        {id:"before", sourceId:"before", role:"agent", text:"请确认本次范围", occurredAt:"2026-11-12T12:00:00Z"},
        ...(mirrored ? [{id:"source-user",sourceId:command.id,role:"user",text:command.text,occurredAt:createdAt}] : []),
        {id:"after", sourceId:"after", role:"agent", text:"已合并并发布，本轮结束", occurredAt:"2026-11-12T16:54:00Z"},
      ]}});
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const receipt = page.locator(".agent-console-outgoing");
    const later = page.locator('[data-agent-message-id="agent:after"]');
    await expect(receipt).toContainText("已送达");
    await expect(receipt).not.toContainText("待执行");
    await expect(later).toBeVisible();
    expect((await receipt.boundingBox())!.y).toBeLessThan((await later.boundingBox())!.y);
    for(const scale of ["small","medium","large"]) {
      await page.evaluate(scale=>{document.documentElement.dataset.fontScale=scale;document.documentElement.dataset.consoleFontScale=scale;},scale);
      expect((await receipt.boundingBox())!.y).toBeLessThan((await later.boundingBox())!.y);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.evaluate(()=>{document.documentElement.dataset.fontScale="medium";document.documentElement.dataset.consoleFontScale="medium";});
    await page.screenshot({path:testInfo.outputPath(`message-order-${width}-${colorScheme}.png`)});
    await page.locator(".agent-console-messages").screenshot({path:testInfo.outputPath(`message-order-chat-${width}-${colorScheme}.png`)});
    await page.reload();
    await expect(receipt).toBeVisible();
    expect((await receipt.boundingBox())!.y).toBeLessThan((await later.boundingBox())!.y);
    mirrored = true;
    await advanceSessionDetailPoll(page);
    await expect(receipt).toHaveCount(0);
    await expect(page.locator(".agent-console-messages").getByText(command.text, {exact:true})).toHaveCount(1);
    const user=page.locator(`[data-agent-message-id="user:${command.id}"]`);
    expect(await user.evaluate((node,later)=>Boolean(node.compareDocumentPosition(later)&Node.DOCUMENT_POSITION_FOLLOWING),await later.elementHandle())).toBe(true);
  });
}

async function openReceiptFixture(page: Page, surface:"console"|"panel", read:()=>{
  command:AgentSessionCommand; messages:AgentSessionMessage[]; history?:{nextCursor:string};
}, older?:()=>AgentSessionMessage[]) {
  const id="receipt-history";
  const stamp="2026-11-13T00:00:00Z";
  const summary={id,agentSessionId:id,dispatchId:"receipt-dispatch",productId:fixture.productId,agentKind:"codex",status:"idle",
    createdAt:stamp,updatedAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeConnectionState:"online",nodeRevoked:false,
    dispatchStatus:"launched",mode:"plan",settings:{},activities:[],turnState:{turnActive:false,observedAt:stamp},
    canReply:true,canResolveDelivery:true,canStop:false,canArchive:true,canRetry:false,unread:false,needsAttention:false,
    attention:{state:"not_needed"},items:[{key:fixture.detailKey,title:"Receipt",productId:fixture.productId}]};
  await page.route("**/api/v1/agent-sessions**",route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith("/read"))return route.fulfill({status:204});
    if(path.endsWith("/history"))return route.fulfill({json:{status:"ready",messages:older?.()??[]}});
    return route.fulfill({json:path==="/api/v1/agent-sessions"?{sessions:[summary]}:{...summary,...read()}});
  });
  await page.route("**/api/v1/items/*/dispatches",route=>route.fulfill({json:{dispatches:[{
    id:summary.dispatchId,agentSessionId:id,agentKind:"codex",mode:"plan",nodeName:"Fixture",status:"launched",createdAt:stamp,itemKeys:[fixture.detailKey],
  }]}}));
  if(surface==="console")await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  else {
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({hasText:"派单 · Fixture"}).click();
    await page.locator(".agent-session-toggle").click();
  }
  return page.locator(surface==="console"?".agent-console-messages":".agent-session-messages");
}

for(const surface of ["console","panel"] as const) {
  test(`${surface} distinguishes an unloaded receipt from a source mirror`, async({page})=>{
    await page.clock.install();
    await page.setViewportSize({width:1440,height:900});
    const command:AgentSessionCommand={id:"old",kind:"message",text:"Older input",status:"delivered",createdAt:"2026-11-12T00:00:00Z"};
    const recent:AgentSessionMessage={id:"recent",sourceId:"recent",role:"agent",text:"Newest answer",occurredAt:"2026-11-13T00:00:00Z"};
    const area=await openReceiptFixture(page,surface,()=>({command,messages:[recent],history:{nextCursor:"older"}}),()=>[
      {id:"old-user",sourceId:command.id,role:"user",text:command.text,occurredAt:command.createdAt}]);
    await expect(area.getByText("Older input",{exact:true})).toHaveCount(0);
    await page.locator(".agent-run-details > summary").click();
    await expect(page.getByText(/此消息早于当前已加载历史/)).toBeVisible();
    await area.getByRole("button",{name:"加载更早消息",exact:true}).click();
    await expect(area.getByText("Older input",{exact:true})).toHaveCount(1);
    await expect(page.getByText(/此消息早于当前已加载历史/)).toHaveCount(0);
  });

  test(`${surface} preserves reading position through receipt and mirror updates`,async({page})=>{
    await page.clock.install();
    await page.setViewportSize({width:1440,height:900});
    let command:AgentSessionCommand={id:"mid-input",kind:"message",text:"Input waiting for native mirror",status:"delivering",createdAt:"2026-11-13T00:20:30Z"};
    let mirrored=false;
    const source:AgentSessionMessage[]=Array.from({length:70},(_,n)=>({id:`m-${n}`,sourceId:`m-${n}`,role:"agent",
      text:`Historical message ${n}\n\n${"Content in the same source record. ".repeat(8)}`,occurredAt:new Date(Date.parse("2026-11-13T00:00:00Z")+n*60_000).toISOString()}));
    const area=await openReceiptFixture(page,surface,()=>({command,messages:[...source.slice(0,21),
      ...(mirrored?[{id:"native-input",sourceId:command.id,role:"user" as const,text:command.text,occurredAt:command.createdAt}]:[]),...source.slice(21)]}));
    const anchor=area.locator('[data-agent-message-id="agent:m-35"]');
    await expect(anchor).toHaveCount(1);
    await area.evaluate(box=>{
      const target=box.querySelector<HTMLElement>('[data-agent-message-id="agent:m-35"]')!;
      box.scrollTop+=target.getBoundingClientRect().top-box.getBoundingClientRect().top-60;
      box.dispatchEvent(new Event("scroll",{bubbles:true}));
    });
    const top=()=>anchor.evaluate(node=>node.getBoundingClientRect().top-node.closest('.agent-console-messages,.agent-session-messages')!.getBoundingClientRect().top);
    const before=await top();
    command={...command,status:"delivered"};
    await advanceSessionDetailPoll(page);
    await expect.poll(async()=>Math.abs(await top()-before)).toBeLessThanOrEqual(1);
    mirrored=true;
    await advanceSessionDetailPoll(page);
    await expect(area.getByText(command.text,{exact:true})).toHaveCount(1);
    await expect(area.locator(".agent-reply-feedback")).toHaveCount(0);
    await expect.poll(async()=>Math.abs(await top()-before)).toBeLessThanOrEqual(1);
    const native=area.locator(`[data-agent-message-id="user:${command.id}"]`);
    const following=area.locator('[data-agent-message-id="agent:m-21"]');
    expect(await native.evaluate((node,next)=>Boolean(node.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING),await following.elementHandle())).toBe(true);
  });

  test(`${surface} retains unknown-delivery recovery outside loaded history`,async({page})=>{
    await page.clock.install();
    await page.setViewportSize({width:1440,height:900});
    const command:AgentSessionCommand={id:"unknown-old",kind:"message",text:"Unknown input",status:"delivery_unknown",createdAt:"2026-11-12T00:00:00Z"};
    const area=await openReceiptFixture(page,surface,()=>({command,history:{nextCursor:"older"},messages:[
      {id:"newer",sourceId:"newer",role:"agent",text:"Later output",occurredAt:"2026-11-13T00:00:00Z"}]}));
    await expect(area.getByText(command.text,{exact:true})).toHaveCount(1);
    if(surface==="console")await page.getByRole("button",{name:"查看发送异常",exact:true}).click();
    await expect(page.getByRole("button",{name:"确认未收到，取回文本",exact:true})).toBeVisible();
  });
}
