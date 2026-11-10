import { postItemCommand } from "./item-command";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectUsableControl } from "./visible-control";
import { advanceAttentionPoll } from "./polling";
const badgeText=(count:number)=>count>99?"99+":String(count);
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
async function seed(page:Page) {
  const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
  const item=await(await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title:"消息中心交互验证 · 很长的业务标题 ".repeat(3),description:"仅测试数据",environment:{platform:"web"}}})).json();
  const posted=await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text:"请核对本次变更，查看消息不会改变条目状态。\n长内容测试 ".repeat(12),mentionAccountIds:[user.id]}});
  expect(posted.ok()).toBe(true);
  const notification=(await(await page.request.get("/api/v1/notifications")).json()).notifications.find((n:any)=>n.itemKey===item.key);
  return {item,notification};
}
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date("2026-11-09T12:00:00Z"));});
const center=(page:Page)=>page.locator(".message-center-layer");
const detail=(page:Page)=>center(page).locator(".message-detail-pane .detail-pane");
async function openNotice(page:Page,itemKey:string){
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:itemKey}).first().click();
}
for(const width of [320,390,736,1024,1440])for(const theme of ["light","dark"] as const){
  test.describe(`messages ${width}px ${theme}`,()=>{
    test.use({viewport:{width,height:width===736?414:900},hasTouch:width<1024,colorScheme:theme});
    test("opens the original detail directly, locates comments and returns to the original context",async({page},testInfo)=>{
      const {item,notification}=await seed(page);
      expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
      await page.goto(`/?product=${fixture.productId}&status=all`);
      const entry=page.getByRole("button",{name:"待处理",exact:true});
      await page.getByRole("button",{name:"搜索条目…",exact:true}).click();
      const search=page.getByRole("textbox",{name:"搜索条目…",exact:true});
      await expect(search).toBeFocused();await search.fill(item.key);await page.keyboard.press("Escape");
      const originalUrl=page.url();
      await entry.click();
      await page.locator(".message-list-row").filter({hasText:item.key}).click();
      await expect(detail(page)).toBeVisible();
      await expect(page.getByRole("button",{name:"前往验证",exact:true})).toHaveCount(0);
      for(const scale of ["small","medium","large"]){
        await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
        await expectUsableControl(detail(page).getByRole("button",{name:"验证通过",exact:true}),width<1024);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      }
      await page.screenshot({path:testInfo.outputPath(`todo-${width}-${theme}.png`)});
      if(width<1024)await page.getByRole("button",{name:"返回列表",exact:true}).click();
      await page.getByRole("button",{name:/^通知/}).click();
      await expect(page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"交付待验收"})).toHaveCount(0);
      await page.locator(".message-list-row").filter({hasText:item.key}).click();
      const target=detail(page).locator(`#message-comment-${notification.commentId}`);
      await expect(target).toBeVisible();
      await expect.poll(async()=>(await(await page.request.get(`/api/v1/notifications/${notification.id}`)).json()).readAt).not.toBeNull();
      await expect(page.locator(".message-business-modal")).toHaveCount(0);
      await page.screenshot({path:testInfo.outputPath(`message-${width}-${theme}.png`)});
      if(width<1024){await page.evaluate(()=>history.back());await expect(page.locator(".message-center-body")).not.toHaveClass(/showing-detail/);}
      await page.evaluate(()=>history.back());await expect(center(page)).toHaveCount(0);
      await expect(entry).toBeFocused();await expect(page).toHaveURL(originalUrl);
      expect((await(await page.request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("pending_verification");
      expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"done",reason:"verification_passed"}})).ok()).toBe(true);
    });
  });
}

