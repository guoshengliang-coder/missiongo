import { expect, test } from "@playwright/test";
import { openConversationFilters, closeConversationFilters, openConsoleSearch, chooseSessionStatus } from "./console-helpers";
import { chooseOption } from "./select-helpers";

for (const width of [320, 360, 520, 521, 1023, 1024]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width <= 520, colorScheme: theme });
    test("AND-509 two rows, filters and search retain independent state", async ({ page, request }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-11-08T10:00:00Z"));
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const product = await (await request.post("/api/v1/products", { data: { name: "Very long project name 项目名称", keyPrefix: `TB${width}${theme[0]}` } })).json();
      const stamp = "2026-11-08T10:00:00Z";
      const base = { productId: product.id, agentKind: "codex", status: "idle", createdAt: stamp, updatedAt: stamp,
        activityAt: stamp, mode: "auto", dispatchStatus: "launched", nodeName: "Fixture", nodeConnectionState: "online",
        nodeRevoked: false, activities: [], settings: {}, canReply: true, canArchive: true,
        unread: false, attention: { state: "not_needed" }, needsAttention: false, items: [] };
      const sessions = [
        { ...base, id: "discussion", agentSessionId: "discussion", sessionName: "项目讨论", status: "active" },
        { ...base, id: "task", agentSessionId: "task", sessionName: "研发任务", items: [{ key: "TB-1", title: "研发任务", productId: product.id }] },
        { ...base, id: "integration", agentSessionId: "integration", sessionName: "集成任务", sessionPurpose: "integration", agentKind: "opencode" },
      ];
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions } }));
      await page.goto(`/?product=${product.id}&console=agent`);
      const rows = page.locator(".agent-console-session");
      await expect(rows).toHaveCount(3);
      if (width <= 1023) {
        for (const scale of ["small", "medium", "large"]) {
          await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
          await expect(async () => {
            const geometry = await page.evaluate(() => {
              const bar = document.querySelector(".agent-console-topbar")!;
              const buttons = [bar.querySelector(".back-button")!, bar.querySelector(".product-switcher")!, bar.querySelector(".merge-entry")!, bar.querySelector("summary")!];
              const controls = document.querySelector(".agent-console-list-controls")!.getBoundingClientRect();
              const list = document.querySelector(".agent-console-session-list")!.getBoundingClientRect();
              const icon = bar.querySelector(".product-badge")!.getBoundingClientRect();
              const value = bar.querySelector(".single-select-value")!.getBoundingClientRect();
              const arrow = bar.querySelector(".single-select-arrow")!.getBoundingClientRect();
              return { bar: bar.getBoundingClientRect().toJSON(), controls: controls.toJSON(), listTop: list.top,
                buttons: buttons.map(button => button.getBoundingClientRect().toJSON()), icon: icon.toJSON(), value: value.toJSON(), arrow: arrow.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth };
            });
            expect(geometry.overflow).toBe(false);
            expect(geometry.bar.height).toBeLessThanOrEqual(65);
            expect(geometry.listTop - geometry.controls.top).toBeLessThanOrEqual(60);
            expect(geometry.controls.top - geometry.bar.bottom).toBeLessThanOrEqual(12);
            for (const button of geometry.buttons) {
              expect(button.height).toBeGreaterThanOrEqual(44);
              expect(button.width).toBeGreaterThanOrEqual(44);
              expect(button.left).toBeGreaterThanOrEqual(0);
              expect(button.right).toBeLessThanOrEqual(width);
              expect(Math.abs(button.top - geometry.buttons[0]!.top)).toBeLessThanOrEqual(1);
            }
            expect(geometry.icon.width).toBeGreaterThanOrEqual(20);
            expect(geometry.icon.left).toBeGreaterThanOrEqual(geometry.value.left);
            expect(geometry.icon.right).toBeLessThanOrEqual(geometry.value.right);
            expect(geometry.arrow.right).toBeLessThanOrEqual(geometry.buttons[1]!.right);
          }).toPass();
        }
        await expect(page.locator(".product-switcher .agent-unread-badge")).toHaveCount(0);
        await expect(page.locator(".agent-console-search-trigger")).toBeHidden();
      } else {
        await expect(page.locator(".agent-console-filters")).toBeVisible();
        await expect(page.locator(".agent-console-combined-filter")).toHaveCount(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`and509-${width}-${theme}.png`) });
      await openConsoleSearch(page);
      const search = page.locator(".agent-console-search input");
      await search.fill("研发任务");
      await expect(rows).toHaveCount(1);
      if (width <= 1023) {
        await search.press("Escape");
        await expect(page.locator(".agent-console-topbar-more > summary")).toBeFocused();
        await expect(rows).toHaveCount(1);
        await openConsoleSearch(page);
        await expect(search).toHaveValue("研发任务");
      }
      await search.fill("");
      if (width <= 1023) await search.press("Escape");
      await openConversationFilters(page);
      await chooseOption(page.getByRole("combobox", { name: "会话类型筛选", exact: true }), "linked");
      await closeConversationFilters(page);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("研发任务");
      await chooseOption(page.getByRole("combobox", { name: "Agent 筛选", exact: true }), "opencode");
      await expect(rows).toHaveCount(0);
      await chooseOption(page.getByRole("combobox", { name: "Agent 筛选", exact: true }), "all");
      await openConversationFilters(page);
      await chooseOption(page.getByRole("combobox", { name: "会话类型筛选", exact: true }), "all");
      if (width <= 1023) {
        const state = page.getByRole("combobox", { name: "会话状态筛选", exact: true });
        await state.click();
        for (const label of ["待我处理", "未读会话", "运行中", "全部会话", "异常", "已收藏", "已归档"]) await expect(page.getByRole("option", { name: new RegExp(`^${label}`) })).toBeAttached();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "会话筛选", exact: true })).toBeVisible();
        await closeConversationFilters(page);
        await expect(page.locator(".agent-console-combined-filter")).toBeFocused();
        await chooseSessionStatus(page, "active");
      } else await page.locator(".agent-console-filters").getByRole("button", { name: /^运行中/ }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("项目讨论");
      expect(errors).toEqual([]);
    });
  });
}

