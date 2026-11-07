import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
test.use({ hasTouch: true });
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`favorite controls, archives and attention stay independent ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    const stamp = "2026-11-07T00:00:00.000Z";
    const row = (id: string, favorite = false, archived = false) => ({ id, agentSessionId: id, dispatchId: `dispatch-${id}`,
      productId: fixture.productId, agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", sessionName: id,
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, items: [], nodeName: "Fixture", nodeRevoked: false,
      nodeConnectionState: "online", activities: [], settings: { adjustable: false }, favorite,
      ...(archived ? { archivedAt: stamp } : {}), canReply: !archived, canRetry: false, canStop: false, canArchive: true,
      unread: false, waitingForReply: false, needsAttention: false,
      attention: { state: "needed", kind: "instruction", revision: id, reason: "等待发起合并", handledByDelivery: true } });
    const rows = [row("active-chat"), row("archived-chat", true, true), { ...row("independent-chat"), needsAttention: true,
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
    expect(Math.abs((listStarBox!.x + listStarBox!.width / 2) - (timeBox!.x + timeBox!.width / 2))).toBeLessThanOrEqual(4);
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
