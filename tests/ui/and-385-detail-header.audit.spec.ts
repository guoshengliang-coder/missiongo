import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

// AND-385: the work-state messages above the title used to be bare lines of
// text. They now share one ordered, icon-labelled group; the dispatch
// attribution moved below the title because it is context, not identity.
for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 375, height: 812 }]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`AND-385 detail header ${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.name === "phone", isMobile: viewport.name === "phone", colorScheme: theme });

      test("groups work-state messages above the title", async ({ page, request }, testInfo) => {
        const product = await (await request.post("/api/v1/products", { data: { name: `AND385 status ${viewport.name} ${theme}`, keyPrefix: `A3${viewport.name[0]!.toUpperCase()}${theme[0]!.toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}` } })).json();
        const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "bug", priority: "normal", title: "条目详情顶部内容盘点与UI设计优化", description: "顶部状态提示的排版检查", status: "ready", environment: { platform: "shared" } } })).json();
        await page.route(`**/api/v1/items/${item.key}`, async route => {
          if (route.request().method() !== "GET") return route.continue();
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...await response.json(), executionDisposition: "stop_requested", deliveryProgress: "review_required" } });
        });
        await page.route(`**/api/v1/items/${item.key}/delivery`, async route => {
          const response = await route.fetch();
          const data = await response.json();
          delete data.executionBlockers;
          await route.fulfill({ response, json: data });
        });
        await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [] } }));
        await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);

        const status = page.getByRole("region", { name: "条目状态提示" });
        await expect(status).toBeVisible();
        const rows = status.locator(".detail-status-item");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("停止待确认");
        await expect(rows.nth(0)).toHaveClass(/tone-warning/);
        await expect(rows.nth(1)).toContainText("交付关联待复核");
        await expect(rows.nth(1)).toHaveClass(/tone-warning/);
        expect(await rows.locator("svg").count()).toBe(2);
        const title = page.locator(".detail-title-block");
        const statusBox = await status.boundingBox();
        const titleBox = await title.boundingBox();
        expect(statusBox!.y).toBeLessThan(titleBox!.y);
        expect(await page.locator(".detail-scroll").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        const audit = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ sample: string; fontSize: number; contrast: number }> };
        for (const row of audit.text) {
          expect(row.fontSize, row.sample).toBeGreaterThanOrEqual(11);
          expect(row.contrast, row.sample).toBeGreaterThanOrEqual(4.5);
        }
        await page.locator(".detail-pane").screenshot({ path: testInfo.outputPath("status.png") });
      });

      test("keeps attribution below the title", async ({ page, request }, testInfo) => {
        const product = await (await request.post("/api/v1/products", { data: { name: `AND385 dispatch ${viewport.name} ${theme}`, keyPrefix: `A3D${viewport.name[0]!.toUpperCase()}${theme[0]!.toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}` } })).json();
        const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "bug", priority: "normal", title: "带派单的条目详情", description: "检查标题与派单归因的顺序", status: "ready", environment: { platform: "shared" } } })).json();
        const stamp = new Date().toISOString();
        const dispatch = { dispatchId: "and-385-dispatch", itemKey: item.key, itemStatus: "ready", nodeName: "M5", agentKind: "codex", status: "launched", createdAt: stamp };
        await page.route("**/api/v1/dispatches/active", route => route.fulfill({ json: { active: [], latest: [dispatch], current: [dispatch], handlers: [] } }));
        await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [{ id: dispatch.dispatchId, nodeId: "node", ...dispatch, mode: "plan", itemKeys: [item.key] }], current: dispatch } }));
        await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);

        const title = page.locator(".detail-title-block");
        const attribution = page.locator(".detail-dispatch-line");
        await expect(title).toBeVisible();
        await expect(attribution).toBeVisible();
        const order = await page.evaluate(() => {
          const title = document.querySelector(".detail-title-block")!;
          const attribution = document.querySelector(".detail-dispatch-line")!;
          return Boolean(title.compareDocumentPosition(attribution) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        expect(order).toBe(true);
        await expect(attribution).toContainText("Codex · M5");
        expect(await page.locator(".detail-scroll").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await page.locator(".detail-pane").screenshot({ path: testInfo.outputPath("dispatch.png") });
      });
    });
  }
}
