import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
test.use({ hasTouch: true });
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`favorite controls, archives and attention stay independent ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00.000Z"));
    const stamp = "2026-11-07T00:00:00.000Z";
    const row = (id: string, favorite = false, archived = false) => ({ id, agentSessionId: id, dispatchId: `dispatch-${id}`,
      productId: fixture.productId, agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", sessionName: id,
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, items: [], nodeName: "Fixture", nodeRevoked: false,
      nodeConnectionState: "online", activities: [], settings: { adjustable: false }, favorite,
      ...(archived ? { archivedAt: stamp } : {}), canReply: !archived, canRetry: false, canStop: false, canArchive: true,
      unread: false, waitingForReply: false, needsAttention: false,
      attention: { state: "needed", kind: "instruction", revision: id, reason: "等待发起合并", handledByDelivery: true } });
    const rows = [row("active-chat"), row("archived-chat", true, true),
      { ...row("today-chat"), sessionName: "当天长标题：允许重复派单与并行分支开发及会话列表排版", activityAt: "2026-11-08T10:00:00.000Z" },
      { ...row("older-chat"), sessionName: "跨天长标题：恢复会话列表紧凑排版并保留收藏功能", activityAt: "2026-10-28T00:00:00.000Z" },
      { ...row("independent-chat"), needsAttention: true,
      attention: { state: "needed", kind: "instruction", revision: "independent", reason: "请决定另一项独立安排", handledByDelivery: false } }];
    let failed = true, writes = 0;
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      const id = decodeURIComponent(path.split("/")[4] ?? ""); const current = rows.find(row => row.id === id);
      if (path.endsWith("/favorite")) {
        writes++;
        if (failed) return route.fulfill({ status: 503, json: { title: "Synthetic failure" } });
        current!.favorite = route.request().postDataJSON().favorite;
        return route.fulfill({ json: current });
      }
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: rows } : {
        ...current, messages: [{ id: "message", role: "agent", text: "Current message", occurredAt: stamp }] } });
    });
    await page.route("**/merge-deliveries", route => route.fulfill({ json: { deliveries: [], batches: [], attentionSessionIds: ["active-chat", "independent-chat"] } }));
    await page.goto(`/?product=${fixture.productId}&console=agent`);
    const activeRow = page.locator(".agent-console-session-row").filter({ hasText: "active-chat" });
    const star = activeRow.getByRole("button", { name: "收藏", exact: true });
    await expect(star).toBeVisible();
    // Measure actual rendered rows for mixed date lengths and all user font scales.
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; }, scale);
      for (const name of ["active-chat", "当天长标题", "跨天长标题"]) {
        const currentRow = page.locator(".agent-console-session-row").filter({ hasText: name });
        const geometry = await currentRow.evaluate(element => {
          const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const title = rect("strong"), time = rect("time"), star = rect(".agent-console-favorite-control button"), row = element.getBoundingClientRect();
          const overlaps = [...element.querySelectorAll(".agent-console-session-meta > *")].some(node => {
            const box = node.getBoundingClientRect();
            return box.left < star.right && box.right > star.left && box.top < star.bottom && box.bottom > star.top;
          });
          const timeElement = element.querySelector("time")!;
          return { titleRight: title.right, timeLeft: time.left, timeRight: time.right, rowRight: row.right,
            starRight: star.right, starWidth: star.width, starHeight: star.height, overlaps,
            clippedTime: timeElement.scrollWidth > timeElement.clientWidth };
        });
        expect(geometry.titleRight).toBeLessThanOrEqual(geometry.timeLeft);
        expect(geometry.rowRight - geometry.timeRight).toBeLessThanOrEqual(14);
        expect(geometry.rowRight - geometry.starRight).toBeLessThanOrEqual(10);
        expect(geometry.starWidth).toBeGreaterThanOrEqual(44);
        expect(geometry.starHeight).toBeGreaterThanOrEqual(44);
        expect(geometry.overlaps).toBe(false);
        expect(geometry.clippedTime).toBe(false);
      }
    }
    await expect(page.locator(".agent-console-session-row").filter({ hasText: "当天长标题" }).locator("time")).not.toContainText("昨天");
    await expect(page.locator(".agent-console-session-row").filter({ hasText: "跨天长标题" }).locator("time")).toContainText("10/28");
    await page.evaluate(() => { document.documentElement.dataset.fontScale = "medium"; });
    const starBox = await star.boundingBox(); expect(starBox!.width).toBeGreaterThanOrEqual(44); expect(starBox!.height).toBeGreaterThanOrEqual(44);
    await star.click();
    await expect(activeRow.getByRole("alert")).toContainText("收藏未能保存");
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".agent-console-conversation textarea")).toHaveCount(0);
    failed = false; await star.click(); await expect(activeRow.getByRole("button", { name: "取消收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(writes).toBe(2);
    const listStar = activeRow.getByRole("button", { name: "取消收藏", exact: true });
    const timeBox = await activeRow.locator("time").boundingBox();
    const listStarBox = await listStar.boundingBox();
    expect(listStarBox!.y).toBeGreaterThanOrEqual(timeBox!.y + timeBox!.height);
    await expect(activeRow.locator("time")).toContainText("昨天");
    // AND-473 restores the compact right edge, without centering a star under a long date.
    expect(Math.abs((listStarBox!.x + listStarBox!.width) - (timeBox!.x + timeBox!.width))).toBeLessThanOrEqual(6);
    const rowBox = await activeRow.boundingBox(), openBox = await activeRow.locator(".agent-console-session").boundingBox();
    expect(openBox!.width).toBeGreaterThanOrEqual(rowBox!.width - 2);
    await page.screenshot({ path: testInfo.outputPath("favorite-list-states.png"), fullPage: true });
    await activeRow.locator(".agent-console-session").click();
    const draft = page.locator(".agent-console-reply textarea"); await draft.fill("Keep favorite draft");
    await expect(page.locator(".agent-console-attention-banner")).toHaveCount(0);
    await expect(activeRow.locator(".agent-console-attention")).toHaveCount(0);
    await expect(page.locator(".agent-console-filters button").filter({ hasText: "待我处理" }).locator("small")).toHaveText("1");
    const detailStar = page.locator(".agent-console-actions").getByRole("button", { name: "取消收藏", exact: true });
    await expect(detailStar).toHaveAttribute("aria-pressed", "true");
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await detailStar.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath("favorite-detail.png"), fullPage: true });
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath("favorite-selected.png"), clip: { x: 0, y: 0, width: 1440, height: 360 } });
    await detailStar.click(); await expect(draft).toHaveValue("Keep favorite draft");
    await expect(page.locator(".agent-console-actions").getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "false");
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath("favorite-unselected.png"), clip: { x: 0, y: 0, width: 1440, height: 360 } });
    await page.reload();
    // The filter deep link must include archived favorites and keep their details read-only.
    await page.goto(`/?product=${fixture.productId}&console=agent&consoleFilter=favorites&session=archived-chat`);
    await expect(page.locator(".agent-console-session")).toHaveCount(1);
    await expect(page.locator(".agent-console-filters button").filter({ hasText: "已收藏" }).locator("small")).toHaveText("1");
    await expect(page.locator(".agent-console-session")).toContainText("已归档");
    await expect(page.locator(".agent-console-actions").getByRole("button", { name: "取消收藏", exact: true })).toBeVisible();
    await page.goto(`/?product=${fixture.productId}&console=agent&session=independent-chat`);
    await expect(page.locator(".agent-console-session").filter({ hasText: "independent-chat" }).locator(".agent-console-attention")).toHaveText("待下指令");
    await expect(page.locator(".agent-console-attention-banner")).toBeVisible();
    await page.locator(".agent-console-attention-banner summary").click();
    await expect(page.locator(".agent-console-attention-detail")).toContainText("请决定另一项独立安排");
  });
}
