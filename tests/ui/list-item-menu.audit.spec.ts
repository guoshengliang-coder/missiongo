import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { chooseOption } from "./select-helpers";

test.use({ actionTimeout: 10_000 });

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const statuses = ["inbox", "ready", "in_progress", "development_complete", "on_hold", "pending_verification", "done", "cancelled"] as const;
type Status = typeof statuses[number];
const labels: Record<Status, string> = { inbox: "草稿", ready: "待处理", in_progress: "处理中", development_complete: "开发完成", on_hold: "暂缓", pending_verification: "待验证", done: "已完成", cancelled: "已取消" };
const cases: Record<Status, { primary: string; secondary?: string[]; moves: Status[] }> = {
  inbox: { primary: "转为待处理", moves: ["in_progress", "development_complete", "on_hold", "pending_verification", "done"] },
  ready: { primary: "开始处理", secondary: ["暂缓处理", "移回草稿"], moves: ["development_complete", "pending_verification", "done"] },
  in_progress: { primary: "标记开发完成", secondary: ["暂缓处理", "释放任务"], moves: ["inbox", "pending_verification", "done"] },
  development_complete: { primary: "发布后提交验证", secondary: ["需要继续处理"], moves: ["inbox", "in_progress", "on_hold", "done"] },
  on_hold: { primary: "继续处理", secondary: ["退回待处理"], moves: ["inbox", "development_complete", "pending_verification", "done"] },
  pending_verification: { primary: "验证通过", secondary: ["需要继续处理"], moves: ["inbox", "in_progress", "development_complete", "on_hold"] },
  done: { primary: "重新打开", moves: ["inbox", "in_progress", "development_complete", "on_hold", "pending_verification", "cancelled"] },
  cancelled: { primary: "恢复", moves: ["ready", "in_progress", "development_complete", "on_hold", "pending_verification", "done"] },
};

async function createItem(request: APIRequestContext, status: Status = "ready") {
  const response = await request.post("/api/v1/items", { data: {
    productId: fixture.productId, title: "List menu regression", description: "Isolated menu fixture",
    type: "requirement", priority: "normal", status: "ready", environment: { platform: "web" },
  } });
  expect(response.ok()).toBeTruthy();
  const item = await response.json() as { key: string };
  if (status !== "ready") {
    const moved = await request.post(`/api/v1/items/${item.key}/transitions`, { data: { to: status, reason: "manual_override", note: "Prepare menu test state" } });
    expect(moved.ok()).toBeTruthy();
  }
  return item;
}

async function openListMenu(page: Page, key: string, status = "all") {
  await page.goto(`/?product=${fixture.productId}&status=${status}&q=${key}`);
  const row = page.locator(".item-row").filter({ has: page.locator("code", { hasText: new RegExp(`^${key}$`) }) });
  const menu = row.locator(".row-more-menu");
  await menu.locator(":scope > summary").click();
  return { row, menu };
}

