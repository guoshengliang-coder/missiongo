import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8",
)) as { productId: string };
const id = "and-272-approval-fixture";
const now = "2026-09-30T09:00:00.000Z";
const summary = {
  id, agentSessionId: id, dispatchId: "and-272-dispatch", agentKind: "codex",
  status: "active", updatedAt: now, activityAt: now, nodeName: "Fixture",
  nodeConnectionState: "online", nodeRevoked: false, mode: "auto",
  dispatchStatus: "in_progress", createdAt: now, nodeId: "and-272-node",
  items: [{ key: "AND-272", title: "授权提示块显示", productId: fixture.productId }],
  activities: [], settings: {}, unread: false, canReply: true, canRetry: false,
  canStop: true, canArchive: true, attention: { state: "not_needed" },
  needsAttention: false, waitingForReply: false,
};
const approval = {
  id: "review", kind: "auto", status: "inProgress", turnId: "turn",
  action: "Fixture permission request", startedAtMs: 1,
};

test("only shows Codex authorization when a person must intervene", async ({ page }, testInfo) => {
  let current: Record<string, unknown> | undefined = approval;
  // Keep a stale denial in the list throughout: the detail response must be
  // authoritative when the request completes or disappears.
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ status: 204 });
    const body = new URL(request.url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [{ ...summary, approval: { ...approval, status: "denied" } }] }
      : { ...summary, messages: [], ...(current ? { approval: current } : {}) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const panel = page.locator(".agent-console-approval");
  const open = async () => {
    await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
    await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  };
  for (const value of [
    approval, { ...approval, status: "approved" }, undefined,
    { ...approval, status: "denied", retryId: "retry", retryStatus: "queued" },
    { ...approval, status: "denied", retryId: "retry", retryStatus: "restored" },
  ]) {
    current = value;
    await open();
    await expect(panel).toHaveCount(0);
  }
  current = { ...approval, kind: "manual", status: "pending" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button")).toHaveCount(2);
  current = { ...approval, kind: "manual", status: "pending", decision: "accept" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button").first()).toBeDisabled();
  current = { ...approval, kind: "manual", status: "unavailable", reason: "授权连接重连中，旧决定已失效" };
  await open();
  await expect(panel).toContainText("授权连接重连中，旧决定已失效");
  await expect(panel.locator("button")).toHaveCount(0);
  current = { ...approval, status: "denied" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button")).toBeEnabled();
  current = { ...approval, status: "denied", retryId: "retry", retryStatus: "failed", retryError: "Fixture retry failed" };
  await open();
  await expect(panel).toContainText("Fixture retry failed");
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const viewport of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }]) {
    // Crossing the console layout breakpoint changes browser history. Resize
    // outside the app so its pending history.back cannot race the next link.
    await page.goto("about:blank");
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      current = { ...approval, status: "approved" };
      await open();
      await expect(panel).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const name = viewport.name + "-" + theme;
      const path = testInfo.outputPath(name + ".png");
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
  }
});

test("Simulator approval stays visible through delivery and clears after source resolution", async ({ page }, testInfo) => {
  let current = { ...approval, kind: "manual", status: "pending", decision: undefined as string | undefined,
    action: 'cua_repl：Allow Computer Use to use "Simulator"?', reason: "仅回复这一次请求，不授予会话或永久权限。" };
  const decisions: unknown[] = [];
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    if (route.request().method() === "POST") {
      decisions.push(route.request().postDataJSON());
      current = { ...current, decision: "accept" };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ approval: current }) });
    }
    const session = { ...summary, turnState: { turnActive: true, waitingForInput: current.status === "pending" },
      attention: { state: "needed", kind: "approval" }, needsAttention: true, approval: current };
    const body = new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [session] } : { ...session, messages: [] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  for (const viewport of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }]) {
    await page.goto("about:blank");
    await page.setViewportSize(viewport);
    current = { ...current, status: "pending", decision: undefined };
    await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
    const panel = page.locator(".agent-console-approval");
    await expect(panel).toContainText('Simulator');
    await expect(panel.locator("button").first()).toBeEnabled();
    await expect(page.locator(".agent-console-activity")).toContainText(/等待权限确认|waiting for permission/);
    const screenshot = testInfo.outputPath(viewport.name + "-simulator-approval.png");
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await testInfo.attach(viewport.name, { path: screenshot, contentType: "image/png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.locator("button").first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator("button").first()).toBeDisabled();
    await expect(panel).toContainText(/Decision queued|决定.*Mac/);
    current = { ...current, status: "resolved" };
    await expect(panel).toHaveCount(0, { timeout: 10_000 });
  }
  expect(decisions).toEqual([{ decision: "accept" }, { decision: "accept" }]);
});
