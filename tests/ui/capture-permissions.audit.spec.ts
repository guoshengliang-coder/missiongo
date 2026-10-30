import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };

for (const width of [1280, 375]) {
  test(`read-only project disables capture at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(/\/api\/v1\/(bootstrap|products)(\?|$)/, async route => {
      const response = await route.fetch();
      const data = await response.json();
      const readOnly = (product: { id: string }) => ({ ...product, access: { canOperate: false, canUseAi: true } });
      await route.fulfill({ response, json: Array.isArray(data) ? data.map(readOnly) : { ...data, products: data.products.map(readOnly) } });
    });
    await page.goto(`/?product=${fixture.productId}`);
    const capture = page.locator(width === 375 ? ".mobile-fab" : ".capture-button");
    await expect(capture).toBeVisible();
    await expect(capture).toBeDisabled();
    await expect(capture).toHaveAttribute("title", /操作权限/);
  });
}

for (const action of ["title", "capture"] as const) {
  test(`${action} permission refusal explains access and preserves the draft`, async ({ page }) => {
    await page.goto(`/?product=${fixture.productId}`);
    await page.locator(".capture-button").click();
    const form = page.locator(".quick-capture-form");
    await form.locator(".ai-title-field input").fill("登录后自动退出");
    await form.locator(".report-input-block textarea").first().fill("登录后自动退出，重启后仍然复现。");
    await page.route(action === "title" ? "**/api/v1/ai/title" : "**/api/v1/items", route => route.fulfill({
      status: 403, contentType: "application/problem+json",
      body: JSON.stringify({ code: "product_operation_not_permitted", title: "Operation permission required." }),
    }));
    await form.getByRole("button", { name: action === "title" ? "AI 提炼" : "保存到草稿", exact: true }).click();
    await expect(form.getByText(/当前账号仅可查看此项目/)).toBeVisible();
    await expect(form.locator(".ai-title-field input")).toHaveValue("登录后自动退出");
    await expect(form.locator(".report-input-block textarea").first()).toHaveValue("登录后自动退出，重启后仍然复现。");
    await expect(form.getByText("Product was not found.", { exact: true })).toHaveCount(0);
  });
}
