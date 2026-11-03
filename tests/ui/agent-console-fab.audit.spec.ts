import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/**
 * The console entry leaves the phone topbar (AND-374).
 *
 * At 520px and below the list topbar gives the button up to a floating one
 * above the capture button; the detail page has no capture button to sit
 * above, so it keeps the topbar entry. The count is drawn only when there is
 * something unread, unlike the topbar badge which always shows a number.
 */

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8"),
) as { productId: string; detailKey: string };

const LIST_URL = `/?product=${fixture.productId}&status=all`;
const DETAIL_URL = `/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`;

test.describe("phone portrait", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("floats above the capture button and replaces the topbar entry", async ({ page }) => {
    await page.goto(LIST_URL);
    await page.waitForLoadState("networkidle");

    const fab = page.locator(".ai-console-fab");
    await expect(fab).toBeVisible();
    await expect(page.locator(".topbar .ai-console-toggle")).toBeHidden();

    const fabBox = await fab.boundingBox();
    const captureBox = await page.locator(".mobile-fab").boundingBox();
    expect(fabBox).not.toBeNull();
    expect(captureBox).not.toBeNull();
    if (!fabBox || !captureBox) return;
    expect(fabBox.y + fabBox.height).toBeLessThan(captureBox.y);
    expect(Math.abs((fabBox.x + fabBox.width) - (captureBox.x + captureBox.width))).toBeLessThan(1);

    await fab.click();
    await expect(page.locator(".agent-console-page")).toBeVisible();
  });

  test("keeps the topbar entry on a detail page", async ({ page }) => {
    await page.goto(DETAIL_URL);
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".ai-console-fab")).toBeHidden();
    await expect(page.locator(".topbar .ai-console-toggle")).toBeVisible();
  });
});

test.describe("phone landscape", () => {
  test.use({ viewport: { width: 812, height: 375 }, hasTouch: true, isMobile: true });

  test("keeps the topbar entry once there is width for it", async ({ page }) => {
    await page.goto(LIST_URL);
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".ai-console-fab")).toBeHidden();
    await expect(page.locator(".topbar .ai-console-toggle")).toBeVisible();
  });
});

test.describe("unread count", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("draws the badge only when something is unread", async ({ page }) => {
    await stubUnreadSession(page, fixture.productId);
    await page.goto(LIST_URL);
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".ai-console-fab .agent-unread-badge")).toHaveText("1");
  });

  test("draws no badge at zero", async ({ page }) => {
    await page.goto(LIST_URL);
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".ai-console-fab")).toBeVisible();
    await expect(page.locator(".ai-console-fab .agent-unread-badge")).toHaveCount(0);
  });
});

/** One idle, unread session, which is what the badge counts. */
async function stubUnreadSession(page: Page, productId: string): Promise<void> {
  const now = "2026-11-03T03:00:00.000Z";
  const session = {
    id: "and-374-unread-fixture",
    agentSessionId: "and-374-unread-fixture",
    dispatchId: "dispatch-and-374",
    agentKind: "opencode",
    status: "idle",
    updatedAt: now,
    activityAt: now,
    nodeName: "fixture-node",
    nodeConnectionState: "online",
    nodeRevoked: false,
    mode: "bypass",
    dispatchStatus: "in_progress",
    createdAt: now,
    items: [{ key: "AND-374", title: "宽度不足时Agent控制台转为悬浮按钮", productId }],
    activities: [],
    canReply: true,
    attention: { state: "not_needed" },
    needsAttention: false,
    waitingForReply: false,
    canRetry: false,
    canStop: false,
    canArchive: false,
    nodeId: "node-and-374",
    settings: {},
    unread: true,
  };

  await page.route("**/api/v1/agent-sessions**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [session] }),
    });
  });
}
