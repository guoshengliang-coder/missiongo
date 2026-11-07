import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { advanceSessionListPoll } from "./polling";

function sessions(productId: string) {
  const stamp = new Date().toISOString();
  return Array.from({ length: 44 }, (_, index) => ({
    id: `layout-${index}`, agentSessionId: `layout-${index}`, productId,
    agentKind: ["codex", "opencode", "claude_code"][index % 3],
    status: [0, 12, 42].includes(index) ? "active" : "idle",
    createdAt: stamp, updatedAt: stamp, activityAt: stamp,
    sessionName: `布局预览 ${index}`, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
    mode: "auto", dispatchStatus: "launched", activities: [], settings: {},
    canReply: true, canArchive: true, unread: false, attention: { state: "not_needed" }, needsAttention: false,
    items: index >= 12 && index < 42 ? [{ key: `LAY-${index}`, title: "条目任务", productId }] : [],
    ...(index >= 42 ? { sessionPurpose: "integration" } : {}),
  }));
}

async function menuFits(page: Page, menu: Locator) {
  await expect(async () => {
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 8);
    const rows = await menu.locator(".agent-console-option").evaluateAll(elements => elements.map(row => {
      const label = row.firstElementChild!;
      const counts = row.querySelector(".agent-console-option-counts")!;
      const range = document.createRange(); range.selectNodeContents(label);
      return { lines: range.getClientRects().length, label: label.getBoundingClientRect().right,
        countsLeft: counts.getBoundingClientRect().left, countsRight: counts.getBoundingClientRect().right,
        right: row.getBoundingClientRect().right };
    }));
    for (const row of rows) {
      expect(row.lines).toBe(1);
      expect(row.label).toBeLessThanOrEqual(row.countsLeft);
      expect(row.countsRight).toBeLessThanOrEqual(row.right + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }).toPass();
}

for (const width of [320, 520, 521, 1023, 1024, 1440, 1847]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width <= 520, isMobile: width <= 520, colorScheme: theme });
    test("AND-459 labels, ratios and selected outline fit both menus", async ({ page, request }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const product = await (await request.post("/api/v1/products", { data: { name: "Select layout", keyPrefix: `SL${width}${theme[0]}` } })).json();
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: sessions(product.id) } }));
      await page.goto(`/?product=${product.id}&console=agent`);
      await expect(page.locator(".agent-console-session")).toHaveCount(44);
      const association = page.getByRole("combobox", { name: "关联条目筛选", exact: true });
      const agent = page.getByRole("combobox", { name: "Agent 筛选", exact: true });
      for (const control of [association, agent]) {
        await control.click();
        const menu = page.getByRole("listbox");
        await expect(menu.getByRole("option").first()).toHaveAccessibleName(/3 个运行中，共 44 个会话/);
        await expect(menu.locator(".single-select-option > svg")).toHaveCount(0);
        const selected = menu.getByRole("option", { selected: true });
        for (const scale of ["small", "medium", "large"]) {
          await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
          await menuFits(page, menu);
          await expect(selected).toHaveCSS("outline-width", "2px");
        }
        if (width === 1847) await page.screenshot({ path: testInfo.outputPath(control === association ? "association.png" : "agent.png") });
        await page.keyboard.press("Escape");
        await expect(control).toBeFocused();
      }
      expect(errors).toEqual([]);
    });
  });
}

