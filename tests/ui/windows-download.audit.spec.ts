import { expect, test } from "@playwright/test";

test("missing Windows metadata and installer return 404 rather than the console shell", async ({ request }) => {
  for (const name of ["latest.json", "latest.yml", "missiongo-windows-0.1.0-x64-setup.exe"]) {
    const response = await request.get(`/downloads/windows/${name}`);
    expect(response.status()).toBe(404); expect(response.headers()["content-type"] ?? "").not.toContain("text/html");
  }
});
for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Windows download is unavailable before publication and stays within the dialog at ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/?appearance=${theme}`);
    await expect(page.locator(".sidebar")).toBeAttached();
    const menu = page.getByRole("button", { name: /打开导航|Open navigation/i }); if (await menu.isVisible()) await menu.click();
    await page.getByRole("button", { name: /^(下载|Downloads)$/ }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^Windows/ }) });
    const card = dialog.locator(".download-card").filter({ has: page.getByRole("heading", { name: /^Windows/ }) });
    await expect(card).toContainText("Windows 11 x64"); await expect(card.getByRole("status")).toContainText("暂未提供");
    await expect(card.getByRole("link")).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await card.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: `test-results/windows-download-${width}-${theme}.png` });
    await page.goBack(); await expect(dialog).toHaveCount(0);
  });
}
test("download link appears only after the server provides a signed versioned Windows package", async ({ page }) => {
  await page.route("**/downloads/windows/latest.json", route => route.fulfill({ json: {
    signed: true, platform: "win32", arch: "x64", version: "0.1.0", sha256: "a".repeat(64), filename: "missiongo-windows-0.1.0-x64-setup.exe",
  } }));
  await page.goto("/"); await page.getByRole("button", { name: /^(下载|Downloads)$/ }).click();
  await expect(page.getByRole("link", { name: "下载 Windows 安装包" })).toHaveAttribute("href", "/downloads/windows/missiongo-windows-0.1.0-x64-setup.exe");
});
