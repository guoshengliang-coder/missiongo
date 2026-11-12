import { queueRoute } from "./integration-queue-fixture";
import { refreshFromConsoleStream } from "./polling";
import { chooseOption } from "./select-helpers";
import { expect, test } from "@playwright/test";

for (const viewport of [{width:320,theme:"dark"},{width:724,theme:"light"},{width:1440,theme:"dark"}] as const) {
  test.describe(`AND-465/469 ${viewport.width} ${viewport.theme}`,()=>{
    test.use({viewport:{width:viewport.width,height:850},hasTouch:true,colorScheme:viewport.theme});
    test("reveals a deep-linked selected row on arrival and layout return, without polling taking over scrolling",async({page,request},info)=>{
      const product=await(await request.post("/api/v1/products",{data:{name:"Selected conversation",keyPrefix:`SC${viewport.width}`}})).json();
      const now=Date.parse("2026-11-12T00:00:00Z"),id="session-34";
      const rows=Array.from({length:35},(_,i)=>({id:`session-${i}`,agentSessionId:`session-${i}`,dispatchId:`dispatch-${i}`,productId:product.id,
        agentKind:"codex",status:"idle",createdAt:new Date(now-i*1000).toISOString(),updatedAt:new Date(now-i*1000).toISOString(),activityAt:new Date(now-i*1000).toISOString(),
        nodeName:"Fixture",nodeId:"node",nodeConnectionState:"online",mode:"auto",dispatchStatus:"launched",activities:[],settings:{},unread:false,
        canReply:true,canRetry:false,canStop:false,canArchive:true,attention:{state:"not_needed"},needsAttention:false,items:[],sessionName:`Conversation ${i}`}));
      let phase="merging";
      await page.route("**/api/v1/agent-sessions**",async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path==="/api/v1/agent-sessions")return queueRoute(route).fulfill({json:{sessions:rows}});
        const row=rows.find(r=>r.id===path.split("/")[4])??rows[34]!;
        return queueRoute(route).fulfill({json:{...row,messages:[]}});
      });
      await page.route(/\/(?:merge-deliveries|integration-queue)(?:\?.*)?$/,route=>queueRoute(route).fulfill({json:{deliveries:[],batches:[],sessionProgress:{[id]:phase}}}));
      await page.clock.install({time:new Date(now)});
      await page.goto(`/?product=${product.id}&console=agent&session=${id}&consoleFilter=attention`);
      if(viewport.width===320)await page.locator(".agent-console-conversation-back").click();
      await expect(page.getByText("当前筛选未显示选中的会话。")).toBeVisible();
      await page.getByRole("button",{name:"显示此会话",exact:true}).click();
      const list=page.locator(".agent-console-session-list"),selected=list.locator(".agent-console-session.active");
      await expect(selected).toContainText("Conversation 34");
      await expect.poll(()=>selected.evaluate(el=>{const list=el.closest(".agent-console-session-list")!;const a=el.getBoundingClientRect(),b=list.getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;})).toBe(true);
      await page.screenshot({path:info.outputPath("selected-conversation.png")});
      await list.evaluate(el=>{el.scrollTop=0;});
      await refreshFromConsoleStream(page);
      await page.clock.fastForward(6_000);
      await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBe(0);
      if(viewport.width===320)await selected.click();
      for(const [next,label]of [["merging","合并中"],["publishing","发布中"],["merged","合并完成"],["published","已发布"],["publication_unknown","已合并 · 发布待核实"]]){
        phase=next!;await refreshFromConsoleStream(page);await page.clock.fastForward(16_000);
        const notice=page.locator(`[data-session-delivery="${next}"]`);
        await expect(notice).toBeVisible();await expect(notice.locator("strong")).toHaveText(label!);
        await expect(page.locator(`.agent-console-session.active [data-merge-progress="${next}"]`)).toHaveCount(1);
        if(next==="published")await page.screenshot({path:info.outputPath("published-conversation.png")});
      }
      await expect(page.locator(".agent-console-reply textarea")).toBeEnabled();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    });
  });
}

