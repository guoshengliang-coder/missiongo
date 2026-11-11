import { expect, type Page } from "@playwright/test";
import { chooseOption } from "./select-helpers";

export async function openConversationFilters(page: Page) {
  if (page.viewportSize()!.width > 1023) return;
  const dialog = page.getByRole("dialog", { name: "会话筛选", exact: true });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: "会话筛选", exact: true }).click();
  await expect(dialog).toBeVisible();
}

export async function closeConversationFilters(page: Page) {
  const dialog = page.getByRole("dialog", { name: "会话筛选", exact: true });
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
}

export async function openConsoleSearch(page: Page) {
  if (page.viewportSize()!.width > 1023) return;
  await page.locator(".agent-console-topbar-more > summary").click();
  const action = page.locator(".agent-console-topbar-more-menu").getByRole("button", { name: "搜索会话", exact: true });
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await action.click();
  await expect(page.locator(".agent-console-search input")).toBeVisible();
}

export async function chooseSessionStatus(page: Page, value: string) {
  await openConversationFilters(page);
  await chooseOption(page.getByRole("combobox", { name: "会话状态筛选", exact: true }), value);
  await closeConversationFilters(page);
}
