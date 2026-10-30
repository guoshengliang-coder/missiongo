import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { chooseOption } from "./select-helpers";
const harness = fileURLToPath(new URL("./select-harness.tsx", import.meta.url));

async function fits(menu: Locator) {
  await expect(async () => {
    const bounds = await menu.boundingBox();
    const viewport = menu.page().viewportSize()!;
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(7);
    expect(bounds!.y).toBeGreaterThanOrEqual(7);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7);
  }).toPass({ timeout: 3000 });
}

for (const width of [375, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} shared select`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.route("**/__select-audit", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><html data-appearance="${theme}"><body><div id="root"></div><script type="module" src="/@fs/${harness}"></script></body></html>` }));
      await page.goto("/__select-audit");
    });
    test("keyboard, groups, validation, external updates and form data", async ({ page }) => {
      const control = page.getByRole("combobox", { name: "选择项目", exact: true });
      await page.getByRole("button", { name: "提交", exact: true }).click();
      await expect(control).toHaveAttribute("aria-invalid", "true");
      await expect(control).toBeFocused();
      await control.press("ArrowDown");
      await control.press("ArrowDown");
      await control.press("ArrowDown"); // skips disabled option
      await control.press("Enter");
      await expect(control).toHaveAttribute("data-value", "beta");
      await expect(page.getByLabel("变更次数")).toHaveText("1");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await control.press("Home");
      await control.press("End");
      await control.press("Escape");
      await expect(control).toHaveAttribute("data-value", "beta");
      await expect(control).toBeFocused();
      await control.press("c"); // closed typeahead commits once
      await expect(control).toHaveAttribute("data-value", "charlie");
      await control.click();
      await expect(page.getByRole("option", { name: "组内禁用", exact: true })).toHaveAttribute("aria-disabled", "true");
      await control.press("Tab");
      await expect(control).not.toBeFocused();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await page.getByRole("button", { name: "外部更新", exact: true }).click();
      await expect(control).toHaveText(/动态更新的后缀/);
      await page.getByRole("button", { name: "提交", exact: true }).click();
      await expect(page.getByLabel("已提交")).toHaveText("beta");
      await control.click();
      await fits(page.getByRole("listbox"));
      await page.screenshot({ path: test.info().outputPath(`select-${width}-${theme}.png`) });
      await control.press("Escape");
      await page.getByRole("button", { name: "禁用控件", exact: true }).click();
      await expect(control).toBeDisabled();
      const uncontrolled = page.getByRole("combobox", { name: "未受控", exact: true });
      await chooseOption(uncontrolled, "b");
      await expect(uncontrolled).toHaveAttribute("data-value", "b");
      await page.getByRole("button", { name: "重置", exact: true }).click();
      await expect(uncontrolled).toHaveAttribute("data-value", "a");
    });
    test("touch/pointer, dialog clipping, collision and viewport changes", async ({ page }) => {
      await page.getByRole("button", { name: "打开弹窗", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const control = dialog.getByRole("combobox", { name: "弹窗选项", exact: true });
      await control.click();
      const menu = page.getByRole("listbox");
      await fits(menu);
      // The last row is outside the clipped parent but inside the portal menu.
      await page.getByRole("option", { name: "弹窗选项 20", exact: true }).click();
      await expect(control).toHaveAttribute("data-value", "dialog-20");
      await expect(control).toBeFocused();
      await control.click();
      await control.press("Escape");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      await page.getByRole("button", { name: "外部更新", exact: true }).click();
      const field = page.getByRole("combobox", { name: "选择项目", exact: true });
      await field.evaluate(node => { node.style.position = "fixed"; node.style.bottom = "12px"; node.style.right = "12px"; node.style.maxWidth = "180px"; });
      await field.click();
      await expect(menu).toHaveAttribute("data-side", "top");
      await fits(menu);
      await page.setViewportSize({ width, height: 420 });
      await fits(menu);
      await page.locator("html").evaluate(node => node.setAttribute("data-font-scale", "large"));
      await fits(menu);
      await page.getByRole("option", { name: "扩展选项 23", exact: true }).click();
      await expect(field).toHaveAttribute("data-value", "extra-23");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    });
  });
}
