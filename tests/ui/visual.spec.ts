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
  snapshotTime: number;
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
          await page.clock.setFixedTime(fixture.snapshotTime);
          await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
          await page.goto(pageUnderTest.path(fixture));
          await page.waitForLoadState("networkidle");
          await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
          await page.waitForTimeout(200);
          // Lazy thumbnails start after IntersectionObserver, sometimes after
          // networkidle. Never accept a temporarily stable loading placeholder.
          if (pageUnderTest.name === "detail") {
            await expect.poll(() => page.locator(".attachment-image").evaluateAll(cards =>
              cards.filter(card => {
                const box = card.getBoundingClientRect();
                return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0;
              }).every(card => {
                const image = card.querySelector("img");
                return image !== null && image.complete && image.naturalWidth > 0;
              }),
            ), { timeout: 15_000 }).toBe(true);
          }
          await expect(page).toHaveScreenshot(`${pageUnderTest.name}-${viewport.name}-${theme}.png`, {
            fullPage: false,
            mask: [page.locator(".product-badge")],
          });
        });
      }
    });
  }
}
