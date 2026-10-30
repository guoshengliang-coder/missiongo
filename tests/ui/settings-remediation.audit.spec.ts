import { expect, test } from "@playwright/test";
for (const width of [375, 1440]) {
  test.describe(`${width}px settings remediation`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("previews drafts, cancels without saving, retries failure and saves only on confirmation", async ({ page, request }) => {
      await request.post("/api/v1/auth/font-scale", { data: { fontScale: "medium" } });
      await page.goto("/settings/display");
      await expect(page.locator(".settings-value-row")).toHaveCount(2);
      let writes = 0;
      page.on("request", req => { if (req.method() === "POST" && req.url().includes("/auth/font-scale")) writes++; });
      const row = page.getByRole("button", { name: "字体大小", exact: true });
      await row.click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: "大", exact: true }).click();
      await expect(dialog.locator(".font-scale-preview")).toHaveCSS("font-size", "18px");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect(writes).toBe(0);
      await row.click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: "大", exact: true }).click();
      await page.route("**/api/v1/**", route => route.request().method() === "POST" && route.request().url().endsWith("/auth/font-scale") ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ title: "保存失败" }) }) : route.continue());
      await dialog.getByRole("button", { name: "确认", exact: true }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "大", exact: true })).toHaveAttribute("aria-checked", "true");
      await page.unroute("**/api/v1/**");
      await dialog.getByRole("button", { name: "确认", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toContainText("大");
      await page.reload();
      await expect(row).toContainText("大");
      await page.screenshot({ path: test.info().outputPath("display.png") });
    });
    test("keeps product operations at the list level and supports clearing empty results", async ({ page }) => {
      await page.goto("/settings/products");
      await page.getByRole("searchbox", { name: "搜索产品", exact: true }).fill("no-product-matches");
      await expect(page.locator(".settings-product-card")).toHaveCount(0);
      await page.getByRole("button", { name: "清除筛选", exact: false }).click();
      await page.locator(".settings-product-card").first().click();
      await expect(page.getByRole("combobox", { name: "当前产品", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "添加产品", exact: true })).toHaveCount(0);
      await expect(page.locator(".settings-product-summary")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("product.png") });
    });
  });
}
test("shows the server model and distinguishes failed reads from missing configuration", async ({ page }) => {
  await page.route("**/api/v1/ai/title-settings", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, agentAttentionEnabled: true, model: "fixture-model" }) }));
  await page.goto("/settings/admin/models");
  await expect(page.locator(".model-configuration-status")).toHaveText("已配置");
  await expect(page.getByText("模型: fixture-model", { exact: true })).toBeVisible();
  await page.unroute("**/api/v1/ai/title-settings");
  await page.route("**/api/v1/ai/title-settings", route => route.fulfill({ status: 500, body: "{}" }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("设置加载失败");
  await expect(page.getByText("未配置", { exact: true })).toHaveCount(0);
});
