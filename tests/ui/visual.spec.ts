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
 * Baselines belong to the platform that produced them: the same CSS lays out
 * differently against Linux and macOS font stacks. So this project does not run
 * in CI. Generate on the machine you develop on:
 *
 *     npm run test:ui:visual -- --update-snapshots
 *
 * and read the diff it prints when something moves.
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
          await expect(page).toHaveScreenshot(`${pageUnderTest.name}-${viewport.name}-${theme}.png`, { fullPage: false });
        });
      }
    });
  }
}