for(const width of [353,1440])test(`AND-470 differentiates inconsistent, failed and truly empty lists and recovers with original filters ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:900});
  const product=await(await request.post("/api/v1/products",{data:{name:"List recovery",keyPrefix:`LR${width}`}})).json();
  const item=await(await request.post("/api/v1/items",{data:{productId:product.id,status:"ready",type:"bug",priority:"normal",title:"Recover the current list",description:"Synthetic",environment:{platform:"web"}}})).json();
  let mode="inconsistent",requests=0;
  await page.route("**/api/v1/bootstrap**",async route=>{
    const response=await route.fetch(),body=await response.json();
    return queueRoute(route).fulfill({response,json:{...body,items:[]}});
  });
  await page.route("**/api/v1/items?**",async route=>{
    requests++;
    if(mode==="error")return queueRoute(route).fulfill({status:403,json:{code:"forbidden",title:"Synthetic rejected list"}});
    const response=await route.fetch(),body=await response.json();
    return queueRoute(route).fulfill({response,json:mode==="inconsistent"?{...body,items:[]}:body});
  });
  await page.goto(`/?product=${product.id}&status=ready`);
  await expect(page.getByRole("alert")).toContainText("条目数量与列表结果不一致");
  await expect(page.locator(".empty-list")).toHaveCount(0);
  const originalUrl=page.url();
  await expect.poll(()=>requests).toBe(1);
  await page.waitForTimeout(200);
  expect(requests).toBe(1);
  mode="error";
  await page.getByRole("alert").getByRole("button",{name:"重试",exact:true}).click();
  await expect(page.getByRole("alert")).not.toContainText("条目数量与列表结果不一致");
  await expect(page.locator(".empty-list")).toHaveCount(0);
  mode="ok";
  await page.getByRole("alert").getByRole("button",{name:"重试",exact:true}).click();
  await expect(page.locator(".item-row")).toContainText(item.key);
  expect(page.url()).toBe(originalUrl);
  const nav=page.locator(width===353?".mobile-status-nav":".sidebar");
  await nav.getByRole("button",{name:/^草稿/}).click();
  await expect(page.locator(".empty-list")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for(const width of [353,1440])test(`AND-470 creates then switches conditions with a late response and network pause ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:900});
  const product=await(await request.post("/api/v1/products",{data:{name:"Create and return",keyPrefix:`CR${width}`}})).json();
  for(const status of ["inbox","ready"])expect((await request.post("/api/v1/items",{data:{productId:product.id,status,type:"bug",priority:"normal",title:`Existing ${status}`,description:"Fixture",environment:{platform:"web"}}})).status()).toBe(201);
  await page.goto(`/?product=${product.id}`);
  await expect(page.locator(".item-row")).toHaveCount(1);
  await page.locator(width===353?".mobile-fab":".capture-button").click();
  const form=page.locator(".quick-capture-form");
  await form.locator(".ai-title-field input").fill("Created before switching");
  await form.locator(".report-input-block textarea").first().fill("Real isolated server submission");
  await chooseOption(form.getByRole("combobox",{name:/平台/}),"web");
  await form.getByRole("button",{name:"提交到待处理",exact:true}).click();
  await expect(form).toHaveCount(0);await expect(page.locator(".item-row")).toHaveCount(2);
  let release!:()=>void,seen=false;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v1/items?**",async route=>{
    if(new URL(route.request().url()).searchParams.get("status")==="inbox"){
      const response=await route.fetch();seen=true;await delayed;
      await queueRoute(route).fulfill({response}).catch(()=>{});return;
    }
    await route.continue();
  });
  const nav=page.locator(width===353?".mobile-status-nav":".sidebar");
  await nav.getByRole("button",{name:/^草稿/}).click();await expect.poll(()=>seen).toBe(true);
  await nav.getByRole("button",{name:/^待处理/}).click();release();
  await expect(page.locator(".item-row")).toHaveCount(2);await expect(page.locator(".item-row").filter({hasText:"Existing inbox"})).toHaveCount(0);
  await page.context().setOffline(true);
  await nav.getByRole("button",{name:/^处理中/}).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("正在等待网络连接，恢复后会重新加载条目。",{exact:true})).toBeVisible();
  await expect(page.locator(".empty-list")).toHaveCount(0);
  await page.context().setOffline(false);
  await expect(page.locator(".empty-list")).toBeVisible();
  await nav.getByRole("button",{name:/^待处理/}).click();
  await expect(page.locator(".item-row")).toHaveCount(2);
});