test("AND-459 zero, active, archived and changing counts retain their list scope", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  const product = await (await request.post("/api/v1/products", { data: { name: "Ratio scope", keyPrefix: "RSC" } })).json();
  let rows = sessions(product.id);
  const stamp = new Date().toISOString();
  await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: [
    ...rows, { ...rows[0], id: "archived", agentSessionId: "archived", archivedAt: stamp },
    { ...rows[0], id: "failed", agentSessionId: "failed", status: "failed" },
  ] } }));
  await page.goto(`/?product=${product.id}&console=agent`);
  const association = page.getByRole("combobox", { name: "关联条目筛选", exact: true });
  const agent = page.getByRole("combobox", { name: "Agent 筛选", exact: true });
  const list = page.locator(".agent-console-session");
  const menu = page.getByRole("listbox");
  const nav = page.locator(".agent-console-filters");
  await expect(list).toHaveCount(44);
  await association.click();
  await expect(menu.getByRole("option", { name: /^无关联会话/ })).toHaveAccessibleName(/1 个运行中，共 12 个会话/);
  await menu.getByRole("option", { name: /^无关联会话/ }).click();
  await expect(list).toHaveCount(12);
  await agent.click();
  await expect(menu.getByRole("option", { name: /^OpenCode/ })).toHaveAccessibleName(/0 个运行中，共 4 个会话/);
  await menu.getByRole("option", { name: /^OpenCode/ }).click();
  await expect(list).toHaveCount(4);
  await association.click();
  await expect(menu.getByRole("option", { name: /^集成会话/ })).toHaveAccessibleName(/0 个运行中，共 1 个会话/);
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: /^运行中/ }).click();
  await expect(list).toHaveCount(0);
  await association.click();
  await expect(menu.getByRole("option", { name: /^全部/ })).toHaveAccessibleName(/0 个运行中，共 0 个会话/);
  await menu.getByRole("option", { name: /^全部/ }).click();
  await agent.click();
  await menu.getByRole("option", { name: /^全部 Agent/ }).click();
  await expect(list).toHaveCount(3);
  await association.click();
  await expect(menu.getByRole("option", { name: /^全部/ })).toHaveAccessibleName(/3 个运行中，共 3 个会话/);
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: /^已归档/ }).click();
  await expect(list).toHaveCount(1);
  await association.click();
  await expect(menu.getByRole("option", { name: /^全部/ })).toHaveAccessibleName(/0 个运行中，共 1 个会话/);
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: /^异常/ }).click();
  await expect(list).toHaveCount(1);
  await association.click();
  await expect(menu.getByRole("option", { name: /^全部/ })).toHaveAccessibleName(/0 个运行中，共 1 个会话/);
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: /^全部会话/ }).click();
  await association.click();
  const before = (await menu.boundingBox())!.width;
  rows = Array.from({ length: 100 }, (_, index) => ({ ...rows[0]!, id: `new-${index}`, agentSessionId: `new-${index}` }));
  await advanceSessionListPoll(page);
  await expect(menu.getByRole("option", { name: /^全部/ })).toHaveAccessibleName(/100 个运行中，共 100 个会话/);
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(before);
  await menuFits(page, menu);
  await page.setViewportSize({ width: 320, height: 500 });
  await menuFits(page, menu);
  await menu.getByRole("option", { name: /^全部/ }).click();
  await expect(list).toHaveCount(100);
  expect(errors).toEqual([]);
});

test("AND-459 oversized counts wrap as a group at the viewport limit", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 });
  const harness = fileURLToPath(new URL("./select-counts-harness.tsx", import.meta.url));
  await page.route("**/__select-counts", route => route.fulfill({ contentType: "text/html", body:
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><html data-font-scale="large"><body><div id="root"></div><script type="module" src="/@fs/${harness}"></script></body></html>` }));
  await page.goto("/__select-counts");
  await page.getByRole("combobox", { name: "多位数菜单" }).click();
  const menu = page.getByRole("listbox");
  await expect(async () => {
    const geometry = await menu.evaluate(el => {
      const row = el.querySelector(".agent-console-option")!;
      const label = row.firstElementChild!.getBoundingClientRect();
      const counts = row.querySelector(".agent-console-option-counts")!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(row.firstElementChild!);
      return { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
        labelBottom: label.bottom, lines: range.getClientRects().length,
        countsTop: counts.top, countsLeft: counts.left, countsRight: counts.right,
        overflow: el.scrollWidth > el.clientWidth };
    });
    expect(geometry.lines).toBe(1);
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(312);
    expect(geometry.countsTop).toBeGreaterThanOrEqual(geometry.labelBottom);
    expect(geometry.countsLeft).toBeGreaterThan(geometry.left);
    expect(geometry.countsRight).toBeLessThan(geometry.right);
    expect(geometry.overflow).toBe(false);
  }).toPass();
  await page.setViewportSize({ width: 1440, height: 500 });
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(304);
});
