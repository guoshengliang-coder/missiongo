import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const url = () => `/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`;
const depth = (page: Page) => page.evaluate(() => (history.state?.["missiongo:dialogs"] ?? []).length as number);
const back = (page: Page) => page.evaluate(() => history.back());

test("nested menus consume Back and Escape separately without changing the detail", async ({ page }) => {
  await page.goto(url());
  const original = page.url();
  const menu = page.locator(".detail-toolbar .detail-more-menu");
  await menu.locator(":scope > summary").click();
  await menu.locator(".detail-move-menu > summary").click();
  await expect.poll(() => depth(page)).toBe(2);
  await back(page);
  await expect(menu.locator(".detail-move-menu")).not.toHaveAttribute("open");
  await expect(menu).toHaveAttribute("open");
  await expect(menu.locator(".detail-move-menu > summary")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect.poll(() => depth(page)).toBe(0);
  await expect(page).toHaveURL(original);
});

test("replacing a menu with an editor does not leave invisible history layers", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(url());
  await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
  const bar = page.locator(".detail-toolbar");
  await expect(bar).toHaveAttribute("data-overflow", "true");
  for (let i = 0; i < 3; i++) {
    await bar.locator(".detail-more-menu > summary").click();
    await bar.locator(".detail-actions-popover button").filter({ hasText: /^编辑$/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => depth(page)).toBe(1);
    await back(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => depth(page)).toBe(0);
    await expect(bar).toBeVisible();
  }
});

for (const marker of ["current", "missiongo:overlay", "missiongo:quick-settings"]) test(`reload retires ${marker} before registering a new preview`, async ({ page }) => {
  await page.goto(url());
  const trigger = page.locator(".attachment-media-open").first();
  await page.locator(".attachment-card").first().scrollIntoViewIfNeeded();
  await trigger.click();
  await expect.poll(() => depth(page)).toBe(1);
  if (marker !== "current") await page.evaluate(marker => {
    const state = { ...history.state, [marker]: true };
    delete state["missiongo:dialogs"];
    history.replaceState(state, "");
  }, marker);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => depth(page)).toBe(0);
  await page.locator(".attachment-card").first().scrollIntoViewIfNeeded();
  await trigger.click();
  await expect.poll(() => depth(page)).toBe(1);
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => depth(page)).toBe(0);
  await expect(page.locator(".detail-toolbar")).toBeVisible();
  await back(page);
  await expect(page.locator(".detail-toolbar")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("item")).toBe(false);
});
