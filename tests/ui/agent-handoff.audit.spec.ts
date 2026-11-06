import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MissionGoStore } from "../../services/server/dist/store.js";

function setup() {
  const data = process.env.MISSIONGO_UI_FIXTURE_DATA;
  if (!data) throw new Error("Isolated UI fixture is required");
  const store = new MissionGoStore(join(data, "missiongo.sqlite"));
  try {
    const product = store.createProduct({name:"Agent handoff entry removal",keyPrefix:`AH${randomUUID().slice(0,6).toUpperCase()}`,createdByAccountId:"ui-fixture"});
    const item = store.createWorkItem({productId:product.id,title:"处理中条目保留执行记录",description:"Remove the entry, preserve execution history",type:"task",priority:"normal",status:"ready",environment:{platform:"web"}});
    store.transitionWorkItem({itemKey:item.key,to:"in_progress",actor:"human",reason:"claim",attribution:{accountId:"ui-fixture"}});
    return {item, product};
  } finally { store.close(); }
}

for (const width of [320,375,1440]) for (const theme of ["light","dark"] as const) test.describe(`Agent handoff entry ${width}px ${theme}`, () => {
  test.use({viewport:{width,height:width===1440?900:812},hasTouch:width<400,isMobile:width<400,colorScheme:theme});
  test("removes the entry while preserving history and pending authorization, without an empty panel", async ({page,request}, info) => {
    const f = setup();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const endpoint = `/api/v1/items/${f.item.key}/delivery`;
    const response = await request.get(endpoint);
    expect(response.ok()).toBeTruthy();
    const delivery = await response.json();
    expect(delivery.canHandoffToAgent).toBe(true);
    await page.goto(`/?product=${f.product.id}&status=in_progress&item=${f.item.key}`);
    const panel = page.getByRole("region", {name:"执行记录",exact:true});
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", {name:"交给 Agent 接手",exact:true})).toHaveCount(0);
    await panel.locator(".execution-history > summary").click();
    await expect(panel.locator(".execution-row")).toHaveCount(delivery.executions.length);
    await panel.locator(".execution-record > summary").first().click();
    await expect(panel.getByRole("button", {name:"更新本轮执行",exact:true})).toBeVisible();
    for (const scale of ["small","medium","large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({path:info.outputPath("agent-handoff-entry-removed.png")});
    // Eligibility alone must not leave an empty execution panel after removal.
    let pending = false;
    await page.route(`**${endpoint}`, route => route.fulfill({json:{...delivery,executions:[],executionBlockers:[],pendingAgentHandoff:pending ? {id:"existing-handoff",createdAt:new Date().toISOString()} : undefined}}));
    await page.reload();
    await expect(page.locator(".detail-title-block")).toContainText(f.item.title);
    await expect(panel).toHaveCount(0);
    // Existing saved authorizations remain visible even without history rows.
    pending = true;
    await page.reload();
    await expect(panel.getByRole("status")).toBeVisible();
    await expect(page.getByRole("button", {name:"交给 Agent 接手",exact:true})).toHaveCount(0);
    const current = await (await request.get(`/api/v1/items/${f.item.key}`)).json();
    expect(current.status).toBe("in_progress");
    expect(errors).toEqual([]);
  });
});
