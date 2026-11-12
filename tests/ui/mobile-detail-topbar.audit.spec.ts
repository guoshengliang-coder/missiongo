import { expect, test } from "@playwright/test";

// On a phone the shell topbar's controls (product switcher, search, attention
// entry) all act on the list. The item detail is a full-screen sub-page with
// its own toolbar, so it keeps one row instead of stacking two 64px bars.
for (const viewport of [
  { name: "phone", width: 375, height: 812 },
  { name: "breakpoint", width: 521, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
]) {
  test.describe(`detail topbar ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true });

    test("keeps exactly one toolbar above the item", async ({ page, request }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-11-12T03:00:00Z"));
      const suffix = `${viewport.name[0]!.toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`;
      const product = await (await request.post("/api/v1/products", { data: { name: `Detail topbar ${viewport.name}`, keyPrefix: `DT${suffix}` } })).json();
      const item = await (await request.post("/api/v1/items", { data: {
        productId: product.id, type: "task", priority: "normal",
        title: "详情页只保留一条操作栏", description: "检查移动端顶部栏", status: "ready",
        environment: { platform: "shared" },
      } })).json();

      await page.goto(`/?product=${product.id}&status=ready&item=${item.key}`);
      await expect(page.locator(".detail-title-block")).toBeVisible();

      const topbar = page.locator(".topbar");
      const toolbar = page.locator(".detail-toolbar");
      await expect(toolbar).toBeVisible();

      if (viewport.name === "phone") {
        await expect(topbar).toBeHidden();
        const toolbarBox = await toolbar.boundingBox();
        expect(toolbarBox!.y).toBeLessThanOrEqual(1);
        const workspaceBox = await page.locator(".workspace.detail-open").boundingBox();
        expect(Math.round(workspaceBox!.height)).toBeGreaterThanOrEqual(viewport.height - 1);
        // The 44px targets survive the single-row layout.
        for (const control of await toolbar.locator("button:visible, summary:visible").all()) {
          const box = await control.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath("detail.png") });

        await page.locator(".detail-back-button").click();
        await expect(topbar).toBeVisible();
        await expect(page.locator(".workspace.detail-open")).toHaveCount(0);
        await expect(page.locator(".list-page")).toBeVisible();
      } else {
        await expect(topbar).toBeVisible();
      }
    });
  });
}
