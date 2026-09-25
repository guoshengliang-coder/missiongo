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
 * Small touch targets allowed on any one page. It was 8 -- the A2 backlog --
 * until DC-2 moved the 44px rule onto `(pointer: coarse)`. Keep it at zero.
 */
const SMALL_TARGET_ALLOWANCE = 0;

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

// The submit bar stays in view while a long form scrolls: AND-30 fixed it for a
// portrait phone only, and C1 found the same button 1437px down in landscape.
for (const viewport of [
  { name: "phone", width: 375, height: 812 },
  { name: "phone-landscape", width: 812, height: 375 },
  { name: "tablet", width: 768, height: 1024 },
]) {
  test.describe(`capture form on ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true, colorScheme: "dark" });

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

      const submit = dialog.locator(".capture-actions .primary-button");
      await expect(submit).toBeInViewport();
      // And still there after scrolling to the middle of the form.
      await dialog.locator(".modal").evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
      await expect(submit).toBeInViewport();
    });
  });
}

test.describe("row checkbox on a touch screen", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("tapping the edge of its target ticks the box and leaves the list", async ({ page }) => {
    await page.goto(`/?product=${fixture.productId}&status=all`);
    await page.waitForLoadState("networkidle");
    const hit = page.locator(".item-select-hit").first();
    await expect(hit).toBeVisible();
    const box = await hit.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    // A corner of the label, well outside the 20px checkbox it wraps. A click,
    // not a tap: Chromium's touch adjustment snaps a tap onto the checkbox
    // itself, so only a click proves what a press on the label's padding does --
    // which a touchscreen laptop, or a stylus, sends as exactly that.
    await hit.click({ position: { x: 3, y: 3 } });
    await expect(hit.locator("input")).toBeChecked();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).searchParams.get("item"), "the row must not have opened").toBeNull();
  });
});

test.describe("the more button on a compact card", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("draws no surface of its own", async ({ page }) => {
    await page.goto(`/?product=${fixture.productId}&status=all`);
    await page.waitForLoadState("networkidle");
    // The card is the only plate in the compact list, so this button cancels the
    // surface and border .secondary-button brings. A screenshot cannot hold this:
    // a 44px box on a 375x812 view is 0.6% of the image and toHaveScreenshot
    // allows 1%, so the baseline sits unchanged either way (AND-194). The rule
    // was lost once in a merge and nothing failed -- hence this.
    const more = page.locator(".row-more-menu > summary").first();
    await expect(more).toBeVisible();
    await expect(more).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(more).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  });
});

test.describe("attachments a browser cannot read natively", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an iPhone HEIC is drawn from the server's decoded copy", async ({ page }) => {
    await page.goto(`/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`);
    await page.waitForLoadState("networkidle");
    const thumbnail = page.locator('.attachment-media-open img[alt="iphone.heic"]');
    await thumbnail.scrollIntoViewIfNeeded();
    await expect(thumbnail).toBeVisible();
    // naturalWidth is 0 for an image the browser failed to decode -- which is
    // what a raw HEIC is to Chromium.
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test("a video this browser cannot play says so and offers the file", async ({ page }) => {
    await page.goto(`/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`);
    await page.waitForLoadState("networkidle");
    const card = page.locator(".attachment-card", { hasText: "screen-recording.mov" });
    await card.scrollIntoViewIfNeeded();
    await card.locator(".attachment-load-button").click();
    const notice = card.locator(".video-unplayable");
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button")).toBeVisible();
  });
});

