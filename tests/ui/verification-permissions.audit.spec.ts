import { postItemCommand } from "./item-command";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectUsableControl } from "./visible-control";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const [width, theme] of [[1280, "light"], [375, "dark"]] as const) {
  test(`acceptance uses item rights in list, detail and batch at ${width}px ${theme}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const email = `acceptance-${width}@example.test`, password = "acceptance member password";
    const accountResponse = await request.post("/api/v1/accounts", { data: { email, password, role: "member" } });
    expect(accountResponse.ok()).toBeTruthy();
    const account = await accountResponse.json();
    expect((await request.put(`/api/v1/accounts/${account.id}/products`, { data: { permissions: [{ productId: fixture.productId, canView: true, canOperate: true, canUseAi: false }] } })).ok()).toBeTruthy();
    const create = async (title: string) => {
      const response = await request.post("/api/v1/items", { data: { productId: fixture.productId, title, description: "", type: "requirement", priority: "normal", status: "ready", environment: { platform: "web" } } });
      expect(response.ok()).toBeTruthy();
      const item = await response.json();
      expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`, { data: { to: "pending_verification", reason: "manual_override" } })).ok()).toBeTruthy();
      return item;
    };
    const other = await create(`Acceptance peer ${width}`);
    // Only the browser's cookie becomes the member's; the admin request fixture remains independent.
    expect((await page.request.post("/api/v1/auth/login", { data: { username: email, password } })).ok()).toBeTruthy();
    await page.goto(`/?product=${fixture.productId}&status=pending_verification&q=${other.key}`);
    const row = page.locator(".item-row").filter({ hasText: other.key });
    await expect(row).toBeVisible();
    await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
    await row.locator(".row-more-menu > summary").click();
    await expect(row.getByRole("button", { name: "验证通过", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "验收打回", exact: true })).toHaveCount(0);
    await page.goto(`/?product=${fixture.productId}&status=pending_verification&item=${other.key}`);
    await expect(page.locator(".detail-pane").getByText(/只有系统管理员、项目管理员或该条目提需者/)).toBeVisible();
    await expect(page.locator(".detail-pane .toolbar-primary-action")).toHaveCount(0);

    // Project role grants acceptance independently of operation permissions.
    const originalAdmins=(await (await request.get(`/api/v1/products/${fixture.productId}/administrators`)).json()).accountIds;
    expect((await request.put(`/api/v1/products/${fixture.productId}/administrators`, { data: { accountIds: [account.id], expectedAccountIds: originalAdmins } })).ok()).toBeTruthy();
    expect((await request.put(`/api/v1/accounts/${account.id}/products`, { data: { permissions: [] } })).ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator(".detail-pane .toolbar-primary-action")).toHaveText("验证通过");
    await expectUsableControl(page.locator(".detail-pane .toolbar-primary-action"), width < 1280);
    await page.screenshot({ path: test.info().outputPath("acceptance-detail.png") });
    await page.goto(`/?product=${fixture.productId}&status=pending_verification&q=${other.key}`);
    const allowedRow = page.locator(".item-row").filter({ hasText: other.key });
    await allowedRow.locator('input[type="checkbox"]').check();
    const bulk = page.locator(".bulk-bar .primary-button");
    await expect(bulk).toBeVisible();
    await bulk.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator(".bulk-verify .primary-button").click();
    await expect(dialog).toHaveCount(0);
    expect((await (await request.get(`/api/v1/items/${other.key}`)).json()).status).toBe("done");
    expect((await request.put(`/api/v1/products/${fixture.productId}/administrators`, { data: { accountIds: originalAdmins, expectedAccountIds: [account.id] } })).ok()).toBeTruthy();
  });
}
