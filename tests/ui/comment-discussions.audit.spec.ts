import { readFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
const fixture=JSON.parse(readFileSync(new URL("./.auth/fixture.json",import.meta.url),"utf8")) as {productId:string};
for(const width of [353,1440]) {
  test.describe(`${width}px comment discussions`,()=>{
    test.use({viewport:{width,height:850},hasTouch:width<1000});
    test("selects mentions, removes deleted recipients, replies to specific comments and preserves a flat group after reload",async({page})=>{
      const item=await (await page.request.post("/api/v1/items",{data:{productId:fixture.productId,type:"note",priority:"normal",title:"Discuss a field",description:"",environment:{platform:"web"}}})).json();
      await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
      const composer=page.locator(".comment-form"),input=composer.getByRole("textbox"),send=composer.getByRole("button",{name:"发送",exact:true});
      await input.fill("@所有");await page.getByRole("option",{name:/所有人/}).click();
      await input.press("End");await input.pressSequentially("请解释字段");await send.click();await expect(input).toHaveValue("");
      const comments=await(await page.request.get(`/api/v1/items/${item.key}/comments`)).json();expect(comments.comments[0].mentions?.length).toBeGreaterThan(0);
      const root=page.locator(`#comment-${comments.comments[0].id}`);await root.getByRole("button",{name:"回复",exact:true}).click();
      await expect(composer.locator(".comment-reply-context")).toBeVisible();await input.fill("第一条回复");await send.click();
      const first=page.locator(".comment-thread-reply").filter({hasText:"第一条回复"});await first.getByRole("button",{name:"回复",exact:true}).click();
      await input.fill("回复上一条");await send.click();await expect(page.locator(".comment-discussion")).toHaveCount(1);await expect(page.locator(".comment-thread-reply")).toHaveCount(2);
      await page.reload();await expect(page.locator(".comment-thread-reply")).toHaveCount(2);
      await input.fill("@所有");await page.getByRole("option",{name:/所有人/}).click();await input.fill("独立评论，没有提及");await send.click();
      const final=await(await page.request.get(`/api/v1/items/${item.key}/comments`)).json();expect(final.comments[2].replyToCommentId).toBe(final.comments[1].id);expect(final.comments[3].mentions).toBeUndefined();
      await expect(page.locator(".comment-discussion")).toHaveCount(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.locator(".toast").getByRole("button",{name:"关闭提示"}).click();
      await page.locator(".comment-discussion").filter({hasText:"请解释字段"}).scrollIntoViewIfNeeded();
      await page.screenshot({path:test.info().outputPath(`discussion-${width}.png`)});
      await page.goto(`/?product=${fixture.productId}&item=${item.key}&comment=${final.comments[1].id}`);
      await expect(composer.locator(".comment-reply-context")).toBeVisible();
      await input.fill("来自评论链接的回复");await send.click();
      const linked=await(await page.request.get(`/api/v1/items/${item.key}/comments`)).json();expect(linked.comments.at(-1).replyToCommentId).toBe(final.comments[1].id);
    });
  });
}
