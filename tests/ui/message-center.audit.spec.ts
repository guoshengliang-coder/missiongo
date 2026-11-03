import { postItemCommand } from "./item-command";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectUsableControl } from "./visible-control";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
async function seed(page:Page) {
  const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
  const item=await(await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title:"消息中心交互验证 · 很长的业务标题 ".repeat(3),description:"仅测试数据",environment:{platform:"web"}}})).json();
  const posted=await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text:"请核对本次变更，查看消息不会改变条目状态。\n长内容测试 ".repeat(12),mentionAccountIds:[user.id]}});
  expect(posted.ok()).toBe(true);
  const notification=(await(await page.request.get("/api/v1/notifications")).json()).notifications.find((n:any)=>n.itemKey===item.key);
  return {item,notification};
}
for(const width of [320,390,736,1024,1440])for(const theme of ["light","dark"] as const){
  test.describe(`messages ${width}px ${theme}`,()=>{
    test.use({viewport:{width,height:width===736?414:900},hasTouch:width<1024,colorScheme:theme});
    test("keeps search and messages reachable, reads one and returns through the same context",async({page},testInfo)=>{
      const {item,notification}=await seed(page);
      expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
      await page.goto(`/?product=${fixture.productId}&status=all`);
      const entry=page.getByRole("button",{name:"待处理",exact:true});
      for(const scale of ["small","medium","large"]){
        await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
        await expectUsableControl(entry,width<1024);
        await expectUsableControl(page.getByRole("button",{name:"搜索条目…",exact:true}),width<1024);
      }
      const before=await entry.boundingBox();
      await page.getByRole("button",{name:"搜索条目…",exact:true}).click();
      const search=page.getByRole("textbox",{name:"搜索条目…",exact:true});
      await expect(search).toBeFocused();await search.fill(item.key);
      if(width>=1024){const after=await entry.boundingBox();expect(Math.abs(after!.x-before!.x)).toBeLessThanOrEqual(1);}
      await page.keyboard.press("Escape");await expect(search).toHaveCount(0);
      await expect(page.getByText(`搜索：${item.key}`,{exact:false}).first()).toBeVisible();
      const originalUrl=page.url();
      const count=(await(await page.request.get("/api/v1/notifications/unread-count")).json()).count;
      await entry.click();
      await expect(page.getByRole("button",{name:/^待办/})).toHaveAttribute("aria-pressed","true");
      await page.locator(".message-list-row").filter({hasText:item.key}).click();
      await expectUsableControl(page.getByRole("button",{name:"前往验证",exact:true}),width<1024);
      await expect(page.getByRole("button",{name:"标为已读",exact:true})).toHaveCount(0);
      await page.screenshot({path:testInfo.outputPath(`todo-${width}-${theme}.png`)});
      if(width<1024)await page.getByRole("button",{name:"返回列表",exact:true}).click();
      await page.getByRole("button",{name:/^通知/}).click();
      const center=page.locator(".message-center-layer");await expect(center).toBeVisible();
      expect((await(await page.request.get("/api/v1/notifications/unread-count")).json()).count).toBe(count);
      if(width<1024){const box=await page.locator(".message-center-panel").boundingBox();expect(box!.width).toBe(width);}
      await page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"评论 @"}).click();
      await expect.poll(async()=>(await(await page.request.get(`/api/v1/notifications/${notification.id}`)).json()).readAt).not.toBeNull();
      await expectUsableControl(page.getByRole("button",{name:"前往评论 / 回复",exact:true}),width<1024);
      await page.screenshot({path:testInfo.outputPath(`message-${width}-${theme}.png`)});
      await page.getByRole("button",{name:"前往评论 / 回复",exact:true}).click();
      const business=page.locator(".message-business-modal");await expect(business).toBeVisible();
      await expect(business.locator(`#message-comment-${notification.commentId}`)).toBeVisible();
      await page.evaluate(()=>history.back());await expect(business).toHaveCount(0);
      await expect(center).toBeVisible();
      if(width<1024){if(theme==="light")await page.getByRole("button",{name:"返回列表",exact:true}).click();else await page.evaluate(()=>history.back());await expect(page.locator(".message-center-body")).not.toHaveClass(/showing-detail/);}
      await page.evaluate(()=>history.back());await expect(center).toHaveCount(0);
      await expect(entry).toBeFocused();await expect(page).toHaveURL(originalUrl);
      expect((await(await page.request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("pending_verification");
      expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"done",reason:"verification_passed"}})).ok()).toBe(true);
    });
  });
}
test("empty, failure and unavailable message do not silently clear unread",async({page})=>{
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.route("**/api/v1/notifications?*",route=>route.fulfill({json:{notifications:[],throughSequence:0,unreadCount:0}}));
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();await expect(page.getByText("暂无消息",{exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".message-center-layer")).toHaveCount(0);
  await page.route("**/api/v1/notifications?*",route=>route.fulfill({status:503,json:{message:"synthetic error"}}));
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();await expect(page.locator(".message-list-pane [role=alert]")).toBeVisible();
});

test("keeps the original composer and focuses the matching comment inside the message modal",async({page})=>{
  const {item,notification}=await seed(page);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  await page.locator("#comment-draft").fill("工作区未发送的原草稿");
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:item.key}).click();
  await page.getByRole("button",{name:"前往评论 / 回复",exact:true}).click();
  const business=page.locator(".message-business-modal");
  const comment=business.locator(`#message-comment-${notification.commentId}`);
  await expect(comment).toBeFocused();
  await comment.getByRole("button",{name:"回复",exact:true}).click();
  const composer=business.locator("#message-comment-draft");
  await expect(composer).toBeFocused();await expect(composer).toHaveValue("");
  await composer.fill("消息中心独立回复草稿");
  await page.keyboard.press("Escape");await expect(business).toHaveCount(0);
  await page.keyboard.press("Escape");await expect(page.locator(".message-center-layer")).toHaveCount(0);
  await expect(page.locator("#comment-draft")).toHaveValue("工作区未发送的原草稿");
});

