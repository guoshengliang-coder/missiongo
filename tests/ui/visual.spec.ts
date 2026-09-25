import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { PAGES, THEMES, VIEWPORTS } from "./fixture.mjs";

/**
 * Screenshot comparison, one per page, viewport and theme.
 *
 * What it is for: the layout failures this project keeps having -- a column
 * that overflows at one width (AND-109), a bar that turns pale in dark mode
 * (B1), a button that disappears into its background (B3) -- are obvious in a
 * picture and invisible to a unit test.
 *
 * Baselines are Linux's: CI records the `*-visual-linux.png` set and compares
 * against it on ubuntu. Regenerate them deliberately -- the workflow_dispatch
 * input `update_ui_snapshots` writes them, and the `ui-snapshots` artifact
 * carries what changed -- while a developer's own darwin files stay untracked.
 *
 * The product badge is masked. Its colour is hashed from the fixture product's
 * random id, so it differs every run and once pushed a stale baseline over the
 * diff threshold by luck. Masking keeps the comparison deterministic, and
 * because the mask follows the badge's box, a badge that moves or resizes
 * still shows up as differing pixels around it.
 */

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as {
  productId: string;
  keys: string[];
  detailKey: string;
};

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
        colorScheme: theme as "light" | "dark",
      });

      for (const pageUnderTest of PAGES) {
        test(pageUnderTest.name, async ({ page }) => {
          await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
          await page.goto(pageUnderTest.path(fixture));
          await page.waitForLoadState("networkidle");
          await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
          await page.waitForTimeout(200);
          await expect(page).toHaveScreenshot(`${pageUnderTest.name}-${viewport.name}-${theme}.png`, {
            fullPage: false,
            mask: [page.locator(".product-badge")],
          });
        });
      }
    });
  }
}
