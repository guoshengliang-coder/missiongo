import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`panel receipt disappears only after its user mirror ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install();
    await page.clock.setFixedTime(new Date("2026-11-13T03:19:00Z"));
    const id = "panel-receipt", stamp = "2026-11-13T00:00:00Z";
    let status = "queued", mirrored = false;
    const text = "这条回复保留投递与执行边界";
    const summary = { id, agentSessionId: id, dispatchId: "receipt-dispatch", agentKind: "codex", status: "idle",
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", mode: "auto",
      canReply: true, canRetry: false, canStop: false, canArchive: true, settings: {}, activities: [], unread: false,
      items: [{ key: fixture.detailKey, title: "Feedback fixture", productId: fixture.productId }],
      attention: { state: "not_needed" }, needsAttention: false };
    await page.route("**/api/v1/agent-sessions**", route => {
      const command = { id: "reply", kind: "message", status, text, createdAt: stamp };
      return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] }
        : { ...summary, command, messages: mirrored ? [{ id: "mirror", sourceId: command.id, role: "user", text, occurredAt: stamp }] : [] } });
    });
    await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
      id: "receipt-dispatch", agentSessionId: id, agentKind: "codex", mode: "auto", status: "launched", nodeName: "Fixture",
      itemKeys: [fixture.detailKey], createdAt: stamp,
    }] } }));
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
    await page.locator(".agent-session-toggle").click();
    const panel = page.locator(".agent-session-panel");
    const feedback = panel.locator(".agent-reply-feedback");
    await expect(feedback).toContainText("排队中");
    await expect(panel.getByText("暂时还没有可显示的消息。", {exact:true})).toHaveCount(0);
    await expect(panel.locator(".agent-session-messages .agent-reply-feedback")).toHaveCount(1);
    await expect(panel.locator(".agent-session-message .agent-reply-feedback")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "撤回编辑" })).toBeVisible();
    const bubble = panel.locator(".agent-session-outgoing > article");
    const bodyBounds = (await bubble.boundingBox())!;
    const receiptBounds = (await feedback.boundingBox())!;
    expect(receiptBounds.y - bodyBounds.y - bodyBounds.height).toBeCloseTo(4, 0);
    expect(receiptBounds.x + receiptBounds.width).toBeCloseTo(bodyBounds.x + bodyBounds.width, 0);
    status = "delivered";
    await advanceSessionDetailPoll(page);
    await expect(feedback).toContainText("已送达");
    await expect(panel.getByRole("button", { name: "撤回编辑" })).toHaveCount(0);
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath("panel-delivered.png") });
    mirrored = true;
    await advanceSessionDetailPoll(page);
    await expect(panel.locator(".agent-session-messages")).toContainText(text);
    await expect(feedback).toHaveCount(0);
  });
}
