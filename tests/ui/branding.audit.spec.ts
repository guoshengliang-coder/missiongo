import { expect, test } from "@playwright/test";

for (const width of [320, 375, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`AND-384 branding ${width} ${theme}`, () => {
      test.use({ viewport: { width, height: width === 375 ? 812 : 900 }, hasTouch: width < 400, colorScheme: theme });

      test("shares the canonical icon and localized metadata across login, workspace and onboarding", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator(".app-shell")).toBeVisible();
        const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
        await expect(page.locator(".brand-mark").first()).toHaveAttribute("src", favicon!);
        expect(await page.locator(".brand-mark").first().evaluate((image) => getComputedStyle(image).filter)).toContain("drop-shadow");
        expect(await page.locator(".brand-mark").first().evaluate((image) => getComputedStyle(image).borderTopWidth)).toBe("1px");
        expect(await page.locator(".brand-mark").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
        await expect(page).toHaveTitle("MissionGo · 一站式AI交付平台");
        for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
          await expect(page.locator(selector)).toHaveAttribute("content", "MissionGo — 一站式AI交付平台");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath("workspace.png") });

        // Both localized metadata paths are exercised without enabling a new
        // language picker in a product that currently fixes the UI to Chinese.
        await page.evaluate(async () => {
          const modulePath = "/src/branding.ts";
          const { applyProductMetadata } = await import(/* @vite-ignore */ modulePath);
          applyProductMetadata(document, "en");
        });
        await expect(page).toHaveTitle("MissionGo · All-in-one AI delivery platform");
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest-en.webmanifest");
        await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", "MissionGo — All-in-one AI delivery platform");
        const englishManifest = await (await page.request.get("/manifest-en.webmanifest")).json();
        expect(englishManifest.description).toBe("All-in-one AI delivery platform");

        await page.route(/\/api\/v1\/(bootstrap|products)(\?|$)/, async (route) => {
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const data = await response.json();
          await route.fulfill({ response, json: Array.isArray(data) ? [] : { ...data, products: [] } });
        });
        // Avoid a previously hydrated products list obscuring the empty state.
        await page.evaluate(() => { localStorage.clear(); });
        await page.reload();
        await expect(page.locator(".onboarding-page")).toBeVisible();
        await expect(page.locator(".onboarding-tagline")).toHaveText("一站式AI交付平台");
        await expect(page.locator(".brand-mark").first()).toHaveAttribute("src", favicon!);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath("onboarding.png") });

        await page.context().clearCookies();
        await page.evaluate(() => { localStorage.clear(); });
        await page.reload();
        await expect(page.locator('input[type="password"]')).toBeVisible();
        await expect(page.locator(".brand-mark").first()).toHaveAttribute("src", favicon!);
        await expect(page.locator(".brand-tagline").first()).toHaveText("一站式AI交付平台");
        await page.screenshot({ path: test.info().outputPath("login.png") });
        for (const scale of ["small", "medium", "large"]) {
          await page.evaluate((value) => { document.documentElement.dataset.fontScale = value; }, scale);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          for (const mark of await page.locator(".brand-mark").all()) {
            const box = await mark.boundingBox();
            expect(box?.width).toBe(36);
            expect(box?.height).toBe(36);
          }
        }
      });
    });
  }
}
