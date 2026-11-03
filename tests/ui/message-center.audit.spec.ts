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
      await page.goto(`/?product=${fixture.productId}&status=all`);
      const entry=page.getByRole("button",{name:"消息",exact:true});
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
      const center=page.locator(".message-center-layer");await expect(center).toBeVisible();
      expect((await(await page.request.get("/api/v1/notifications/unread-count")).json()).count).toBe(count);
      if(width<1024){const box=await page.locator(".message-center-panel").boundingBox();expect(box!.width).toBe(width);}
      await page.locator(".message-list-row").filter({hasText:item.key}).click();
      await expect.poll(async()=>(await(await page.request.get(`/api/v1/notifications/${notification.id}`)).json()).readAt).not.toBeNull();
      await expectUsableControl(page.getByRole("button",{name:"前往评论 / 回复",exact:true}),width<1024);
      await page.screenshot({path:testInfo.outputPath(`message-${width}-${theme}.png`)});
      await page.getByRole("button",{name:"前往评论 / 回复",exact:true}).click();
      const business=page.locator(".message-business-modal");await expect(business).toBeVisible();
      await expect(business.locator(`#message-comment-${notification.commentId}`)).toBeVisible();
      await page.evaluate(()=>history.back());await expect(business).toHaveCount(0);
      await expect(center).toBeVisible();
      if(width<1024){if(theme==="light")await page.getByRole("button",{name:"返回消息列表",exact:true}).click();else await page.evaluate(()=>history.back());await expect(page.locator(".message-center-body")).not.toHaveClass(/showing-detail/);}
      await page.evaluate(()=>history.back());await expect(center).toHaveCount(0);
      await expect(entry).toBeFocused();await expect(page).toHaveURL(originalUrl);
      expect((await(await page.request.get(`/api/v1/items/${item.key}`)).json()).status).toBe(item.status);
    });
  });
}
test("empty, failure and unavailable message do not silently clear unread",async({page})=>{
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await page.route("**/api/v1/notifications?*",route=>route.fulfill({json:{notifications:[],throughSequence:0,unreadCount:0}}));
  await page.getByRole("button",{name:"消息",exact:true}).click();await expect(page.getByText("暂无消息",{exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await page.route("**/api/v1/notifications?*",route=>route.fulfill({status:503,json:{message:"synthetic error"}}));
  await page.getByRole("button",{name:"消息",exact:true}).click();await expect(page.locator(".message-list-pane [role=alert]")).toBeVisible();
});

test("keeps the original composer and focuses the matching comment inside the message modal",async({page})=>{
  const {item,notification}=await seed(page);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  await page.locator("#comment-draft").fill("工作区未发送的原草稿");
  await page.getByRole("button",{name:"消息",exact:true}).click();
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
  await page.getByRole("button",{name:"消息",exact:true}).click();
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
  await page.getByRole("button",{name:"消息",exact:true}).click();
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

test("all-read updates another tab, keeps the zero badge entry, and search shortcuts retain the filter",async({page,context})=>{
  await seed(page);await page.goto(`/?product=${fixture.productId}&status=all`);
  const other=await context.newPage();await other.goto(`/?product=${fixture.productId}&status=all`);
  await page.getByRole("button",{name:"消息",exact:true}).click();
  await page.getByRole("button",{name:"将当前筛选内的消息全部标为已读",exact:true}).click();
  await expect(other.locator(".message-unread-badge")).toHaveCount(0,{timeout:10000});
  await expect(other.getByRole("button",{name:"消息",exact:true})).toBeVisible();
  await page.locator(".message-center-header").getByRole("button",{name:"关闭",exact:true}).click();
  await expect(page.getByRole("button",{name:"消息",exact:true})).toBeFocused();
  await page.keyboard.press("Control+k");const search=page.getByRole("textbox",{name:"搜索条目…",exact:true});
  await expect(search).toBeFocused();await search.fill("通知测试");
  await page.keyboard.press("Tab");await page.keyboard.press("Escape");await expect(search).toHaveCount(0);
  await expect(page.getByText("搜索：通知测试",{exact:false}).first()).toBeVisible();
  await other.close();
});
