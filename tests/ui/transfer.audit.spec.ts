import { chooseOption } from "./select-helpers";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const viewport of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${viewport.name} ${theme} transfer`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme });
      test("confirms transfer, navigates to the new key, and keeps the original read-only", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("missiongo.locale", "en"));
        const targetResponse = await page.request.post("/api/v1/products", { data: { name: "Transfer destination", keyPrefix: `T${randomUUID().slice(0, 7).toUpperCase()}` } });
        expect(targetResponse.ok()).toBeTruthy();
        const target = await targetResponse.json() as { id: string; keyPrefix: string };
        const response = await page.request.post("/api/v1/items", { data: { productId: fixture.productId, type: "requirement", priority: "normal",
          status: "ready", title: "Correct a project assignment", description: "Keep the original report and its history when moving this item.", environment: { platform: "web" } } });
        expect(response.ok()).toBeTruthy();
        const item = await response.json() as { key: string };
        await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { bodyKind: "free", text: "Evidence recorded before transfer." } });
        await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
        await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
        const more = page.locator(".detail-toolbar .detail-more-menu > summary");
        await more.click();
        await page.getByRole("button", { name: "迁移条目", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await chooseOption(dialog.getByLabel("目标产品"), target.id);
        await dialog.getByRole("button", { name: "下一步", exact: true }).click();
        await expect(dialog).toContainText("来源组件和受影响组件关联将清空");
        await expect(dialog).toContainText("永久只读");
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const audit = await page.evaluate(AUDIT_SOURCE) as { horizontalOverflow: number; text: { fontSize: number; fontWeight: number; contrast: number; sample: string }[] };
        expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
        expect(audit.text.filter((text) => text.fontSize > 0 && text.fontSize < 11)).toEqual([]);
        expect(audit.text.filter((text) => text.contrast < (text.fontSize >= 24 || (text.fontSize >= 18.66 && text.fontWeight >= 700) ? 3 : 4.5))).toEqual([]);
        const confirm = dialog.getByRole("button", { name: "迁移条目", exact: true });
        const box = await confirm.boundingBox();
        // Chromium can report 43.99993896484375 for a 44px control.
        // Match the shared audit's whole-CSS-pixel measurement.
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        mkdirSync("test-results/and-278", { recursive: true });
        await page.screenshot({ path: `test-results/and-278/transfer-${viewport.name}-${theme}.png` });
        await confirm.click();
        await expect(page).toHaveURL(new RegExp(`item=${target.keyPrefix}-1`));
        await expect(page.locator(".transfer-banner")).toContainText(`迁移自 ${item.key}`);
        await expect(page.locator(".timeline")).toContainText("Evidence recorded before transfer.");
        await page.getByRole("button", { name: `迁移自 ${item.key}`, exact: true }).click();
        await expect(page.locator(".transfer-banner")).toContainText("永久只读");
        await expect(page.locator(".detail-toolbar").getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "恢复", exact: true })).toHaveCount(0);
        await expect(page.locator(".comment-form")).toHaveCount(0);
      });
    });
  }
}

for (const width of [375, 1440]) {
  test(`transfer from a nested message-center detail completes at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const user = (await (await request.get("/api/v1/bootstrap")).json()).user;
    const target = await (await request.post("/api/v1/products", { data: {
      name: "Nested transfer destination", keyPrefix: `N${randomUUID().slice(0, 7).toUpperCase()}`,
    } })).json();
    const item = await (await request.post("/api/v1/items", { data: {
      productId: fixture.productId, type: "note", priority: "normal", title: "Nested transfer regression", description: "",
      environment: { platform: "web" },
    } })).json();
    expect((await request.post(`/api/v1/items/${item.key}/comments`, { data: {
      text: "Review this project assignment", mentionAccountIds: [user.id],
    } })).ok()).toBe(true);
    await page.goto(`/?product=${fixture.productId}&status=all`);
    await page.getByRole("button", { name: "待处理", exact: true }).click();
    await page.getByRole("button", { name: /^通知/ }).click();
    await page.locator(".message-list-row").filter({ hasText: item.key }).click();
    await page.getByRole("button", { name: "前往评论 / 回复", exact: true }).click();
    const business = page.locator(".message-business-modal");
    await business.locator(".detail-toolbar .detail-more-menu > summary").click();
    await business.getByRole("button", { name: "迁移条目", exact: true }).click();
    const transfer = page.getByRole("dialog", { name: "迁移条目", exact: true });
    await expect.poll(() => page.evaluate(() => history.state?.["missiongo:dialogs"]?.length ?? 0)).toBeGreaterThanOrEqual(3);
    await chooseOption(transfer.getByLabel("目标产品"), target.id);
    await transfer.getByRole("button", { name: "下一步", exact: true }).click();
    await transfer.getByRole("button", { name: "迁移条目", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`product=${target.id}.*item=${target.keyPrefix}-1`));
    await expect(page.locator(".transfer-banner")).toContainText(`迁移自 ${item.key}`);
  });
}
