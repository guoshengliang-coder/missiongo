import {readFileSync} from "node:fs";
import {expect,test,type Page} from "@playwright/test";
import {expectUsableControl} from "./visible-control";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
const viewports=[{width:320,height:812,touch:true},{width:375,height:812,touch:true},{width:812,height:375,touch:true},{width:768,height:1024,touch:true},{width:1180,height:820,touch:true},{width:1280,height:800,touch:false},{width:1440,height:900,touch:false}];
const url=(key:string)=>`/?product=${fixture.productId}&status=all&item=${key}`;
async function seed(page:Page){
  const item=await(await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title:"分类筛选与上下文",description:"",environment:{platform:"web"}}})).json();
  const post=async(text:string,replyToCommentId?:string)=>(await(await page.request.post(`/api/v1/items/${item.key}/comments`,{data:{text,...(replyToCommentId?{replyToCommentId}:{})}})).json());
  const root=await post("原评论：自动检查的完整结论。"),human=await post("人工回复：已经核对实际界面。",root.id),agent=await post("Agent 补充：等待人工验证。",human.id);
  await page.route(`**/api/v1/items/${item.key}/timeline`,async route=>{
    const response=await route.fetch(),data=await response.json();
    for(const event of data.events)if([root.id,agent.id].includes(event.id)){event.actorKind="agent";event.payload.agentName="Codex · 筛选验证";}else if(event.id===human.id)event.accountName="人工验证者";
    await route.fulfill({response,json:data});
  });
  return {item,root,human,agent};
}
for(const viewport of viewports)for(const theme of ["light","dark"] as const){
 test.describe(`comment filters ${viewport.width}px ${theme}`,()=>{
  test.use({viewport,hasTouch:viewport.touch,colorScheme:theme});
  test("filters mixed discussions, preserves context and keeps metadata compact",async({page},info)=>{
    const {item,root,human,agent}=await seed(page);await page.goto(url(item.key));
    const input=page.locator(".comment-form").getByRole("textbox");await input.fill("切换筛选后保留的草稿");
    await expect(page.getByRole("heading",{name:"处理记录",exact:true})).toHaveCount(0);
    const filter=page.getByRole("button",{name:"筛选 3/3",exact:true});await filter.scrollIntoViewIfNeeded();await expectUsableControl(filter,viewport.touch);
    const reply=page.locator(`#comment-${human.id}`);
    for(const scale of ["small","medium","large"]){
      await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
      await expect(reply.locator(".comment-metadata time")).toBeVisible();
      await reply.locator(".comment-reply-author").scrollIntoViewIfNeeded();await expectUsableControl(reply.locator(".comment-reply-author"),viewport.touch);
      const geometry=await reply.locator(".comment-metadata").evaluate(node=>{const time=node.querySelector("time")!.getBoundingClientRect(),target=node.querySelector("button")!.getBoundingClientRect();return {inline:Math.abs((time.top+time.bottom)/2-(target.top+target.bottom)/2)<2,overflow:node.scrollWidth-node.clientWidth};});
      expect(geometry.overflow).toBeLessThanOrEqual(1);if(viewport.width>=375 && viewport.height>400)expect(geometry.inline).toBe(true);
    }
    await filter.click();const dialog=page.getByRole("dialog",{name:"筛选评论与动态"});
    await dialog.getByRole("checkbox",{name:"Agent 评论",exact:true}).uncheck();
    await dialog.getByRole("checkbox",{name:"流转及其他记录",exact:true}).uncheck();
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await expect(page.locator(".comment-message")).toHaveCount(1);await expect(reply).toBeVisible();
    await expect(page.locator(`#comment-${root.id}`)).toHaveCount(0);await expect(page.locator(`#comment-${agent.id}`)).toHaveCount(0);
    await expect(page.locator(".timeline-event:not(.timeline-event--comment)")).toHaveCount(0);
    await page.getByRole("button",{name:/查看上下文/}).first().click();
    const context=page.getByRole("dialog",{name:"原评论",exact:true});await expect(context).toContainText("原评论：自动检查的完整结论。");await context.getByRole("button",{name:"关闭",exact:true}).click();
    await expect(input).toHaveValue("切换筛选后保留的草稿");await expect(page.getByRole("button",{name:/查看上下文/}).first()).toBeFocused();
    await page.getByRole("button",{name:"讨论",exact:true}).click();await expect(page.getByRole("button",{name:"筛选 1/2",exact:true})).toBeVisible();
    await expect(page.locator(".comment-message")).toHaveCount(1);
    await page.locator(".timeline-head").evaluate(el=>el.scrollIntoView({block:"start"}));
    if([375,1440].includes(viewport.width))await page.locator(".timeline-block").screenshot({path:info.outputPath(`filters-${viewport.width}-${theme}.png`)});
    await page.goto(`${url(item.key)}&comment=${agent.id}`);
    await expect(page.locator(`#comment-${agent.id}`)).toBeFocused();await expect(page.locator(".comment-filter-reveal")).toContainText("临时显示");
    await page.getByRole("button",{name:"恢复筛选显示",exact:true}).click();await expect(page.locator(`#comment-${agent.id}`)).toHaveCount(0);
    await page.reload();await expect(page.locator(".comment-message")).toHaveCount(1);await expect(input).toHaveValue("切换筛选后保留的草稿");
    await page.getByRole("button",{name:"讨论",exact:true}).click();await page.getByRole("button",{name:"筛选 1/2",exact:true}).click();await page.getByRole("checkbox",{name:"人工评论",exact:true}).uncheck();await page.getByRole("dialog",{name:"筛选评论与动态"}).getByRole("button",{name:"关闭",exact:true}).click();
    await expect(page.locator(".comment-filter-empty")).toContainText("没有匹配的记录");
    await page.getByRole("button",{name:"显示全部类别",exact:true}).click();await expect(page.locator(".comment-message")).toHaveCount(3);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
 });
}

test("keeps preferences across items, isolates other accounts and reports failed persistence",async({page})=>{
 const first=await seed(page);await page.goto(url(first.item.key));
 const account=(await(await page.request.get("/api/v1/bootstrap")).json()).user;
 await page.evaluate(id=>localStorage.setItem(`missiongo.comment-filters.v1:${encodeURIComponent(id)}`,JSON.stringify(["agent"])),"other-account");
 await page.getByRole("button",{name:"筛选 3/3",exact:true}).click();await page.getByRole("checkbox",{name:"Agent 评论",exact:true}).uncheck();await page.getByRole("dialog",{name:"筛选评论与动态"}).getByRole("button",{name:"关闭",exact:true}).click();
 const second=await seed(page);await page.goto(url(second.item.key));await expect(page.getByRole("button",{name:"筛选 2/3",exact:true})).toBeVisible();
 expect(await page.evaluate(id=>JSON.parse(localStorage.getItem(`missiongo.comment-filters.v1:${encodeURIComponent(id)}`)!),account.id)).toEqual(["human","activity"]);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("missiongo.comment-filters.v1:other-account")!))).toEqual(["agent"]);
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith("missiongo.comment-filters.v1:"))throw new DOMException("quota","QuotaExceededError");original.call(this,key,value);};});
 await page.getByRole("button",{name:"筛选 2/3",exact:true}).click();await page.getByRole("checkbox",{name:"人工评论",exact:true}).uncheck();await expect(page.getByRole("dialog").getByRole("alert")).toContainText("暂未保存");
});

test("refreshes an open context when the source comment is withdrawn",async({page})=>{
 const {item,root}=await seed(page);await page.goto(url(item.key));
 await page.getByRole("button",{name:"筛选 3/3",exact:true}).click();await page.getByRole("checkbox",{name:"Agent 评论",exact:true}).uncheck();await page.getByRole("dialog",{name:"筛选评论与动态"}).getByRole("button",{name:"关闭",exact:true}).click();
 await page.getByRole("button",{name:/查看上下文/}).first().click();const context=page.getByRole("dialog",{name:"原评论",exact:true});await expect(context).toContainText("原评论：自动检查的完整结论。");
 const response=await page.request.post(`/api/v1/items/${item.key}/comments/${root.id}/withdraw`,{data:{}});expect(response.ok()).toBe(true);
 await expect(context.locator(".comment-withdrawn")).toBeVisible({timeout:12000});await expect(context.locator(".comment-withdrawn")).not.toHaveAttribute("open","");await expect(context.locator(".comment-text")).toBeHidden();
});