test("protects pending submissions and attachment drafts in the reused business modal",async({page})=>{
  const {item}=await seed(page);await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:item.key}).click();
  await page.getByRole("button",{name:"前往评论 / 回复",exact:true}).click();
  const business=page.locator(".message-business-modal"),composer=business.locator(".comment-form");
  await composer.locator('input[type="file"]').setInputFiles({name:"draft.log",mimeType:"text/plain",buffer:Buffer.from("synthetic draft")});
  await page.keyboard.press("Escape");
  await expect(business.getByRole("button",{name:"继续编辑",exact:true})).toBeVisible();
  await expect(composer).toBeHidden();
  await business.getByRole("button",{name:"继续编辑",exact:true}).click();
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/items/${item.key}/comments`,async route=>{if(route.request().method()==="POST")await pending;await route.continue();});
  await composer.getByRole("textbox").fill("带附件的测试回复");
  await composer.getByRole("button",{name:"发送",exact:true}).click();
  await expect(business).toHaveAttribute("aria-busy","true");
  await page.evaluate(()=>history.back());await expect(business).toBeVisible();
  await expect(business.getByRole("button",{name:"关闭",exact:true})).toBeDisabled();
  release();await expect(business).toHaveAttribute("aria-busy","false");
  await expect(composer.getByRole("textbox")).toHaveValue("");
  await page.keyboard.press("Escape");await expect(business).toHaveCount(0);
});

test("reveals a filtered notification target without clearing the underlying comment link",async({page})=>{
  const {item,notification}=await seed(page);
  const account=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
  await page.addInitScript(id=>localStorage.setItem(`missiongo.comment-filters.v1:${encodeURIComponent(id)}`,JSON.stringify(["agent"])),account.id);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}&comment=${notification.commentId}`);
  const originalParameters=[...new URL(page.url()).searchParams].sort(),original=page.locator(`#comment-${notification.commentId}`);
  await expect(original).toBeFocused();
  await page.locator("#comment-draft").fill("筛选前的工作区草稿");
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.locator(".message-list-row").filter({hasText:item.key}).click();
  await page.getByRole("button",{name:"前往评论 / 回复",exact:true}).click();
  const business=page.locator(".message-business-modal"),target=business.locator(`#message-comment-${notification.commentId}`);
  await expect(target).toBeFocused();
  await expect(business.locator(".comment-filter-reveal")).toBeVisible();
  await business.getByRole("button",{name:"恢复筛选显示",exact:true}).click();
  await expect(target).toHaveCount(0);
  await expect.poll(()=>[...new URL(page.url()).searchParams].sort()).toEqual(originalParameters);
  await page.keyboard.press("Escape");await expect(business).toHaveCount(0);
  await page.keyboard.press("Escape");await expect(page.locator(".message-center-layer")).toHaveCount(0);
  await expect(original).toBeVisible();await expect(page.locator("#comment-draft")).toHaveValue("筛选前的工作区草稿");
});