test("switches details without losing text or the workspace draft, and protects attachments",async({page})=>{
  const first=await seed(page),second=await seed(page);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${first.item.key}`);
  await page.locator("#comment-draft").fill("工作区原草稿");
  await openNotice(page,first.item.key);
  await detail(page).locator("#message-comment-draft").fill("第一条未发送");
  await page.locator(".message-list-row").filter({hasText:second.item.key}).click();
  await expect(detail(page).locator("#message-comment-draft")).toHaveValue("");
  await page.locator(".message-list-row").filter({hasText:first.item.key}).click();
  await expect(detail(page).locator("#message-comment-draft")).toHaveValue("第一条未发送");
  await detail(page).locator('.comment-form input[type="file"]').setInputFiles({name:"draft.log",mimeType:"text/plain",buffer:Buffer.from("synthetic draft")});
  await page.locator(".message-list-row").filter({hasText:second.item.key}).click();
  await expect(center(page).getByRole("button",{name:"继续编辑",exact:true})).toBeFocused();
  await center(page).getByRole("button",{name:"继续编辑",exact:true}).click();
  await expect(detail(page).locator("#message-comment-draft")).toHaveValue("第一条未发送");
  await expect(detail(page).getByText("draft.log",{exact:true})).toBeVisible();
  await page.locator(".message-list-row").filter({hasText:second.item.key}).click();
  await center(page).getByRole("button",{name:"放弃修改",exact:true}).click();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(second.item.key);
  await page.keyboard.press("Escape");await expect(center(page)).toHaveCount(0);
  await expect(page.locator("#comment-draft")).toHaveValue("工作区原草稿");
});

test("discarding attachments also works between two notifications for the same item",async({page})=>{
  const {item,notification}=await seed(page);
  const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
  await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text:"同一条目的另一条提醒",mentionAccountIds:[user.id]}});
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:"同一条目的另一条提醒"}).click();
  await detail(page).locator('.comment-form input[type="file"]').setInputFiles({name:"same-item.log",mimeType:"text/plain",buffer:Buffer.from("synthetic draft")});
  await page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"请核对本次变更"}).click();
  await center(page).getByRole("button",{name:"放弃修改",exact:true}).click();
  await expect(detail(page).locator(`#message-comment-${notification.commentId}`)).toBeVisible();
  await expect(detail(page).getByText("same-item.log",{exact:true})).toHaveCount(0);
});

test("compact related-item Back preserves the original detail and then returns to its list",async({page})=>{
  await page.setViewportSize({width:390,height:900});
  const first=await seed(page),second=await seed(page);
  await page.route(`**/api/v1/items/${first.item.key}`,async route=>{
    const response=await route.fetch();const item=await response.json();
    await route.fulfill({response,json:{...item,derivedItems:[{key:second.item.key,title:second.item.title,status:second.item.status}]}});
  });
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await openNotice(page,first.item.key);
  await detail(page).locator(".item-relation-link").click();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(second.item.key);
  await page.evaluate(()=>history.back());
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(first.item.key);
  await page.evaluate(()=>history.back());
  await expect(center(page)).toBeVisible();
  await expect(page.locator(".message-center-body")).not.toHaveClass(/showing-detail/);
  await page.evaluate(()=>history.back());await expect(center(page)).toHaveCount(0);
});

test("blocks navigation during posting and keeps the current detail when the unread row disappears",async({page})=>{
  const first=await seed(page),second=await seed(page);
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await center(page).getByRole("button",{name:"未读",exact:true}).click();
  await page.locator(".message-list-row").filter({hasText:first.item.key}).click();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(first.item.key);
  await expect(page.locator(".message-list-row").filter({hasText:first.item.key})).toHaveCount(0);
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/items/${first.item.key}/comments`,async route=>{if(route.request().method()==="POST")await pending;await route.continue();});
  await detail(page).locator("#message-comment-draft").fill("发送中保护");
  await detail(page).getByRole("button",{name:"发送",exact:true}).click();
  await expect(center(page)).toHaveAttribute("aria-busy","true");
  await page.locator(".message-list-row").filter({hasText:second.item.key}).click();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(first.item.key);
  await page.evaluate(()=>history.back());await expect(center(page)).toBeVisible();
  release();await expect(center(page)).toHaveAttribute("aria-busy","false");
  await expect(detail(page).locator("#message-comment-draft")).toHaveValue("");
  await page.keyboard.press("Escape");await expect(center(page)).toHaveCount(0);
});

test("does not mark unread until the item and target are available, and ignores stale responses",async({page})=>{
  const first=await seed(page),second=await seed(page);
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/items/${first.item.key}`,async route=>{await pending;await route.continue();});
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await openNotice(page,first.item.key);
  await expect(detail(page).locator(".spin")).toBeVisible();
  expect((await(await page.request.get(`/api/v1/notifications/${first.notification.id}`)).json()).readAt).toBeNull();
  await page.locator(".message-list-row").filter({hasText:second.item.key}).click();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(second.item.key);
  release();
  await expect.poll(async()=>(await(await page.request.get(`/api/v1/notifications/${second.notification.id}`)).json()).readAt).not.toBeNull();
  expect((await(await page.request.get(`/api/v1/notifications/${first.notification.id}`)).json()).readAt).toBeNull();
  await expect(detail(page).locator(".detail-toolbar code")).toHaveText(second.item.key);
});

