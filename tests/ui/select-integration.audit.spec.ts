import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { chooseOption } from "./select-helpers";

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} single-select integration`, () => {
    test.use({ viewport: { width, height: 1000 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("workspace Builder has a visible boundary and opens below the filter", async ({ page }) => {
      const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
      await page.goto(`/?product=${fixture.productId}&status=ready`);
      const control = page.getByRole("combobox", { name: "Builder", exact: true });
      await expect(control).toBeVisible();
      const contrast = await control.evaluate(node => {
        const style = getComputedStyle(node.closest("label")!);
        const luminance = (color: string) => {
          const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(value => { const n = Number(value) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
          return .2126 * r! + .7152 * g! + .0722 * b!;
        };
        const border = luminance(style.borderTopColor), background = luminance(style.backgroundColor);
        return (Math.max(border, background) + .05) / (Math.min(border, background) + .05);
      });
      expect(contrast).toBeGreaterThanOrEqual(3);
      await control.click();
      const menu = page.getByRole("listbox", { name: "Builder", exact: true });
      await expect(menu).toHaveAttribute("data-side", "bottom");
      const triggerBounds = await control.boundingBox(), menuBounds = await menu.boundingBox();
      expect(menuBounds!.y).toBeGreaterThanOrEqual(triggerBounds!.y + triggerBounds!.height + 4);
      await page.screenshot({ path: test.info().outputPath(`workspace-select-${width}-${theme}.png`) });
      await control.press("Escape");
      await expect(control).toBeFocused();
    });
    test("SDK feedback priority uses the shared menu and keeps its submit payload", async ({ page }) => {
      const draft = { id: "select-audit", productName: "SDK audit product", status: "editing", title: "SDK feedback selection", description: "Priority must be preserved", type: "bug", priority: "normal", environment: { platform: "android" }, context: {}, logs: [] };
      let priority = "";
      await page.route("**/api/v1/sdk/drafts/select-audit**", async route => {
        if (route.request().method() === "PATCH") priority = route.request().postDataJSON().priority;
        await route.fulfill({ json: { ...draft, priority: priority || draft.priority, ...(route.request().url().endsWith("/finalize") ? { status: "submitted", itemKey: "AUDIT-1" } : {}) } });
      });
      await page.goto("/sdk/feedback?draft=select-audit");
      const control = page.getByRole("combobox", { name: "优先级", exact: true });
      await chooseOption(control, "high");
      await expect(control).toHaveAttribute("data-value", "high");
      await page.getByRole("button", { name: "保存到草稿", exact: true }).click();
      await expect(page.getByRole("heading", { name: "已保存到草稿", exact: true })).toBeVisible();
      expect(priority).toBe("high");
    });
  });
}
