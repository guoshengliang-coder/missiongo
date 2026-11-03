import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));

for (const width of [375, 1440]) {
  test(`diagnostics folds with a visible expand affordance and a plus upload icon at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`/?product=${fixture.productId}`);
    await page.locator(width === 375 ? ".mobile-fab" : ".capture-button").click();

    const form = page.locator(".quick-capture-form");
    const diagnostics = form.locator(".diagnostic-input-block");
    const summary = diagnostics.locator("summary.diagnostic-input-heading");
    const upload = summary.locator(".file-picker-button");

    await expect(diagnostics).toHaveJSProperty("open", false);
    await expect(summary.locator("svg.lucide-chevron-right")).toBeVisible();
    await expect(upload.locator("svg.lucide-plus")).toBeVisible();
    await expect(upload).toContainText("上传日志");
    await diagnostics.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: testInfo.outputPath("diagnostics-folded.png") });

    // Picking a log file must not expand the block merely by clicking the button.
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await chooser;
    await expect(diagnostics).toHaveJSProperty("open", false);

    await summary.click();
    await expect(diagnostics).toHaveJSProperty("open", true);
    expect(await summary.locator("svg.lucide-chevron-right").evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
    await diagnostics.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: testInfo.outputPath("diagnostics-expanded.png") });
    expect(await diagnostics.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });
}
