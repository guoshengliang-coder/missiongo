import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [375,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`${width}px ${theme} project administrators`,()=>{
    test.use({viewport:{width,height:1000},hasTouch:width===375,isMobile:width===375,colorScheme:theme});
    test("grants a project role, manages module and item Builders, then revokes it",async({page,request,browser})=>{
      const suffix=`${width}${theme}`;
      const product=await (await request.post("/api/v1/products",{data:{name:`Project role ${suffix}`,keyPrefix:`PA${width}${theme[0]!.toUpperCase()}`}})).json();
      const module=await (await request.post(`/api/v1/products/${product.id}/components`,{data:{name:"Delivery module",kind:"web"}})).json();
      const password=randomBytes(18).toString("base64url");
      const manager=await (await request.post("/api/v1/accounts",{data:{email:`manager-${suffix}@example.test`,password,role:"member"}})).json();
      const builder=await (await request.post("/api/v1/accounts",{data:{email:`candidate-${suffix}@example.test`,password:randomBytes(18).toString("base64url"),role:"member"}})).json();
      await request.put(`/api/v1/accounts/${builder.id}/products`,{data:{permissions:[{productId:product.id,canView:true,canOperate:true,canUseAi:true}]}});
      const item=await (await request.post("/api/v1/items",{data:{productId:product.id,type:"task",priority:"normal",title:"Needs a delivery owner",description:"Project role test"}})).json();
      await page.goto(`/settings/admin/project-administrators/${product.id}?product=${product.id}`);
      await expect(page.getByRole("heading",{level:1})).toHaveText("项目管理员");
      const choice=page.getByRole("checkbox",{name:new RegExp(manager.email)});
      await choice.check();
      await page.getByRole("button",{name:"保存项目管理员",exact:true}).click();
      await expect(page.getByRole("status")).toHaveText("项目管理员已保存");
      await page.reload();await expect(choice).toBeChecked();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      const audit=await page.evaluate(AUDIT_SOURCE) as {targets:Array<{width:number;height:number}>;text:Array<{fontSize:number;fontWeight:number;contrast:number}>};
      expect(audit.text.filter(row=>row.fontSize>0 && row.fontSize<11)).toEqual([]);
      expect(audit.text.filter(row=>row.contrast<(row.fontSize>=24 || row.fontWeight>=700 && row.fontSize>=18.66 ? 3 : 4.5))).toEqual([]);
      if(width===375) expect(audit.targets.filter(row=>row.width>0 && row.height>0 && (row.width<43.99 || row.height<43.99))).toEqual([]);
      await page.screenshot({path:test.info().outputPath("project-administrators.png"),fullPage:true});
      const baseURL=new URL(page.url()).origin;
      const context=await browser.newContext({baseURL,viewport:{width,height:1000},hasTouch:width===375,isMobile:width===375,colorScheme:theme,storageState:{cookies:[],origins:[]}});
      try {
        expect((await context.request.post("/api/v1/auth/login",{data:{username:manager.email,password}})).ok()).toBe(true);
        const memberPage=await context.newPage();
        await memberPage.goto(`/settings/products/${product.id}?product=${product.id}`);
        await expect(memberPage.locator(".settings-hub-row").filter({hasText:"Builder 分配"})).toBeVisible();
        await memberPage.locator(".settings-hub-row").filter({hasText:"Builder 分配"}).click();
        const defaults=memberPage.getByRole("region",{name:"模块 Builder 分配"});
        await defaults.getByRole("combobox",{name:"Delivery module 默认 Builder",exact:true}).selectOption(builder.id);
        await defaults.getByRole("button",{name:"保存默认 Builder",exact:true}).click();
        await expect(defaults.getByRole("button",{name:"保存默认 Builder",exact:true})).toHaveCount(0);
        expect((await (await request.get(`/api/v1/products/${product.id}/components`)).json()).find((row:{id:string})=>row.id===module.id).defaultBuilderAccountId).toBe(builder.id);
        await memberPage.goto(`/?product=${product.id}&item=${item.key}`);
        const eyebrow=memberPage.locator(".detail-title-block .eyebrow");
        await expect(eyebrow).toContainText("Builder 待分配");
        await expect(memberPage.getByRole("region",{name:"交付与执行",exact:true})).toHaveCount(0);
        await expect(memberPage.getByRole("button",{name:"安排执行／交接",exact:true})).toHaveCount(0);
        await memberPage.locator(".detail-toolbar .detail-more-menu > summary").click();
        await memberPage.getByRole("button",{name:"转交 Builder",exact:true}).click();
        await memberPage.getByRole("combobox",{name:"新的 Builder",exact:true}).selectOption(builder.id);
        await memberPage.getByLabel("交接说明",{exact:true}).fill("Project administrator allocates responsibility");
        await memberPage.getByRole("button",{name:"确认转交",exact:true}).click();
        await expect(eyebrow).toContainText(`Builder candidate-${suffix}`);
        await memberPage.screenshot({path:test.info().outputPath("project-admin-builder.png"),fullPage:true});
        await choice.uncheck();await page.getByRole("button",{name:"保存项目管理员",exact:true}).click();
        await expect(page.getByRole("status")).toHaveText("项目管理员已保存");
        expect((await context.request.get(`/api/v1/items/${item.key}/delivery`)).status()).toBe(404);
        expect((await (await context.request.get("/api/v1/products")).json())).toEqual([]);
        await memberPage.goto(`/settings/admin/project-administrators/${product.id}`);
        await expect(memberPage.getByRole("button",{name:"保存项目管理员",exact:true})).toHaveCount(0);
      } finally { await context.close(); }
    });
  });
}
