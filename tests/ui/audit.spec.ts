import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { AUDIT_SOURCE } from "./audit-page.mjs";
import { PAGES, THEMES, VIEWPORTS } from "./fixture.mjs";

/**
 * What the console has to be true of, on every shell it can take, in both
 * themes -- measured on the rendered page rather than read off the stylesheet.
 *
 * The numbers are docs/design-system.md: 11px floor, WCAG AA for text, 44px
 * touch targets where the pointer is coarse. Each has been broken in production
 * at least once (B8, B9, UI-05/06, A2, AND-112).
 */

const MIN_FONT_SIZE = 11;
const MIN_CONTRAST = 4.5;
/** WCAG's large-text allowance: 24px, or 18.66px when bold. */
const LARGE_TEXT = (size: number, weight: number) => size >= 24 || (weight >= 700 && size >= 18.66);
const MIN_TOUCH_TARGET = 44;

interface AuditText {
  where: string;
  sample: string;
  fontSize: number;
  fontWeight: number;
  contrast: number;
  colour: string;
  monospace: boolean;
}

interface AuditTarget {
  where: string;
  label: string;
  width: number;
  height: number;
}

interface AuditSurface {
  where: string;
  colour: string;
  width: number;
  height: number;
}

interface AuditResult {
  appearance: string | null;
  coarsePointer: boolean;
  horizontalOverflow: number;
  text: AuditText[];
  targets: AuditTarget[];
  surfaces: AuditSurface[];
  brand: string;
}

/** #67e3b4 as the browser reports it, so a surface can be compared to the token. */
function rgbOf(hex: string): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as {
  productId: string;
  keys: string[];
  detailKey: string;
};

/**
 * The most small touch targets any one page still has, measured: the phone list
 * at 8. They are A2 in the review -- the refresh button at 36px wide, the
 * product switcher and the row menu at 38px, the select checkbox at 16px, the
 * row itself at 40px -- and fixing them is D2-4, which moves the 44px rule off
 * the width breakpoint and onto `(pointer: coarse)`. Until then the number may
 * only go down: a new one fails here.
 */
const SMALL_TARGET_ALLOWANCE = 8;

async function auditPage(page: Page, path: string, theme: string): Promise<AuditResult> {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // The shell animates in; measuring mid-transition reports colours that are
  // never actually shown.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  await page.waitForTimeout(200);
  return page.evaluate(AUDIT_SOURCE) as Promise<AuditResult>;
}

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
        test(`${pageUnderTest.name} is readable`, async ({ page }) => {
          const result = await auditPage(page, pageUnderTest.path(fixture), theme);

          expect(result.appearance, "the boot script decides the theme before anything paints").toBe(theme);

          // font-size: 0 is how an icon-only control hides its label while keeping
          // the accessible name (.detail-back-button below 1023px). Nothing renders,
          // so there is nothing to read.
          const tooSmall = result.text.filter((item) => item.fontSize > 0 && item.fontSize < MIN_FONT_SIZE);
          expect(tooSmall.map((item) => `${item.fontSize}px ${item.where} "${item.sample}"`)).toEqual([]);

          const tooFaint = result.text.filter((item) => (
            item.contrast < (LARGE_TEXT(item.fontSize, item.fontWeight) ? 3 : MIN_CONTRAST)
          ));
          expect(tooFaint.map((item) => `${item.contrast.toFixed(2)}:1 ${item.where} "${item.sample}" ${item.colour}`)).toEqual([]);

          expect(result.horizontalOverflow, "the page must not scroll sideways").toBeLessThanOrEqual(0);

          if (theme === "dark") {
            // The brand mint is light in both themes by design -- it is the
            // filled control. Anything else still light in the dark theme is a
            // literal colour that only holds in one of them.
            const mint = rgbOf(result.brand);
            const glaring = result.surfaces.filter((surface) => surface.colour !== mint);
            expect(glaring.map((s) => `${s.where} ${s.colour} ${s.width}x${s.height}`)).toEqual([]);
          }
        });

        if (viewport.touch) {
          test(`${pageUnderTest.name} can be hit with a finger`, async ({ page }) => {
            const result = await auditPage(page, pageUnderTest.path(fixture), theme);
            expect(result.coarsePointer, "this viewport is meant to emulate touch").toBe(true);

            const small = result.targets.filter((target) => (
              target.width > 0 && target.height > 0 && (target.height < MIN_TOUCH_TARGET || target.width < MIN_TOUCH_TARGET)
            ));
            // Reported in full so a new one is obvious, but only the count is
            // enforced: the existing offenders are D2-4's job.
            console.log(`${small.length} small targets:\n${small.map((t) => `  ${t.width}x${t.height} ${t.where} "${t.label}"`).join("\n")}`);
            expect(small.length, "small touch targets may only get fewer").toBeLessThanOrEqual(SMALL_TARGET_ALLOWANCE);
          });
        }
      }
    });
  }
}

test.describe("capture form", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, colorScheme: "dark" });

  test("submits without hunting for the button", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/?product=${fixture.productId}&status=all`);
    await page.waitForLoadState("networkidle");
    await page.locator(".mobile-fab").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();

    const result = (await page.evaluate(AUDIT_SOURCE)) as AuditResult;
    expect(result.text.filter((item) => item.fontSize > 0 && item.fontSize < MIN_FONT_SIZE)).toEqual([]);
    expect(result.text.filter((item) => item.contrast < MIN_CONTRAST && !LARGE_TEXT(item.fontSize, item.fontWeight))).toEqual([]);

    // The submit bar is sticky below 520px: it stays on screen while the form
    // scrolls. AND-30 was this, and C1 is the same bar off-screen in landscape.
    const submit = dialog.locator("button", { hasText: "提交" }).first();
    await expect(submit).toBeInViewport();
  });
});
