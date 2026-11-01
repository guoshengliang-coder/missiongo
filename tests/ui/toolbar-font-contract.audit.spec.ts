import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";
import { expectUsableControl } from "./visible-control";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };

for (const theme of ["light", "dark"] as const) for (const labels of ["normal", "long"] as const) {
  test.describe(`${labels} ${theme} toolbar and font contracts`, () => {
    test.use({ hasTouch: true, isMobile: true, colorScheme: theme });
    test("controls stay reachable across font sizes and container widths", async ({ page }) => {
      await page.goto(`/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`);
      await expect(page.locator(".detail-toolbar")).toBeVisible();
      const bar = page.locator(".detail-toolbar");
      if (labels === "long") await bar.locator(".toolbar-primary-action").evaluate(node => { node.textContent = "Mark development complete"; });
      for (const width of [320, 353, 375, 520, 521, 1023, 1024, 1279, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const scale of ["small", "medium", "large"]) {
          await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
          await expect.poll(async () => {
            const box = await bar.locator(".detail-more-menu > summary").boundingBox();
            return box!.x + box!.width;
          }).toBeLessThanOrEqual(width);
          const edges: { top: number; bottom: number }[] = [];
          for (const control of await bar.locator("button:visible, summary:visible").all()) {
            if (await control.evaluate(el => Boolean(el.closest("details:not([open])") && el.tagName !== "SUMMARY"))) continue;
            await expectUsableControl(control);
            const box = (await control.boundingBox())!;
            edges.push({ top: box.y, bottom: box.y + box.height });
          }
          if (labels === "normal" && scale === "medium") {
            for (const edge of ["top", "bottom"] as const) expect(Math.max(...edges.map(box => box[edge])) - Math.min(...edges.map(box => box[edge])), `toolbar ${edge} alignment`).toBeLessThanOrEqual(1);
          }
          const audit = await page.evaluate(AUDIT_SOURCE) as { text: { fontSize: number; where: string; sample: string }[] };
          expect(audit.text.filter(t => t.fontSize > 0 && t.fontSize < 11), `${width} ${scale}`).toEqual([]);
        }
      }
      await page.setViewportSize({ width: 320, height: 812 });
      await expect(bar).toHaveAttribute("data-overflow", "true");
      await bar.locator(".detail-more-menu > summary").click();
      const edit = bar.locator(".detail-actions-popover button").filter({ hasText: /^编辑$/ });
      await expectUsableControl(edit);
      await edit.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`toolbar-edit-${labels}-${theme}.png`) });
    });
  });
}
