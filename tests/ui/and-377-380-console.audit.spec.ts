import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentSessionCommand } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#265845"/></svg>';

for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) test.describe(`chat fixes ${theme} ${touch ? "touch" : "mouse"}`, () => {
  test.use({ colorScheme: theme, hasTouch: touch, isMobile: touch });
  test("image loading, retry, preview, download, delivery animation and toolbar alignment", async ({ page }) => {
    const id = "console-377-380", stamp = new Date().toISOString();
    let delivery: AgentSessionCommand["status"] = "queued";
    let sessionStatus = "active";
    let rejectImage = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holdImage = true;
    const attachment = { id: "chat-image", filename: "private-reference.svg", kind: "image", contentType: "image/svg+xml", sizeBytes: image.length, sha256: "fixture" };
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/preview")) {
        if (holdImage) await gate;
        return rejectImage ? route.fulfill({ status: 503, body: "unavailable" }) : route.fulfill({ contentType: "image/svg+xml", body: image });
      }
      if (path.endsWith("/content")) return route.fulfill({ contentType: "image/svg+xml", body: image });
      if (path.endsWith("/read")) return route.fulfill({ status: 204 });
      const command = { id: "queued-image", kind: "message", text: "图片消息", status: delivery, createdAt: stamp, attachments: [attachment] };
      const summary = { id, agentSessionId: id, agentKind: "codex", status: sessionStatus, updatedAt: stamp, activityAt: stamp, createdAt: stamp,
        nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched", settings: {}, activities: [],
        turnState: { turnActive: sessionStatus === "active", waitingForInput: false, turnStartedAt: stamp, observedAt: stamp, lastProgressAt: stamp },
        canReply: true, canStop: sessionStatus === "active", canArchive: true, canRetry: false, unread: false,
        items: [{ key: fixture.detailKey, title: "会话图片与状态", productId: fixture.productId }], attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, command };
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary, canAttach: true, messages: [] } });
    });
    await page.setViewportSize({ width: 1794, height: 955 });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`, { waitUntil: "domcontentloaded" });
    const tile = page.locator(".agent-chat-image");
    await expect(tile).toHaveAttribute("data-image-state", "loading");
    await expect(tile.getByRole("status")).toContainText("加载");
    await expect(tile).not.toContainText(attachment.filename);
    await expect(tile.getByRole("button", { name: /下载/ })).toHaveCount(0);
    const before = await tile.boundingBox();
    holdImage = false; release();
    await expect(tile).toHaveAttribute("data-image-state", "ready");
    expect((await tile.boundingBox())!.height).toBe(before!.height);
    const open = tile.getByRole("button");
    await open.click();
    const viewer = page.getByRole("dialog", { name: attachment.filename, exact: true });
    await expect(viewer.locator(".zoomable-image")).toBeVisible();
    await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
    await expect(viewer.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "true");
    const download = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "下载", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(attachment.filename);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(open).toBeFocused();
    await open.click(); await page.goBack(); await expect(viewer).toHaveCount(0);
    await expect(page.locator(".agent-console-conversation")).toBeVisible();
    await expect(page.locator(".agent-reply-queued")).toHaveCSS("animation-name", "pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".agent-reply-queued")).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const width of [320, 520, 521, 768, 1023, 1024, 1440, 1794]) {
      await page.setViewportSize({ width, height: width === 768 ? 375 : 955 });
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        const toolbar = page.locator(".agent-console-toolbar");
        await expect(toolbar).toBeVisible();
        const edges = await toolbar.locator('.status-pill:visible, .agent-console-actions button:visible, .dispatch-session-link a:visible').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; }));
        expect(edges.length).toBeGreaterThan(0);
        for (const edge of ["top", "bottom"] as const) expect(Math.max(...edges.map(r => r[edge])) - Math.min(...edges.map(r => r[edge])), `${width} ${scale} ${edge}`).toBeLessThanOrEqual(1);
        expect(Math.max(...edges.map(r => r.right))).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    rejectImage = true; await page.reload();
    await expect(tile).toHaveAttribute("data-image-state", "failed");
    rejectImage = false; await tile.getByRole("button", { name: "重试", exact: true }).click();
    await expect(tile).toHaveAttribute("data-image-state", "ready");
    delivery = "delivering"; await page.reload();
    await expect(page.locator(".agent-reply-sending")).toHaveCSS("animation-name", "spin");
    delivery = "delivered"; sessionStatus = "idle"; await page.reload();
    await expect(page.locator(".agent-reply-state")).toContainText("送达");
    await expect(page.locator(".agent-reply-queued, .agent-reply-sending")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`chat-fixes-${theme}.png`) });
  });
});

for (const source of ["list", "detail"] as const) test(`manual move confirmation is localized from ${source}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?product=${fixture.productId}&status=all&q=${fixture.detailKey}${source === "detail" ? `&item=${fixture.detailKey}` : ""}`);
  const menu = page.locator(source === "list" ? ".item-row .row-more-menu" : ".detail-pane .detail-more-menu").first();
  await menu.locator(":scope > summary").click();
  await menu.locator(".detail-move-menu > summary").click();
  await menu.getByRole("button", { name: "待验证", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator(".transition-note-form") });
  await dialog.locator("textarea").fill("按钮本地化验证");
  await expect(dialog.getByRole("button", { name: "移至待验证", exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText("pending_verification");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
