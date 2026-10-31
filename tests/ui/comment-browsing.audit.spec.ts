import {readFileSync} from "node:fs";
import {expect,test,type Page} from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
async function createItem(page:Page,title:string) {
  return (await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title,description:"",environment:{platform:"web"}}})).json();
}
const url=(key:string)=>`/?product=${fixture.productId}&status=all&item=${key}`;
async function comment(page:Page,key:string,text:string,replyToCommentId?:string) {
  const response=await page.request.post(`/api/v1/items/${key}/comments`,{data:{text,...(replyToCommentId?{replyToCommentId}:{})}});
  expect(response.ok(),await response.text()).toBe(true);return response.json();
}
for(const width of [353,1440])for(const theme of ["light","dark"] as const){
  test.describe(`${width}px ${theme} discussion browsing`,()=>{
    test.use({viewport:{width,height:900},hasTouch:width<640,colorScheme:theme});
    test("filters activity, raises recently replied groups and unfolds a linked reply",async({page})=>{
      const item=await createItem(page,"字段确认与讨论");
      const old=await comment(page,item.key,"请确认：评论提醒应保留明确指定的接收人。"),newer=await comment(page,item.key,"另一组讨论：验证移动端显示。");
      const replies=[];
      for(let i=1;i<=5;i++)replies.push(await comment(page,item.key,`第 ${i} 条回复：已核对这项规则。`,i===2?replies[0].id:old.id));
      await page.goto(url(item.key));
      const groups=page.locator(".comment-discussion"),root=groups.filter({has:page.locator(`#comment-${old.id}`)});
      await expect(groups.first().locator(".comment-thread-root")).toHaveAttribute("id",`comment-${newer.id}`);
      await expect(root.locator(".comment-thread-reply")).toHaveCount(2);
      await expect(page.locator(".timeline-event:not(.timeline-event--comment)")).not.toHaveCount(0);
      const input=page.locator(".comment-form").getByRole("textbox");await input.fill("这条草稿切换视图时应保留");
      await page.getByRole("button",{name:"讨论",exact:true}).click();
      await expect(groups.first().locator(".comment-thread-root")).toHaveAttribute("id",`comment-${old.id}`);
      await expect(page.locator(".timeline-event:not(.timeline-event--comment)")).toHaveCount(0);await expect(input).toHaveValue("这条草稿切换视图时应保留");
      await root.getByRole("button",{name:"展开全部 5 条回复",exact:true}).click();await expect(root.locator(".comment-thread-reply")).toHaveCount(5);
      await root.getByRole("button",{name:"收起回复",exact:true}).click();await expect(root.locator(".comment-thread-reply")).toHaveCount(2);
      await page.goto(`${url(item.key)}&comment=${replies[0].id}`);
      await expect(root.locator(".comment-thread-reply")).toHaveCount(5);
      await expect(page.locator(`#comment-${replies[0].id}`)).toBeFocused();
      await expect(page.locator(".comment-reply-source span")).toHaveText("第 1 条回复：已核对这项规则。");await expect(input).toHaveValue("这条草稿切换视图时应保留");
      await root.getByRole("button",{name:"收起回复",exact:true}).click();await expect(root.locator(".comment-thread-reply")).toHaveCount(2);
      await page.locator(".timeline-head").evaluate(el=>el.scrollIntoView({block:"start"}));await page.screenshot({path:test.info().outputPath(`discussion-browsing-${width}-${theme}.png`)});
      await page.locator(".comment-reply-source").click();await expect(root.locator(".comment-thread-reply")).toHaveCount(5);await expect(page.locator(`#comment-${replies[0].id}`)).toBeFocused();
      await page.getByRole("button",{name:"全部动态",exact:true}).click();
      await expect(groups.first().locator(".comment-thread-root")).toHaveAttribute("id",`comment-${newer.id}`);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    });
    test("restores per-item text, explicit self mentions and reply targets; retains failures and clears successful sends",async({page})=>{
      const user=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
      const first=await createItem(page,"草稿一"),second=await createItem(page,"草稿二"),root=await comment(page,first.key,"请回复这一条问题。");
      await page.goto(url(first.key));const form=page.locator(".comment-form"),input=form.getByRole("textbox");
      await page.locator(`#comment-${root.id}`).getByRole("button",{name:"回复",exact:true}).click();
      await input.fill(`@${user.displayName}`);await page.getByRole("option").filter({hasText:user.displayName}).click();await input.press("End");await input.pressSequentially("确认后通知我");
      const text=await input.inputValue();
      await page.goto(url(second.key));await expect(input).toHaveValue("");await expect(form.locator(".comment-reply-context")).toHaveCount(0);await input.fill("第二个条目的独立草稿");
      await page.goto(url(first.key));await expect(input).toHaveValue(text);await expect(form.locator(".comment-reply-source span")).toHaveText("请回复这一条问题。");
      await page.route(`**/api/v1/items/${first.key}/comments`,route=>route.request().method()==="POST"?route.fulfill({status:503,json:{code:"temporary_failure",title:"暂时无法保存"}}):route.continue());
      await form.getByRole("button",{name:"发送",exact:true}).click();await expect(input).toHaveValue(text);await expect(form.getByRole("alert")).toBeVisible();
      await page.reload();await expect(input).toHaveValue(text);await expect(form.locator(".comment-reply-source span")).toHaveText("请回复这一条问题。");
      await page.unroute(`**/api/v1/items/${first.key}/comments`);await form.getByRole("button",{name:"发送",exact:true}).click();await expect(input).toHaveValue("");
      const saved=(await(await page.request.get(`/api/v1/items/${first.key}/comments`)).json()).comments.at(-1);
      expect(saved.replyToCommentId).toBe(root.id);expect(saved.mentions).toEqual([expect.objectContaining({accountId:user.id})]);
      await page.reload();await expect(input).toHaveValue("");await expect(form.locator(".comment-reply-context")).toHaveCount(0);
      await page.goto(url(second.key));await expect(input).toHaveValue("第二个条目的独立草稿");
    });
  });
}