test("timeline failures preserve unread and retry marks only the rendered notification",async({page})=>{
  const {item,notification}=await seed(page);
  let failing=true;
  await page.route(`**/api/v1/items/${item.key}/timeline`,route=>failing?route.fulfill({status:503,json:{message:"Synthetic timeline unavailable"}}):route.continue());
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await openNotice(page,item.key);
  const retry=detail(page).getByRole("button",{name:"重试",exact:true});
  await expect(retry).toBeVisible({timeout:15000});
  expect((await(await page.request.get(`/api/v1/notifications/${notification.id}`)).json()).readAt).toBeNull();
  failing=false;await retry.click();
  await expect(detail(page).locator(`#message-comment-${notification.commentId}`)).toBeVisible();
  await expect.poll(async()=>(await(await page.request.get(`/api/v1/notifications/${notification.id}`)).json()).readAt).not.toBeNull();
});

test("reveals filtered comments and decision events without changing workspace deep links",async({page})=>{
  const {item,notification}=await seed(page);
  const account=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
  await page.addInitScript(id=>localStorage.setItem(`missiongo.comment-filters.v1:${encodeURIComponent(id)}`,JSON.stringify(["agent"])),account.id);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}&comment=${notification.commentId}`);
  const originalUrl=page.url();
  await openNotice(page,item.key);
  await expect(detail(page).locator(`#message-comment-${notification.commentId}`)).toBeVisible();
  await expect(detail(page).locator(".comment-filter-reveal")).toBeVisible();
  await page.keyboard.press("Escape");await expect(center(page)).toHaveCount(0);
  await expect.poll(()=>[...new URL(page.url()).searchParams].sort()).toEqual([...new URL(originalUrl).searchParams].sort());
  expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"cancelled",reason:"cancelled",note:"用于验证事件定位"}})).ok()).toBe(true);
  const notices=(await(await page.request.get("/api/v1/notifications")).json()).notifications;
  const decision=notices.find((n:any)=>n.itemKey===item.key && n.kind==="decision");
  expect(decision.businessEventId).toBeTruthy();
  await page.getByRole("button",{name:"待处理",exact:true}).click();await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"业务决策"}).click();
  const target=detail(page).locator(`[data-event-id="${decision.businessEventId}"]`);
  await expect(target).toBeVisible();await expect(target).toBeFocused();await expect(target).toContainText("用于验证事件定位");
  await detail(page).getByRole("button",{name:"恢复筛选显示",exact:true}).click();await expect(target).toHaveCount(0);
});