async function expectWithinViewport(locator: Locator, width: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`list menu ${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 375, isMobile: width === 375 });

    test("every status keeps its actions, grouped icons and nested destinations", async ({ page, request }) => {
      test.setTimeout(120_000);
      for (const status of statuses) {
        const item = await createItem(request, status);
        const { menu } = await openListMenu(page, item.key, status === "cancelled" ? "cancelled" : "all");
        await expect(menu.locator(".detail-action-heading")).toHaveText(["协作管理", "状态操作", "工具"]);
        await expect(menu.locator(".detail-action-group").nth(1).locator(":scope > button")).toHaveText([cases[status].primary, ...(cases[status].secondary ?? [])]);
        await expect(menu.getByRole("button", { name: cases[status].primary, exact: true })).toBeVisible();
        await expect(menu.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
        await expect(menu.getByRole("button", { name: "迁移条目", exact: true })).toBeVisible();
        await expect(menu.getByRole("button", { name: "状态检查", exact: true })).toHaveCount(0);
        await expect(menu.getByRole("button", { name: "转交处理人", exact: true })).toHaveCount(0);
        await expect(menu.locator("button.danger")).toHaveCount(status === "done" || status === "cancelled" ? 0 : 1);
        // Every direct operation has a decorative icon; destinations are initially hidden.
        for (const button of await menu.locator(".detail-action-group > button").all()) await expect(button.locator("svg[aria-hidden='true']")).toHaveCount(1);
        const move = menu.locator(".detail-move-menu");
        await expect(move.locator("button").first()).toBeHidden();
        await move.locator("summary").click();
        await expect(move.locator("button")).toHaveText(cases[status].moves.map(target => labels[target]));
        await expectWithinViewport(move.locator(".detail-move-popover"), width);
        await move.locator("button").last().scrollIntoViewIfNeeded();
        await expect(move.locator("button").last()).toBeInViewport();
        const cancel = menu.locator("button.danger");
        if (await cancel.count()) {
          await cancel.scrollIntoViewIfNeeded();
          await expect(cancel).toBeInViewport();
        }
        if (status === "ready") await page.screenshot({ path: test.info().outputPath("list-menu.png") });
        await page.keyboard.press("Escape");
        await expect(menu).not.toHaveAttribute("open", "");
        await expect(move).not.toHaveAttribute("open", "");
        await menu.locator(":scope > summary").click();
        await expect(move.locator("button").first()).toBeHidden();
        await page.locator(".workspace-head h1").click();
        await expect(menu).not.toHaveAttribute("open", "");
        await expect(page).not.toHaveURL(/&item=/);
      }
    });

    test("start, return reason, manual move, cancel and edit still work", async ({ page, request }) => {
      const item = await createItem(request);
      const { row, menu } = await openListMenu(page, item.key);
      await menu.getByRole("button", { name: "开始处理", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "人工处理", exact: false }).click();
      await expect(row.locator(".status-pill")).toHaveText(labels.in_progress);
      await menu.locator(":scope > summary").click();
      // Returning work must still collect a note before it changes state.
      await menu.getByRole("button", { name: "释放任务", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox").fill("Additional investigation needed");
      await dialog.locator("button[type='submit']").click();
      await expect(row.locator(".status-pill")).toHaveText(labels.ready);
      await menu.locator(":scope > summary").click();
      await menu.locator(".detail-move-menu > summary").click();
      await menu.locator(".detail-move-popover").getByRole("button", { name: labels.pending_verification, exact: true }).click();
      await expect(row.locator(".status-pill")).toHaveText(labels.pending_verification);
      await menu.locator(":scope > summary").click();
      await menu.locator("button.danger").click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("button[type='submit']")).toBeDisabled();
      await dialog.getByRole("textbox").fill("No longer needed");
      await dialog.locator("button[type='submit']").click();
      await expect(row).toHaveCount(0);
      const cancelled = await openListMenu(page, item.key, "cancelled");
      await expect(cancelled.row.locator(".status-pill")).toHaveText(labels.cancelled);
      await cancelled.menu.getByRole("button", { name: "编辑", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`item=${item.key}`));
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("form")).toBeVisible();
    });

    test("list and detail share the same group and action styling", async ({ page, request }) => {
      const item = await createItem(request);
      const { menu } = await openListMenu(page, item.key);
      const presentation = (root: Locator) => root.evaluate(element => {
        const popup = element.querySelector(".detail-actions-popover")!;
        const heading = element.querySelector(".detail-action-heading")!;
        const action = element.querySelector(".detail-action-group > button")!;
        const style = getComputedStyle(popup);
        const text = getComputedStyle(heading);
        const button = getComputedStyle(action);
        return { width: style.width, padding: style.padding, background: style.backgroundColor, radius: style.borderRadius,
          headingColor: text.color, headingSize: text.fontSize, actionSize: button.fontSize, actionHeight: button.minHeight, gap: button.gap };
      });
      const listStyle = await presentation(menu);
      await page.screenshot({ path: test.info().outputPath("list-menu-collapsed.png") });
      await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
      const detailMenu = page.locator(".detail-toolbar .detail-more-menu");
      await detailMenu.locator(":scope > summary").click();
      expect(await presentation(detailMenu)).toEqual(listStyle);
      await page.screenshot({ path: test.info().outputPath("detail-menu.png") });
    });

    test("read-only permission and transferred source hide list operations", async ({ page, request }) => {
      const item = await createItem(request);
      await page.route(/\/api\/v1\/(bootstrap|products)(\?|$)/, async route => {
        const response = await route.fetch();
        const data = await response.json();
        const readOnly = (product: object) => ({ ...product, access: { canOperate: false, canUseAi: true } });
        await route.fulfill({ response, json: Array.isArray(data) ? data.map(readOnly) : { ...data, products: data.products.map(readOnly) } });
      });
      await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}`);
      await expect(page.locator(".item-row")).toHaveCount(1);
      await expect(page.locator(".row-more-menu")).toHaveCount(0);
      await page.unrouteAll({ behavior: "wait" });
      const productResponse = await request.post("/api/v1/products", { data: { name: "Menu transfer destination", keyPrefix: `M${randomUUID().slice(0, 7).toUpperCase()}` } });
      expect(productResponse.ok()).toBeTruthy();
      const target = await productResponse.json() as { id: string };
      const { menu } = await openListMenu(page, item.key);
      await menu.getByRole("button", { name: "迁移条目", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await chooseOption(dialog.getByLabel("目标产品"), target.id);
      await dialog.getByRole("button", { name: "下一步", exact: true }).click();
      await dialog.getByRole("button", { name: "迁移条目", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`product=${target.id}`));
      await page.goto(`/?product=${fixture.productId}&status=cancelled&q=${item.key}`);
      await expect(page.locator(".item-row")).toHaveCount(1);
      await expect(page.locator(".row-more-menu")).toHaveCount(0);
    });
  });
}

test("short landscape viewport keeps all submenu targets reachable", async ({ page, request }) => {
  await page.setViewportSize({ width: 812, height: 375 });
  const item = await createItem(request, "done");
  const { menu } = await openListMenu(page, item.key);
  await menu.locator(".detail-move-menu > summary").click();
  const last = menu.locator(".detail-move-popover button").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expectWithinViewport(menu.locator(".detail-more-menu-popover"), 812);
});
