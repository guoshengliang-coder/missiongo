import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

test("missing Linux publication returns an explicit 404, not the SPA shell", async ({ request }) => {
  for (const extension of ["tgz", "json"]) {
    const response = await request.get(`/downloads/missiongo-linux-latest.${extension}`);
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("text/plain");
  }
});

for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Linux download package and integrity links ${viewport.width} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/?appearance=${theme}`);
      const menu = page.getByRole("button", { name: /打开导航|Open navigation/i });
      const download = page.getByRole("button", { name: /^(下载|Downloads)$/ });
      await expect(page.locator(".sidebar")).toBeAttached();
      if (await menu.isVisible()) await menu.click();
      await download.click();
      const dialog = page.getByRole("dialog").filter({ has: page.getByText(/Linux CLI/) });
      const card = dialog.locator(".download-card").filter({ has: page.getByRole("heading", { name: /Linux CLI/ }) });
      await expect(card).toBeVisible();
      await expect(card.getByRole("link", { name: /npm/ })).toHaveAttribute("href", "/downloads/missiongo-linux-latest.tgz");
      await expect(card.getByRole("link", { name: /SHA-256/ })).toHaveAttribute("href", "/downloads/missiongo-linux-latest.json");
      await expect(card).toContainText("Ubuntu 22.04/24.04");
      await expect(card).toContainText("npm install --global");
      expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
      await card.scrollIntoViewIfNeeded();
      mkdirSync("docs/review-evidence/AND-359", { recursive: true });
      await dialog.screenshot({ path: `docs/review-evidence/AND-359/download-${viewport.width}-${theme}.png` });
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
    });
  }
}
