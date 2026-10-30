import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

for (const width of [375,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`${width}px ${theme} Builder delivery`,()=>{
    test.use({viewport:{width,height:1000},hasTouch:width===375,isMobile:width===375,colorScheme:theme});
    test("configures a module, assigns and hands over execution, transfers Builder and filters the list",async({page,request})=>{
      const suffix=`${width}${theme[0]}`;
      const user=(await (await request.get("/api/v1/auth/session")).json()).user;
      const product=await (await request.post("/api/v1/products",{data:{name:`Builder ${suffix}`,keyPrefix:`BD${suffix.toUpperCase()}`}})).json();
      const module=await (await request.post(`/api/v1/products/${product.id}/components`,{data:{name:"Web module",kind:"web"}})).json();
      const member=await (await request.post("/api/v1/accounts",{data:{email:`builder-${suffix}@example.test`,password:randomBytes(18).toString("base64url"),role:"member"}})).json();
      await request.put(`/api/v1/accounts/${member.id}/products`,{data:{permissions:[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]}});
      await page.goto(`/settings/products/${product.id}/components/${module.id}?product=${product.id}`);
      const setting=page.locator(".module-builder-setting");
      await setting.getByRole("combobox",{name:"Web module 默认 Builder"}).selectOption(user.id);
      await setting.getByRole("button",{name:"保存默认 Builder",exact:true}).click();
      await expect(setting.getByRole("button",{name:"保存默认 Builder",exact:true})).toHaveCount(0);
      const item=await (await request.post("/api/v1/items",{data:{productId:product.id,sourceComponentId:module.id,type:"task",priority:"normal",title:"Deliver Builder workflow",description:"Delivery scope",environment:{platform:"web"}}})).json();
      expect(item.builderAccountId).toBe(user.id);
      await request.post("/api/v1/items",{data:{productId:product.id,type:"task",priority:"normal",title:"Unassigned item",description:"No module"}});
      await page.addInitScript(()=>localStorage.setItem("missiongo.locale","en"));
      await page.goto(`/?product=${product.id}&status=inbox`);
      await expect(page.locator(".item-row")).toHaveCount(2);
      await expect(page.getByRole("button",{name:"Switch to English",exact:true})).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("lang","zh-CN");
      await page.getByRole("combobox",{name:"Builder",exact:true}).selectOption("mine");
      await expect(page.locator(".item-row")).toHaveCount(1);
      await expect(page).toHaveURL(/builder=mine/);
      await page.reload();await expect(page.getByRole("combobox",{name:"Builder",exact:true})).toHaveValue("mine");
      await expect(page.locator(".item-row")).toHaveCount(1);
      await page.locator(".item-row-main").click();
      const eyebrow=page.locator(".detail-title-block .eyebrow");
      await expect(eyebrow).toContainText(`Builder ${item.builderName}`);
      await expect(page.getByRole("region",{name:"交付与执行",exact:true})).toHaveCount(0);
      await expect(page.getByRole("button",{name:"安排执行／交接",exact:true})).toHaveCount(0);
      // The assignment entry is hidden for now, so the same API builds the
      // three rounds this test has always checked on screen.
      const first=await (await request.post(`/api/v1/items/${item.key}/executions`,{data:{kind:"human",accountId:user.id,scope:"Implement frontend"}})).json();
      const panel=page.getByRole("region",{name:"执行记录",exact:true});
      await page.reload();
      await expect(panel.locator(".execution-row")).toHaveCount(1);
      const firstExecutionId=first.executions.at(-1).id as string;
      await request.post(`/api/v1/items/${item.key}/executions`,{data:{kind:"human",accountId:member.id,scope:"Finish integration",previousId:firstExecutionId,note:"Frontend ready for integration"}});
      await page.reload();
      await expect(panel.locator(".execution-row")).toHaveCount(2);
      await panel.locator(".execution-history > summary").click();
      await expect(panel.locator(".execution-row").first()).toContainText("已交接");
      const second=panel.locator(".execution-row").nth(1);
      await second.getByText("更新本轮执行",{exact:true}).click();
      await second.getByRole("combobox").selectOption("completed");
      await second.getByLabel("结果／说明",{exact:true}).fill("Integration complete");
      await second.getByRole("button",{name:"保存执行进展",exact:true}).click();
      await expect(second.locator(".execution-heading")).toContainText("本轮完成");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Closing the modal also returns from its same-document history entry.
      await expect.poll(() => page.evaluate(() => history.state?.["missiongo:dialogs"]?.length ?? 0)).toBe(0);
      const delivery=await (await request.get(`/api/v1/items/${item.key}/delivery`)).json();
      const secondExecutionId=delivery.executions.at(-1).id as string;
      await request.post(`/api/v1/items/${item.key}/executions`,{data:{kind:"human",accountId:user.id,scope:"Handle verification feedback",previousId:secondExecutionId,followUp:true,note:"Follow up after verification"}});
      await page.reload();
      await expect(panel.locator(".execution-row")).toHaveCount(3);
      await panel.locator(".execution-history > summary").click();
      await expect(panel.locator(".execution-row").nth(1)).toContainText("Integration complete");
      await expect(panel.locator(".execution-row").nth(1)).toContainText("本轮完成");
      await panel.screenshot({path:test.info().outputPath("builder-executions.png")});
      expect(await panel.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
      await page.locator(".detail-toolbar .detail-more-menu > summary").click();
      await page.getByRole("button",{name:"转交 Builder",exact:true}).click();
      await page.getByLabel("新的 Builder",{exact:true}).selectOption(member.id);
      await page.getByLabel("交接说明",{exact:true}).fill("Take responsibility through verification");
      await page.getByRole("button",{name:"确认转交",exact:true}).click();
      await expect(eyebrow).toContainText(`Builder builder-${suffix}`);
      const stored=await (await request.get(`/api/v1/items/${item.key}`)).json();expect(stored.status).toBe("inbox");
      await page.goto(`/?product=${product.id}&status=inbox&builder=mine`);await expect(page.locator(".item-row")).toHaveCount(0);
      await page.getByRole("combobox",{name:"Builder",exact:true}).selectOption(member.id);await expect(page.locator(".item-row")).toHaveCount(1);
      await page.goto(`/settings/admin/accounts?product=${product.id}&settingsProduct=${product.id}`);
      const row=page.locator(".account-row").filter({hasText:member.email});
      await expect(row.locator(".account-access-permissions dd")).toHaveCount(3);
      await expect(row.locator(".account-access-permissions dd").filter({hasText:"✓"})).toHaveCount(3);
      await expect(row.getByRole("button",{name:"停用",exact:true})).not.toBeVisible();
      await row.locator("summary").click();await expect(row.getByText("以下账号操作影响整个工作空间",{exact:true})).toBeVisible();
      await row.locator("summary").click();
      await page.screenshot({path:test.info().outputPath("account-product-permissions.png")});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    });
  });
}
