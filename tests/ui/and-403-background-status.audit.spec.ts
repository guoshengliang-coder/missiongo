import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const id = "and403-background";
type Phase = "background" | "foreground" | "waiting" | "idle" | "failed";
async function mockSession(page: Page) {
  const state = { phase: "background" as Phase };
  const stamp = new Date().toISOString();
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const status = state.phase === "failed" ? "failed" : state.phase === "idle" ? "idle" : "active";
    const common = { id, agentSessionId: id, dispatchId: "and403-dispatch", agentKind: "claude_code", status,
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, mode: "default", dispatchStatus: "launched",
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, settings: {},
      items: [{ key: fixture.detailKey, title: "后台状态", productId: fixture.productId }],
      canReply: true, canStop: false, canArchive: true, canRetry: false, unread: false,
      attention: { state: "not_needed" }, needsAttention: false, waitingForReply: state.phase === "waiting",
      activities: state.phase === "idle" || state.phase === "failed" ? [] : [{ id: "bg", title: "等待 CI", detail: "运行中" }],
      turnState: { turnActive: state.phase === "foreground", waitingForInput: state.phase === "waiting" } };
    const detail = { ...common, messages: [{ id: "answer", sourceId: "answer", role: "agent", text: "前台已返回，后台任务仍在运行。", occurredAt: stamp }] };
    await route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [common] } : detail });
  });
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "and403-dispatch", agentSessionId: id, nodeName: "Fixture", agentKind: "claude_code", mode: "default",
    status: "launched", itemKeys: [fixture.detailKey], createdAt: stamp,
  }] } }));
  return state;
}

for (const width of [320, 375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ hasTouch: width < 1024, isMobile: width < 1024 });
    test(`background spinner and terminal transitions ${width}px ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      const state = await mockSession(page);
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const run = page.locator(".agent-run-details > summary");
      await expect(run).toContainText("后台任务运行中");
      await expect(run.locator(".agent-session-running")).toHaveCSS("animation-name", "spin");
      await expect(page.locator(".agent-console-session .agent-session-running")).toHaveCount(1);
      await expect(run.locator(".lucide-circle-check")).toHaveCount(0);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        await expect(run).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        expect(await run.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: testInfo.outputPath("background.png") });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(run.locator(".agent-session-running")).toHaveCSS("animation-name", "none");
      await expect(run).toContainText("后台任务运行中");
      await run.click();
      await expect(page.locator(".agent-console-background .agent-session-running")).toHaveCSS("animation-name", "none");
      await run.click();
      for (const phase of ["foreground", "waiting", "idle", "failed"] as const) {
        state.phase = phase; await page.reload();
        const spinning = phase === "foreground";
        await expect(run.locator(".agent-session-running")).toHaveCount(spinning ? 1 : 0);
        await expect(page.locator(".agent-console-session .agent-session-running")).toHaveCount(spinning ? 1 : 0);
        if (phase === "waiting") await expect(run).toContainText("等待");
        if (phase === "failed") await expect(run.locator(".lucide-circle-alert")).toHaveCount(1);
      }
    });
  });
}

test("item session uses the same background spinner and label", async ({ page }) => {
  const state = await mockSession(page);
  const open = async () => {
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
    await page.locator(".agent-session-toggle").click();
  };
  await open();
  const run = page.locator(".agent-session-panel .agent-run-details > summary");
  await expect(run).toContainText("后台任务运行中");
  await expect(run.locator(".agent-session-running")).toHaveCount(1);
  state.phase = "waiting";
  await open();
  await expect(run).toContainText("等待");
  await expect(run.locator(".agent-session-running")).toHaveCount(0);
});
