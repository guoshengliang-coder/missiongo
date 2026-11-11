import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";
import { openConversationFilters, closeConversationFilters, chooseSessionStatus } from "./console-helpers";

for (const width of [320,1440]) for (const theme of ["light","dark"] as const) {
  test.describe(`${width} ${theme}`,()=>{
    test.use({hasTouch:width===320,isMobile:width===320});
    test("AND-435 categories, counts, history and draft isolation",async({page,request},testInfo)=>{
      await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
      const product=await(await request.post("/api/v1/products",{data:{name:"Categories",keyPrefix:`SC${width}${theme[0]}`}})).json();
      await page.clock.setFixedTime(new Date("2026-11-08T10:00:00Z"));
      const stamp="2026-11-08T10:00:00Z";
      const base={agentKind:"codex",status:"idle",createdAt:stamp,updatedAt:stamp,activityAt:stamp,nodeName:"Fixture",nodeConnectionState:"online",
        nodeRevoked:false,mode:"auto",dispatchStatus:"launched",activities:[],canReply:true,canArchive:true,settings:{},unread:false,
        attention:{state:"not_needed"},needsAttention:false,productId:product.id,items:[]};
      const rows=[
        {...base,id:"discussion",agentSessionId:"discussion",sessionName:"集成会话同名普通讨论"},
        {...base,id:"development",agentSessionId:"development",sessionName:"研发任务",items:[{key:"SC-1",title:"研发任务",productId:product.id}]},
        {...base,id:"integration",agentSessionId:"integration",sessionName:"批次任务",sessionPurpose:"integration",status:"active",items:[{key:"SC-2",title:"集成任务",productId:product.id}]},
        {...base,id:"history",agentSessionId:"history",sessionName:"历史批次",sessionPurpose:"integration",archivedAt:stamp},
      ];
      await page.route("**/api/v1/agent-sessions**",route=>{
        const path=new URL(route.request().url()).pathname;
        const row=rows.find(row=>path.endsWith(`/${row.id}`))??rows[0];
        return route.fulfill({json:path==="/api/v1/agent-sessions"?{sessions:rows}:{...row,messages:[]}});
      });
      await page.goto(`/?product=${product.id}&console=agent`);
      const list=page.locator(".agent-console-session"),filter=page.getByRole("combobox",{name:"会话类型筛选",exact:true});
      await expect(list).toHaveCount(3);
      for(const [category,label] of [["unlinked","非派单会话"],["integration","集成会话"]]) {
        await expect(list.locator(`.agent-console-session-meta [data-session-category="${category}"]`)).toHaveText(label!);
      }
      await expect(list.locator('[data-session-category="linked"]')).toHaveCount(0);
      await expect(list.locator(".agent-console-session-heading [data-session-category]")).toHaveCount(0);
      // Purpose must remain distinguishable by both text and color, including
      // inactive and selected rows, without borrowing the run-status meaning.
      const colors = await list.locator("[data-session-category]").evaluateAll(badges => badges.map(badge => {
        const style = getComputedStyle(badge);
        return { category: badge.getAttribute("data-session-category"), color: style.color, background: style.backgroundColor };
      }));
      expect(new Set(colors.map(badge => badge.color)).size).toBe(2);
      expect(new Set(colors.map(badge => badge.background)).size).toBe(2);
      const assertHeaderPalette = async (category: string) => {
        const badge = page.locator(`.agent-console-heading [data-session-category="${category}"]`);
        const palette = colors.find(badge => badge.category === category)!;
        await expect(badge).toHaveCSS("color", palette.color);
        await expect(badge).toHaveCSS("background-color", palette.background);
      };
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        const audit = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ fontSize: number; contrast: number; fontWeight: number }> };
        expect(audit.text.filter(row => row.fontSize > 0 && row.fontSize < 11)).toEqual([]);
        expect(audit.text.filter(row => row.contrast < (row.fontSize >= 24 || (row.fontWeight >= 700 && row.fontSize >= 18.66) ? 3 : 4.5))).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath("all-categories.png"), fullPage: true });
      await openConversationFilters(page);await filter.click();
      await expect(page.getByRole("option",{name:/^全部/})).toHaveAccessibleName(/1 个运行中，共 3 个会话/);
      const integrationOption=page.getByRole("option",{name:/^集成会话/});
      await expect(integrationOption).toHaveAccessibleName(/1 个运行中，共 1 个会话/);
      await integrationOption.click();await closeConversationFilters(page);await expect(list).toHaveCount(1);await expect(list).toContainText("SC-2 · 集成任务");
      await list.click();await expect(page.locator(".agent-console-heading [data-session-category]")).toHaveText("集成会话");
      await assertHeaderPalette("integration");
      const reply=page.locator(".agent-console-reply textarea");await reply.fill("集成草稿");
      for(const scale of ["small","medium","large"]) {
        await page.evaluate(value=>{document.documentElement.dataset.fontScale=value;},scale);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const audit=await page.evaluate(AUDIT_SOURCE) as {text:Array<{fontSize:number;contrast:number;fontWeight:number}>};
        expect(audit.text.filter(row=>row.fontSize>0&&row.fontSize<11)).toEqual([]);
        expect(audit.text.filter(row=>row.contrast<(row.fontSize>=24||(row.fontWeight>=700&&row.fontSize>=18.66)?3:4.5))).toEqual([]);
      }
      await page.screenshot({path:testInfo.outputPath("integration-category.png"),fullPage:true});
      const back=page.getByRole("button",{name:"返回会话列表",exact:true});
      if(width===320)await back.click();
      await openConversationFilters(page);await filter.click();await page.getByRole("option",{name:/^派单会话/}).click();await closeConversationFilters(page);
      await expect(list).toHaveCount(1);await list.click();await expect(page.locator('.agent-console-heading [data-session-category="linked"]')).toHaveText("派单会话");await expect(reply).toHaveValue("");await reply.fill("研发草稿");
      const linkedPalette = await page.locator('.agent-console-heading [data-session-category="linked"]').evaluate(badge => {
        const style = getComputedStyle(badge);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(colors.map(badge => badge.color)).not.toContain(linkedPalette.color);
      expect(colors.map(badge => badge.background)).not.toContain(linkedPalette.background);
      await expect(list.locator('[data-session-category="linked"]')).toHaveCount(0);
      await page.screenshot({path:testInfo.outputPath("dispatched-detail.png"),fullPage:true});
      if(width===320)await back.click();
      await openConversationFilters(page);await filter.click();await page.getByRole("option",{name:/^非派单会话/}).click();await closeConversationFilters(page);await expect(list).toHaveCount(1);
      await expect(list).toContainText("集成会话同名普通讨论");
      await list.click();await assertHeaderPalette("unlinked");
      if(width===320)await back.click();
      await openConversationFilters(page);await filter.click();await page.getByRole("option",{name:/^集成会话/}).click();await closeConversationFilters(page);await list.click();await expect(reply).toHaveValue("集成草稿");
      if(width===320)await back.click();
      if(width===320)await chooseSessionStatus(page,"archived");else await page.getByRole("button",{name:/已归档/}).first().click();
      await expect(list).toHaveCount(1);await expect(list).toContainText("历史批次");
      await expect(list.locator('[data-session-category="integration"]')).toHaveText("集成会话");
    });
  });
}