for(const width of [390,1440])test.describe(`attention lifecycle ${width}`,()=>{
  test.use({viewport:{width,height:900},hasTouch:width<1024});
  test("verification updates counts and preserves the completed detail and independent comments",async({page,context})=>{
    const {item}=await seed(page);
    const prior=await(await page.request.get("/api/v1/notifications")).json();
    await page.request.post("/api/v1/notifications/read-all",{data:{throughSequence:prior.throughSequence}});
    const baseline=(await(await page.request.get("/api/v1/attention/count")).json()).count;
    expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
    await page.goto(`/?product=${fixture.productId}&status=all`);
    const other=await context.newPage();await other.clock.install({time:new Date("2026-11-09T12:00:00Z")});await other.goto(`/?product=${fixture.productId}&status=all`);
    const badge=other.locator(".message-unread-badge");await expect(badge).toHaveText(badgeText(baseline+1));
    // AND-494 hides ordinary delivery reminders from the notice list, so a
    // fresh database has nothing unread to mark and the read-all button stays
    // disabled; the mark-all step from AND-493 no longer applies here.
    const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
    await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text:"独立的新评论，请勿清除",mentionAccountIds:[user.id]}});
    await page.getByRole("button",{name:"待处理",exact:true}).click();
    await page.locator(".message-list-row").filter({hasText:item.key}).click();
    await detail(page).getByRole("button",{name:"验证通过",exact:true}).click();
    await expect.poll(async()=>(await(await page.request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("done");
    await expect(detail(page).locator(".detail-toolbar code")).toHaveText(item.key);
    await expect(page.locator(".message-detail-pane > .message-reason")).toContainText("业务状态或你的权限已变化");
    await advanceAttentionPoll(other);await expect(badge).toHaveText(badgeText(baseline+1));
    if(width<1024)await page.getByRole("button",{name:"返回列表",exact:true}).click();
    await page.getByRole("button",{name:/^通知/}).click();
    await expect(page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"交付待验收"})).toHaveCount(0);
    await expect(page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"独立的新评论，请勿清除"})).toContainText("未读");
    await other.close();
  });
});

test("zero attention hides only the badge and keeps history reachable",async({page})=>{
  await page.route("**/api/v1/attention/count",route=>route.fulfill({json:{count:0,todoCount:0,unreadCount:0,coveredUnreadCount:0,todoByProduct:[],unreadByProduct:[]}}));
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await expect(page.locator(".message-unread-badge")).toHaveCount(0);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await expect(page.locator(".message-list-pane")).toBeVisible();
});

test("todo empty and error states support refresh without changing notification read state",async({page})=>{
  await page.route("**/api/v1/attention/todos?*",route=>route.fulfill({json:{todos:[]}}));
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await expect(page.getByText("暂无待办",{exact:true})).toBeVisible();
  const before=await(await page.request.get("/api/v1/notifications/unread-count")).json();
  await page.route("**/api/v1/attention/todos?*",route=>route.fulfill({status:503,json:{message:"synthetic error"}}));
  await page.locator(".message-list-pane").getByRole("button",{name:"刷新",exact:true}).click();
  await expect(page.locator(".message-list-pane [role=alert]")).toBeVisible();
  await page.route("**/api/v1/attention/todos?*",route=>route.fulfill({json:{todos:[]}}));
  await page.locator(".message-list-pane").getByRole("button",{name:"重试",exact:true}).click();
  await expect(page.getByText("暂无待办",{exact:true})).toBeVisible();
  expect(await(await page.request.get("/api/v1/notifications/unread-count")).json()).toEqual(before);
});

test("large attention counts display 99+ with the exact accessible count",async({page})=>{
  await page.route("**/api/v1/attention/count",route=>route.fulfill({json:{count:125,todoCount:125,unreadCount:0,coveredUnreadCount:0,todoByProduct:[{productId:fixture.productId,count:125}],unreadByProduct:[]}}));
  await page.goto(`/?product=${fixture.productId}&status=all`);
  const badge=page.locator(".message-unread-badge");
  await expect(badge).toHaveText("99+");
  await expect(badge).toHaveAttribute("aria-label","125 项待处理");
});

test("keeps counts in the project filter and off the tabs (AND-493)",async({page})=>{
  const {item}=await seed(page);
  expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  const todoTab=page.getByRole("button",{name:/^待办/});
  await expect(todoTab).toHaveText("待办");
  const projectFilter=page.getByRole("combobox",{name:"按项目筛选消息"});
  await expect(projectFilter).toHaveText(/^全部项目( · (\d+|99\+))?$/);
  await projectFilter.click();
  // Every project choice carries its own number; the seeded project holds one.
  await expect(page.locator(`.single-select-option[data-value="${fixture.productId}"]`)).toHaveText(/ · (\d+|99\+)$/);
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:/^通知/}).click();
  await expect(page.getByRole("button",{name:/^通知/})).toHaveText("通知");
  await expect(page.getByRole("combobox",{name:"按项目筛选消息"})).toHaveText(/^全部项目( · (\d+|99\+))?$/);
});
