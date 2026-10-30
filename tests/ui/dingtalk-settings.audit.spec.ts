import { test,expect } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for(const viewport of [{width:1366,height:950},{width:375,height:812}]) {
  test.describe(`DingTalk settings ${viewport.width}`,()=>{
    test.use({viewport,hasTouch:viewport.width===375,isMobile:viewport.width===375});
    test("persists credentials and bindings, previews imports and configures project notifications",async({page,request},info)=>{
      const suffix=String(viewport.width);
      const account=await (await request.post("/api/v1/accounts",{data:{email:`dingtalk-${suffix}@example.test`,password:"synthetic-notification-password",role:"member"}})).json();
      const product=await (await request.post("/api/v1/products",{data:{name:`Notification project ${suffix}`,keyPrefix:`NT${suffix}`}})).json();
      await page.goto("/settings/admin/dingtalk");
      await page.getByLabel("组织 ID（CorpId）",{exact:true}).fill("synthetic-corp");
      await page.getByLabel("Client ID（AppKey）",{exact:true}).fill("synthetic-app");
      await page.getByLabel("Agent ID",{exact:true}).fill("123");
      await page.getByLabel("Client Secret（AppSecret）",{exact:true}).fill("synthetic-client-secret");
      await page.getByRole("button",{name:"保存钉钉配置",exact:true}).click();
      await expect(page.getByText("钉钉配置已保存。",{exact:true})).toBeVisible();
      await page.reload();await expect(page.getByLabel("Client Secret（AppSecret）",{exact:true})).toHaveValue("");
      await expect(page.getByLabel("组织 ID（CorpId）",{exact:true})).toHaveValue("synthetic-corp");
      const binding=page.locator(".dingtalk-binding").filter({hasText:account.email});
      await binding.locator("summary").click();await binding.getByLabel("钉钉企业用户 ID（userId）",{exact:true}).fill(`employee-${suffix}`);
      await binding.getByLabel("钉钉姓名（选填）",{exact:true}).fill("测试人员");
      await binding.getByRole("button",{name:"保存人员绑定",exact:true}).click();await expect(binding.getByText("人员绑定已保存。",{exact:true})).toBeVisible();
      await page.locator(".dingtalk-section").filter({has:page.locator("summary",{hasText:"批量导入人员绑定"})}).locator("summary").click();
      await page.getByLabel("CSV 内容",{exact:true}).fill(`邮箱,钉钉用户 ID,姓名,部门\n${account.email},employee-${suffix},批量姓名,测试部门\nmissing@example.test,unknown-user,,`);
      await page.getByRole("button",{name:"预览匹配结果",exact:true}).click();await expect(page.getByText("MissionGo 账号不存在",{exact:true})).toBeVisible();
      await expect(page.getByRole("button",{name:"确认导入 2 条绑定",exact:true})).toBeDisabled();
      await page.getByLabel("CSV 内容",{exact:true}).fill(`邮箱,钉钉用户 ID,姓名,部门\n${account.email},employee-${suffix},批量姓名,测试部门`);
      await page.getByRole("button",{name:"预览匹配结果",exact:true}).click();await page.getByRole("button",{name:"确认导入 1 条绑定",exact:true}).click();
      await expect(page.getByText("人员绑定已导入。",{exact:true})).toBeVisible();
      const saved=await (await request.get("/api/v1/dingtalk/bindings")).json();expect(saved.bindings.find((value:{accountId:string})=>value.accountId===account.id)).toMatchObject({name:"批量姓名",userId:`employee-${suffix}`});
      await page.locator(".settings-page-main").evaluate(element=>element.scrollTo({top:0}));
      await page.screenshot({path:info.outputPath("dingtalk-settings.png"),fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{fontSize:number;fontWeight:number;contrast:number}>;targets:Array<{width:number;height:number}>};
      expect(audit.text.filter(value=>value.fontSize>0 && value.fontSize<11)).toEqual([]);
      expect(audit.text.filter(value=>value.contrast<(value.fontSize>=24 || value.fontWeight>=700 && value.fontSize>=18.66?3:4.5))).toEqual([]);
      if(viewport.width===375)expect(audit.targets.filter(value=>value.width>0 && value.height>0 && (value.width<43.99 || value.height<43.99))).toEqual([]);
      await page.goto(`/settings/products/${product.id}/notifications`);
      await page.getByRole("checkbox",{name:"进入待验证时通知提需者",exact:true}).check();await page.getByRole("button",{name:"保存通知设置",exact:true}).click();
      await expect(page.getByText("通知设置已保存。",{exact:true})).toBeVisible();
      await page.reload();await expect(page.getByRole("checkbox",{name:"进入待验证时通知提需者",exact:true})).toBeChecked();
      await page.screenshot({path:info.outputPath("dingtalk-project.png"),fullPage:true});
      await page.getByRole("checkbox",{name:"进入待验证时通知提需者",exact:true}).uncheck();
      await page.locator(".settings-page-header").getByRole("button").click();
      await expect(page.getByRole("dialog")).toBeVisible();await page.getByRole("button",{name:"继续编辑",exact:true}).click();
      await expect(page.getByRole("checkbox",{name:"进入待验证时通知提需者",exact:true})).not.toBeChecked();
    });
  });
}
