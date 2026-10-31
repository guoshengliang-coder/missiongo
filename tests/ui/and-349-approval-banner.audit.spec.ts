import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "and-349-approval-banner";
const stamp = "2026-10-31T11:00:00.000Z";
const summary = {
  id, agentSessionId: id, dispatchId: "and-349-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp, nodeId: "fixture-node", settings: {}, unread: false,
  items: [{ key: "AND-349", title: "控制台待批准条排版异常", productId: fixture.productId }],
  activities: [], turnState: { turnActive: false }, canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "needed", kind: "approval", reason: "方案待批准", revision: "attention-revision" },
  needsAttention: true, waitingForReply: true,
};
const detail = {
  ...summary,
  messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "计划：调整待批准条的布局。", occurredAt: stamp }],
  planApprovalStatus: { code: "reply_pending" },
};

// AND-349: the disabled approval reason was laid out inside the action column,
// so its max-width stretched the button and squeezed the label beside it.
for (const width of [353, 375, 1440]) {
  test(`approval banner keeps one-line label and one-row actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/v1/agent-sessions**", (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail),
      });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const banner = page.locator(".agent-console-attention-banner");
    await expect(banner).toBeVisible();
    const label = banner.locator("summary");
    const approve = banner.getByRole("button", { name: /^(批准|Approve)$/ });
    const dismiss = banner.getByRole("button", { name: /^(无需处理|Dismiss)$/ });
    await expect(approve).toBeDisabled();
    await expect(dismiss).toBeVisible();
    await banner.scrollIntoViewIfNeeded();
    const path = testInfo.outputPath(`banner-${width}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`banner-${width}`, { path, contentType: "image/png" });

    const labelBox = (await label.boundingBox())!;
    const approveBox = (await approve.boundingBox())!;
    const dismissBox = (await dismiss.boundingBox())!;
    const reasonBox = (await banner.locator(".agent-console-approve-reason").boundingBox())!;
    const bannerBox = (await banner.boundingBox())!;
    // The label stays on one line instead of one character per line.
    expect(labelBox.height).toBeLessThan(32);
    // Approve and dismiss share a row, and the button is text-sized, not
    // stretched by the reason beside it.
    expect(Math.abs((approveBox.y + approveBox.height / 2) - (dismissBox.y + dismissBox.height / 2))).toBeLessThan(8);
    expect(approveBox.width).toBeLessThan(120);
    // The reason owns a full line below the actions and no longer sizes them.
    expect(reasonBox.y).toBeGreaterThanOrEqual(approveBox.y + approveBox.height - 1);
    expect(reasonBox.width).toBeGreaterThan(bannerBox.width * 0.6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
