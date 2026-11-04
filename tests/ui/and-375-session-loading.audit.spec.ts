import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const stamp = "2026-11-04T00:00:00.000Z";
const id = "and-375-loading";
const permission = { id: "permission", kind: "manual", status: "pending", action: "Loading fixture permission" };
const summary = {
  id, agentSessionId: id, dispatchId: "loading-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
  nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched", createdAt: stamp,
  items: [{ key: "EX-375", title: "Loading fixture", productId: fixture.productId }],
  activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: true, canArchive: true,
  attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false,
};
const message = { id: "message", role: "agent", text: "Conversation loaded", occurredAt: stamp };
const detail = { ...summary, messages: [message] };
const url = (sessionId = id) => `/?product=${fixture.productId}&console=agent&session=${sessionId}`;
const contentCards = ".agent-console-attention-banner, .agent-console-recovery, .agent-console-failure, .agent-run-status, .agent-console-connection-banner";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function mock(page: Page, sessions: unknown[], read: (sessionId: string) => Promise<{ status?: number; json?: unknown }>) {
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions } });
    return route.fulfill(await read(decodeURIComponent(path.split("/").at(-1)!)));
  });
}

const cases = [
  { name: "permission", extra: { approval: permission }, selector: ".agent-console-approval" },
  { name: "plan", extra: { needsAttention: true, attention: { state: "needed", kind: "approval", reason: "Review plan", revision: "plan" },
    planApproval: { revision: "plan", reason: "Review plan" }, planApprovalStatus: { code: "ready" } }, selector: ".agent-console-attention-banner--approval" },
  { name: "dismissed", extra: { attention: { state: "dismissed", dismissed: true, reason: "Dismissed fixture" } }, selector: ".agent-console-attention-banner.dismissed" },
  { name: "failure", extra: { status: "failed", failure: { code: "codex_server_error" } }, selector: ".agent-console-recovery" },
  { name: "offline", extra: { nodeConnectionState: "offline" }, selector: ".agent-console-connection-banner" },
];

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "phone", width: 375, height: 812, touch: true },
  { name: "small-phone", width: 320, height: 568, touch: true },
]) {
  for (const theme of ["light", "dark"] as const) test.describe(`${viewport.name} ${theme}`, () => {
    test.use({ viewport, hasTouch: viewport.touch, colorScheme: theme });
    for (const entry of cases) test(`${entry.name} appears with the conversation, never before it`, async ({ page }, testInfo) => {
      const gate = deferred();
      await mock(page, [{ ...summary, ...entry.extra }], async () => {
        await gate.promise;
        return { json: { ...detail, ...entry.extra } };
      });
      await page.goto(url());
      await expect(page.locator(".agent-console-messages .spin")).toBeVisible();
      await expect(page.locator(contentCards)).toHaveCount(0);
      await expect(page.locator(".agent-console-message")).toHaveCount(0);
      await expect(page.locator(".agent-console-messages")).toHaveAttribute("aria-busy", "true");
      if (entry.name === "dismissed") {
        const path = testInfo.outputPath(`${viewport.name}-${theme}-loading.png`);
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach("loading", { path, contentType: "image/png" });
      }
      gate.release();
      await expect(page.locator(".agent-console-message")).toContainText(message.text);
      await expect(page.locator(entry.selector)).toBeVisible();
      await expect(page.locator(".agent-console-messages")).toHaveAttribute("aria-busy", "false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (entry.name === "dismissed") {
        const path = testInfo.outputPath(`${viewport.name}-${theme}-loaded.png`);
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach("loaded", { path, contentType: "image/png" });
      }
    });
  });
}

