import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`AND-367 dependency module ${width} ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, isMobile: width === 320, colorScheme: theme });
    test("empty, drafts, history and restricted relationships retain independent disclosures and accessible actions", async ({ page, request }, info) => {
      const response = await request.post("/api/v1/items", { data: {
        productId: fixture.productId, type: "requirement", priority: "normal", status: "ready",
        title: "协作模块布局", description: "Dependency module regression", environment: { platform: "web" },
      } });
      expect(response.ok(), await response.text()).toBe(true);
      const item = await response.json();
      const draft = { id: "draft-1", version: 1, grantId: "grant", title: "等待人工审核的协作草稿", description: "Shared context", acceptance: "Acceptance", attachmentIds: [], type: "requirement", priority: "normal" };
      const relation = (id: string, direction: string, status: string) => ({
        id, revision: 1, direction, sourceKey: `SOURCE-${id}`, targetKey: `TARGET-${id}`,
        targetTitle: "长标题与 Long collaboration title ".repeat(4), sourceProductName: "提需项目", targetProductName: "接收项目",
        builderName: "接收方 Builder", verifierName: "提需方验收人", verifierAccountId: "verifier", status, blocking: status === "ready", withdrawn: false,
      });
      let context: Record<string, unknown> = { blocked: false, requests: [], drafts: [], canRequest: true };
      await page.route(`**/api/v1/items/${item.key}/collaboration`, route => route.fulfill({ json: context }));
      // The form still uses the normal API and shared Modal; only the available
      // targets are empty so this display-focused fixture cannot submit a request.
      await page.route(`**/api/v1/items/${item.key}/collaboration/targets`, route => route.fulfill({ json: { targets: [] } }));
      await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
      const panel = page.getByRole("region", { name: "协作与依赖", exact: true });
      const add = panel.locator(".collaboration-add-menu > summary");
      await expect(add).toBeVisible();
      await expect(panel).not.toContainText("暂无协作依赖");
      await expect(panel.getByRole("heading")).toHaveText("协作与依赖");
      await expect(panel.getByRole("button", { name: "展开", exact: true })).toHaveCount(0);
      await add.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("button", { name: "发起协作请求", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      await add.click();
      await panel.getByRole("button", { name: "关联已有条目", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "关联已有条目", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
      await add.click();
      await panel.getByRole("button", { name: "发起协作请求", exact: true }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "发起协作请求", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
      await panel.screenshot({ path: info.outputPath("empty-module.png") });

      context = { ...context, drafts: [draft] };
      await page.reload();
      await expect(panel.getByText("待审核 1", { exact: true })).toBeVisible();
      await expect(panel.getByRole("heading").first()).toHaveText("协作与依赖");
      await expect(panel.locator(".collaboration-body")).toBeHidden();
      await panel.getByRole("button", { name: "展开", exact: true }).click();
      await expect(panel.getByRole("button", { name: "审核草稿", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "审核草稿", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("heading", { name: draft.title, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      context = { blocked: true, canRequest: true, drafts: [draft], requests: [
        relation("1", "outgoing", "ready"), relation("2", "outgoing", "done"),
        { ...relation("3", "incoming", "cancelled"), withdrawn: true },
        { id: "restricted", revision: 1, direction: "outgoing", restricted: true, blocking: true, canManageAccess: false, canWithdraw: false },
      ] };
      await page.reload();
      await expect(panel.getByRole("heading").first()).toHaveText("协作与依赖（4）");
      await expect(panel.getByText("待审核 1", { exact: true })).toBeVisible();
      await expect(panel.getByRole("status")).toContainText("暂不能推进交付");
      await expect(panel.locator(".collaboration-body")).toBeHidden();
      const expand = panel.getByRole("button", { name: "展开", exact: true });
      await expand.focus();
      await page.keyboard.press("Enter");
      await expect(panel.locator(".collaboration-record")).toHaveCount(4);
      for (const body of await panel.locator(".collaboration-record-body").all()) await expect(body).toBeHidden();
      const first = panel.locator(".collaboration-record").filter({ hasText: "TARGET-1" });
      await first.locator(":scope > summary").focus();
      await page.keyboard.press("Space");
      await expect(first.locator(".collaboration-record-body")).toBeVisible();
      await expect(panel.locator(".collaboration-record").filter({ hasText: "TARGET-2" }).locator(".collaboration-record-body")).toBeHidden();
      await expect(panel.locator(".collaboration-record > summary").filter({ hasText: "TARGET-2" })).toContainText("已完成");
      const restricted = panel.locator(".collaboration-record").filter({ hasText: "共享访问已撤销" });
      await restricted.locator(":scope > summary").click();
      await expect(restricted.getByRole("button")).toHaveCount(0);
      await expect(restricted).not.toContainText("undefined");
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => document.documentElement.dataset.fontScale = value, scale);
        expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        const controls = panel.locator(".collaboration-heading-actions > button, .collaboration-add-menu > summary");
        for (const control of await controls.all()) {
          const box = await control.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
      }
      const audit = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ fontSize: number; contrast: number; fontWeight: number }> };
      expect(audit.text.filter(row => row.fontSize > 0 && row.fontSize < 11)).toEqual([]);
      expect(audit.text.filter(row => row.contrast < (row.fontSize >= 24 || (row.fontWeight >= 700 && row.fontSize >= 18.66) ? 3 : 4.5))).toEqual([]);
      // Fit the full expanded module for review without the persistent toolbar
      // and composer covering content in a tall locator screenshot.
      await page.setViewportSize({ width, height: 2000 });
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: info.outputPath("expanded-module.png") });
      await panel.getByRole("button", { name: "收起", exact: true }).click();
      await expect(panel.locator(".collaboration-body")).toBeHidden();
      await expect(panel.getByRole("status")).toBeVisible();
      await panel.screenshot({ path: info.outputPath("collapsed-module.png") });

      await page.setViewportSize({ width, height: 375 });
      await add.click();
      const menu = panel.locator(".collaboration-add-menu .detail-more-menu-popover");
      await expect(menu).toBeVisible();
      const menuBounds = await menu.evaluate(el => {
        const box = el.getBoundingClientRect();
        const area = el.closest(".detail-scroll")!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, areaTop: area.top, areaBottom: area.bottom };
      });
      expect(menuBounds.top).toBeGreaterThanOrEqual(menuBounds.areaTop);
      expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.areaBottom);
      expect(menuBounds.left).toBeGreaterThanOrEqual(0);
      expect(menuBounds.right).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();

      context = { ...context, canRequest: false };
      await page.reload();
      await expect(panel.getByRole("heading").first()).toHaveText("协作与依赖（4）");
      await expect(add).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "展开", exact: true })).toBeVisible();
    });
  });
}

test("AND-367 collaboration load failures retry without masquerading as an empty module", async ({ page, request }) => {
  const response = await request.post("/api/v1/items", { data: { productId: fixture.productId, type: "task", priority: "normal", title: "协作读取失败", description: "加载失败与重试", status: "ready", environment: { platform: "web" } } });
  expect(response.ok(), await response.text()).toBe(true);
  const item = await response.json();
  let failed = true;
  await page.route(`**/api/v1/items/${item.key}/collaboration`, route => route.fulfill(failed ? { status: 403, json: { error: "Forbidden" } } : { json: { blocked: false, canRequest: false, requests: [], drafts: [] } }));
  await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
  const panel = page.getByRole("region", { name: "协作与依赖", exact: true });
  await expect(panel.getByRole("alert")).toContainText("协作信息加载失败", { timeout: 15000 });
  await expect(panel).not.toContainText("暂无协作依赖");
  failed = false;
  await panel.getByRole("button", { name: "重试", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("heading")).toHaveText("协作与依赖");
});