test("all-read updates another tab, preserves tasks, and search shortcuts retain the filter",async({page,context})=>{
  await seed(page);await page.goto(`/?product=${fixture.productId}&status=all`);
  const other=await context.newPage();await other.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"待处理",exact:true}).click();
  await page.getByRole("button",{name:/^通知/}).click();
  await page.getByRole("button",{name:"将当前筛选内的消息全部标为已读",exact:true}).click();
  const pending=(await(await page.request.get("/api/v1/attention/count")).json()).todoCount;
  if(pending)await expect(other.locator(".message-unread-badge")).toHaveText(String(pending),{timeout:10000});
  else await expect(other.locator(".message-unread-badge")).toHaveCount(0,{timeout:10000});
  await expect(other.getByRole("button",{name:"待处理",exact:true})).toBeVisible();
  await page.locator(".message-center-header").getByRole("button",{name:"关闭",exact:true}).click();
  await expect(page.getByRole("button",{name:"待处理",exact:true})).toBeFocused();
  await page.keyboard.press("Control+k");const search=page.getByRole("textbox",{name:"搜索条目…",exact:true});
  await expect(search).toBeFocused();await search.fill("通知测试");
  await page.keyboard.press("Tab");await page.keyboard.press("Escape");await expect(search).toHaveCount(0);
  await expect(page.getByText("搜索：通知测试",{exact:false}).first()).toBeVisible();
  await other.close();
});

for(const width of [390,1440])test.describe(`attention lifecycle ${width}`,()=>{
  test.use({viewport:{width,height:900},hasTouch:width<1024});
  test("read-all preserves pending work and human verification clears only the linked prompt across tabs",async({page,context})=>{
    const {item}=await seed(page);
    const prior=await(await page.request.get("/api/v1/notifications")).json();
    await page.request.post("/api/v1/notifications/read-all",{data:{throughSequence:prior.throughSequence}});
    const baseline=(await(await page.request.get("/api/v1/attention/count")).json()).count;
    expect((await postItemCommand(page.request,`/api/v1/items/${item.key}/transitions`,{data:{to:"pending_verification",reason:"manual_override"}})).ok()).toBe(true);
    await page.goto(`/?product=${fixture.productId}&status=all`);
    const other=await context.newPage();await other.goto(`/?product=${fixture.productId}&status=all`);
    const badge=other.locator(".message-unread-badge");await expect(badge).toHaveText(String(baseline+1));
    await page.getByRole("button",{name:"待处理",exact:true}).click();
    await expect(page.getByRole("button",{name:/^待办/})).toHaveAttribute("aria-pressed","true");
    await page.getByRole("button",{name:/^通知/}).click();
    await page.getByRole("button",{name:"将当前筛选内的消息全部标为已读",exact:true}).click();
    await expect.poll(async()=>(await(await page.request.get("/api/v1/attention/count")).json())).toEqual({count:baseline+1,todoCount:baseline+1,unreadCount:0,coveredUnreadCount:0});
    await expect(badge).toHaveText(String(baseline+1));
    const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
    await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text:"独立的新评论，请勿清除",mentionAccountIds:[user.id]}});
    await expect(badge).toHaveText(String(baseline+2),{timeout:10000});
    await page.getByRole("button",{name:/^待办/}).click();
    await page.locator(".message-list-row").filter({hasText:item.key}).click();
    await page.getByRole("button",{name:"前往验证",exact:true}).click();
    const business=page.locator(".message-business-modal");await expect(business).toBeVisible();
    await business.getByRole("button",{name:"验证通过",exact:true}).click();
    await expect.poll(async()=>(await(await page.request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("done");
    await page.evaluate(()=>history.back());await expect(business).toHaveCount(0);
    await expect(badge).toHaveText(String(baseline+1),{timeout:10000});
    await expect(page.getByText("这项待办已不在待处理范围",{exact:true})).toBeVisible();
    if(width<1024)await page.getByRole("button",{name:"返回列表",exact:true}).click();
    await page.getByRole("button",{name:/^通知/}).click();
    await expect(page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"交付待验收"})).toContainText("已结束");
    const comment=page.locator(".message-list-row").filter({hasText:item.key}).filter({hasText:"独立的新评论，请勿清除"});await expect(comment).toContainText("未读");
    await comment.click();
    if(baseline)await expect(badge).toHaveText(String(baseline),{timeout:10000});
    else await expect(badge).toHaveCount(0,{timeout:10000});
    await expect(other.getByRole("button",{name:"待处理",exact:true})).toBeVisible();
    await other.close();
  });
});

test("zero attention hides only the badge and keeps history reachable",async({page})=>{
  await page.route("**/api/v1/attention/count",route=>route.fulfill({json:{count:0,todoCount:0,unreadCount:0,coveredUnreadCount:0}}));
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