test("a late response cannot reveal the previous session's cards; cached reopening is immediate", async ({ page }) => {
  const a = deferred();
  const b = deferred();
  const secondId = "and-375-second";
  let aReturned = false;
  await mock(page, [{ ...summary, approval: permission }, { ...summary, id: secondId, agentSessionId: secondId,
    items: [{ key: "EX-376", title: "Second loading fixture", productId: fixture.productId }] }], async sessionId => {
    await (sessionId === id ? a.promise : b.promise);
    if (sessionId === id) aReturned = true;
    return { json: { ...detail, id: sessionId, approval: sessionId === id ? permission : undefined,
      messages: [{ ...message, text: sessionId === id ? "First conversation" : "Second conversation" }] } };
  });
  await page.goto(url());
  await expect(page.locator(".agent-console-messages .spin")).toBeVisible();
  await page.locator(".agent-console-session").filter({ hasText: "Second loading fixture" }).click();
  await expect(page.locator(".agent-console-heading")).toContainText("Second loading fixture");
  a.release();
  await expect.poll(() => aReturned).toBe(true);
  await expect(page.locator(".agent-console-messages .spin")).toBeVisible();
  await expect(page.locator(contentCards)).toHaveCount(0);
  await expect(page.locator(".agent-console-message")).toHaveCount(0);
  b.release();
  await expect(page.locator(".agent-console-message")).toContainText("Second conversation");
  await expect(page.locator(".agent-console-approval")).toHaveCount(0);
  await page.locator(".agent-console-session").filter({ hasText: "EX-375" }).click();
  await expect(page.locator(".agent-console-message")).toContainText("First conversation");
  await expect(page.locator(".agent-console-approval")).toBeVisible();
  await expect(page.locator(".agent-console-messages .spin")).toHaveCount(0);
});

test("an empty loaded conversation still shows its permission request", async ({ page }) => {
  await mock(page, [{ ...summary, approval: permission }], async () => ({ json: { ...detail, messages: [], approval: permission } }));
  await page.goto(url());
  await expect(page.locator(".agent-console-approval")).toBeVisible();
  await expect(page.locator(".agent-console-messages")).toContainText("暂时还没有可显示的消息");
});

test("first-load failure hides summary cards and offers retry", async ({ page }) => {
  let fail = true;
  await mock(page, [{ ...summary, approval: permission }], async () => fail
    ? { status: 503, json: { error: "Service unavailable" } } : { json: { ...detail, approval: permission } });
  await page.goto(url());
  const error = page.locator(".agent-console-messages .inline-error");
  await expect(error).toBeVisible();
  await expect(page.locator(contentCards)).toHaveCount(0);
  fail = false;
  await error.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".agent-console-message")).toContainText(message.text);
  await expect(page.locator(".agent-console-approval")).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("background refresh and its failure preserve loaded content and permission", async ({ page }) => {
  const refresh = deferred();
  let requests = 0;
  await mock(page, [{ ...summary, approval: permission }], async () => {
    if (++requests === 1) return { json: { ...detail, approval: permission } };
    await refresh.promise;
    return { status: 503, json: { error: "Service unavailable" } };
  });
  await page.goto(url());
  const messages = page.locator(".agent-console-message");
  const approval = page.locator(".agent-console-approval");
  await expect(approval).toBeVisible();
  await expect.poll(() => requests).toBeGreaterThan(1);
  await expect(messages).toContainText(message.text);
  await expect(approval).toBeVisible();
  await expect(page.locator(".agent-run-status")).toBeVisible();
  await expect(page.locator(".agent-console-messages .spin")).toHaveCount(0);
  refresh.release();
  await expect(page.locator(".agent-console-messages .inline-error")).toBeVisible();
  await expect(messages).toContainText(message.text);
  await expect(approval).toBeVisible();
  await expect(page.locator(".agent-run-status")).toBeVisible();
});

test("dispatches without a native session keep their progress and recovery", async ({ page }) => {
  let detailReads = 0;
  await mock(page, [{ ...summary, agentSessionId: undefined, status: "failed", dispatchStatus: "failed", canReply: false, canRetry: true }], async () => {
    detailReads++;
    return { json: detail };
  });
  await page.goto(url());
  await expect(page.locator(".agent-console-dispatch-state")).toBeVisible();
  await expect(page.locator(".agent-console-recovery")).toBeVisible();
  expect(detailReads).toBe(0);
});