test.describe("unread badge pressure", () => {
  test.use({ viewport: { width: 320, height: 900 }, hasTouch: true, isMobile: true });
  test("AND-509 keyboard search retires the menu and Back only closes search", async ({ page, request }) => {
    await page.clock.setFixedTime(new Date("2026-11-08T10:00:00Z"));
    const product = await (await request.post("/api/v1/products", { data: { name: "Keyboard search", keyPrefix: "KS509" } })).json();
    await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: [] } }));
    await page.goto(`/?product=${product.id}&console=agent`);
    const more = page.locator(".agent-console-topbar-more");
    await more.locator("summary").click();
    await page.keyboard.press("Control+k");
    const input = page.locator(".agent-console-search input");
    await expect(input).toBeVisible();
    await expect(more).not.toHaveAttribute("open", "");
    await input.fill("保留搜索条件");
    await page.goBack();
    await expect(input).toBeHidden();
    await expect(more.locator("summary")).toBeFocused();
    await expect(page).toHaveURL(/console=agent/);
    await openConsoleSearch(page);
    await expect(input).toHaveValue("保留搜索条件");
  });

  test("AND-509 nonzero unread retains its exact accessible count without clipping the icon", async ({ page, request }) => {
    await page.clock.setFixedTime(new Date("2026-11-08T10:00:00Z"));
    const product = await (await request.post("/api/v1/products", { data: { name: "长项目名称 Long product", keyPrefix: "UB509" } })).json();
    const stamp = "2026-11-08T10:00:00Z";
    await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: Array.from({ length: 120 }, (_, index) => ({
      id: `unread-${index}`, agentSessionId: `unread-${index}`, productId: product.id,
      sessionName: `未读 ${index}`, agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched",
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, unread: true, unreadAt: stamp,
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
      items: [], activities: [], settings: {}, attention: { state: "not_needed" }, needsAttention: false,
    })) } }));
    await page.goto(`/?product=${product.id}&console=agent`);
    const badge = page.locator(".product-switcher .agent-unread-badge");
    await expect(badge).toHaveText("99+");
    await expect(badge).toHaveAccessibleName("120 个未读（不含运行中）");
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      const boxes = await page.locator(".product-switcher").evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, parts: [...el.querySelectorAll(".product-badge,.agent-unread-badge,.single-select-arrow")].map(child => child.getBoundingClientRect().toJSON()) };
      });
      for (const part of boxes.parts) {
        expect(part.left).toBeGreaterThanOrEqual(boxes.left);
        expect(part.right).toBeLessThanOrEqual(boxes.right);
      }
      expect(boxes.parts[0]!.right).toBeLessThanOrEqual(boxes.parts[1]!.left);
      expect(boxes.parts[1]!.right).toBeLessThanOrEqual(boxes.parts[2]!.left);
    }
    await page.getByRole("combobox", { name: "当前产品", exact: true }).click();
    await expect(page.getByRole("option", { name: /长项目名称 Long product/ })).toHaveAccessibleName(/120 个未读/);
  });
});