test("reports unavailable local storage and preserves the current editor",async({page})=>{
  const item=await createItem(page,"存储不可用");await page.goto(url(item.key));
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith("missiongo.comment-draft.v1:"))throw new DOMException("quota","QuotaExceededError");original.call(this,key,value);};});
  const form=page.locator(".comment-form"),input=form.getByRole("textbox");await input.fill("依然可以编辑的内容");await expect(form.getByRole("alert")).toHaveText("草稿暂未保存到本机，请勿关闭页面。");await expect(input).toHaveValue("依然可以编辑的内容");
});

test("restores text while making lost attachment selection explicit",async({page})=>{
  const item=await createItem(page,"附件草稿");await page.goto(url(item.key));const form=page.locator(".comment-form"),input=form.getByRole("textbox");
  await input.fill("包含附件的草稿");await form.locator('input[type="file"]').setInputFiles({name:"draft.txt",mimeType:"text/plain",buffer:Buffer.from("synthetic evidence")});
  page.once("dialog",dialog=>dialog.accept());await page.reload();await expect(input).toHaveValue("包含附件的草稿");
  await expect(form.locator(".agent-chat-draft-files")).toHaveCount(0);await expect(form.getByRole("status")).toContainText("上次选择的附件未恢复，请重新选择。");
  await expect(form.getByRole("button",{name:"发送",exact:true})).toBeDisabled();
  await form.getByRole("button",{name:"不再添加",exact:true}).click();await expect(form.getByRole("status")).toHaveCount(0);
});

test("reuses the persisted send key after a committed comment loses its response",async({page})=>{
  const item=await createItem(page,"回执丢失时的草稿重试");await page.goto(url(item.key));
  const form=page.locator(".comment-form"),input=form.getByRole("textbox");await input.fill("只应保存一次的评论");
  let first=true;
  await page.route(`**/api/v1/items/${item.key}/comments`,async route=>{
    if(route.request().method()==="POST" && first){first=false;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort("failed");}
    else await route.continue();
  });
  await form.getByRole("button",{name:"发送",exact:true}).click();await expect(form.getByRole("alert")).toBeVisible();await expect(input).toHaveValue("只应保存一次的评论");
  await page.reload();await expect(input).toHaveValue("只应保存一次的评论");await form.getByRole("button",{name:"发送",exact:true}).click();await expect(input).toHaveValue("");
  const saved=(await(await page.request.get(`/api/v1/items/${item.key}/comments`)).json()).comments;expect(saved).toHaveLength(1);
});

test("keeps cancelled link replies cancelled when restoring a plain comment draft",async({page})=>{
  const item=await createItem(page,"取消链接回复"),root=await comment(page,item.key,"链接中的原问题");
  await page.goto(`${url(item.key)}&comment=${root.id}`);const form=page.locator(".comment-form"),input=form.getByRole("textbox");
  await expect(form.locator(".comment-reply-context")).toBeVisible();await input.fill("改写为独立评论的草稿");
  await form.getByRole("button",{name:"取消回复",exact:true}).click();await expect(page).not.toHaveURL(/comment=/);await page.reload();
  await expect(input).toHaveValue("改写为独立评论的草稿");await expect(form.locator(".comment-reply-context")).toHaveCount(0);
});

test("keeps a withdrawn reply draft across reload until the author chooses a new comment",async({page})=>{
  const item=await createItem(page,"原评论撤回后的草稿"),root=await comment(page,item.key,"稍后会撤回的问题");
  await page.goto(url(item.key));const form=page.locator(".comment-form"),input=form.getByRole("textbox");
  await page.locator(`#comment-${root.id}`).getByRole("button",{name:"回复",exact:true}).click();await input.fill("仍然需要保留的草稿");
  await page.request.post(`/api/v1/items/${item.key}/comments/${root.id}/withdraw`);await page.reload();
  await expect(input).toHaveValue("仍然需要保留的草稿");await expect(form.getByRole("status")).toContainText("原评论已不可回复，草稿已保留。");
  await expect(form.getByRole("button",{name:"发送",exact:true})).toBeDisabled();await page.reload();
  await expect(form.getByRole("button",{name:"发送",exact:true})).toBeDisabled();
  await form.getByRole("button",{name:"改为新评论",exact:true}).click();await form.getByRole("button",{name:"发送",exact:true}).click();await expect(input).toHaveValue("");
  const saved=(await(await page.request.get(`/api/v1/items/${item.key}/comments`)).json()).comments.at(-1);expect(saved.replyToCommentId).toBeUndefined();expect(saved.body.text).toBe("仍然需要保留的草稿");
});
