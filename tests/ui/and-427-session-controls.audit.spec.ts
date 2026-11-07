import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const id = "and427-controls";
const stamp = new Date().toISOString();
type Phase = "running" | "waiting" | "readonly" | "archived" | "failed" | "starting";

async function mockSession(page: Page) {
  const state = { phase: "running" as Phase };
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const summary = {
      id, agentSessionId: state.phase === "starting" ? undefined : id, dispatchId: "and427-dispatch", agentKind: "codex",
      status: state.phase === "failed" ? "failed" : "active", dispatchStatus: state.phase === "starting" ? "queued" : "launched",
      nodeName: "Fixture", nodeId: "fixture-node", nodeConnectionState: "online", nodeRevoked: false,
      sessionUrl: "codex://threads/and427-controls", mode: "auto", createdAt: stamp, updatedAt: stamp, activityAt: stamp,
      items: [{ key: fixture.detailKey, title: "底部会话控制", productId: fixture.productId }],
      canReply: !["readonly", "archived", "starting"].includes(state.phase), canRetry: false,
      canStop: !["readonly", "archived"].includes(state.phase), canArchive: true, unread: false, settings: {},
      ...(state.phase === "archived" ? { archivedAt: stamp, archivedSource: "missiongo" } : {}),
      attention: { state: "not_needed" }, needsAttention: false, waitingForReply: state.phase === "waiting", activities: [],
      turnState: { turnActive: state.phase === "running", waitingForInput: state.phase === "waiting" },
    };
    const detail = { ...summary, messages: [{ id: "answer", role: "agent", text: "保留原会话内容。", occurredAt: stamp }] };
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail });
  });
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "and427-dispatch", agentSessionId: id, nodeName: "Fixture", agentKind: "codex", mode: "auto",
    sessionUrl: "https://claude.ai/code/and427-controls", status: "launched", itemKeys: [fixture.detailKey], createdAt: stamp,
  }] } }));
  return state;
}

for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) test.describe(`${theme} ${touch ? "touch" : "mouse"}`, () => {
  test.use({ hasTouch: touch, isMobile: touch, colorScheme: theme });
  test("one bottom state, independent stop action, and no client jumps", async ({ page }, testInfo) => {
    await mockSession(page);
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    await expect(page.locator(".agent-console-heading")).toContainText("底部会话控制");
    const row = page.locator(".agent-run-controls");
    const details = row.locator("details");
    const stop = row.getByRole("button", { name: "停止当前回合", exact: true });
    await expect(stop).toBeVisible();
    await expect(page.locator(".agent-console-conversation-head .status-pill")).toHaveCount(0);
    await expect(page.locator(".agent-console-conversation-head button", { hasText: "停止当前回合" })).toHaveCount(0);
    await expect(page.locator(".dispatch-session-link, a[href^='codex:'], a[href^='claude:'], a[href^='https://claude.ai/code/']")).toHaveCount(0);
    await expect(details.locator("summary")).toContainText("Codex 运行中");
    // Stop is a sibling of the disclosure, so activation cannot toggle diagnostics.
    await expect(details.getByRole("button", { name: "停止当前回合", exact: true })).toHaveCount(0);
    for (const width of [320, 520, 521, 812, 1023, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 812 ? 375 : 900 });
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        // In a short landscape viewport the message pane scrolls independently.
        await stop.scrollIntoViewIfNeeded();
        await expect(stop).toBeInViewport();
        await stop.click({ trial: true });
        const bounds = await stop.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        expect(await row.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        if (width >= 1024) {
          const stateBounds = await details.locator("summary").boundingBox();
          expect(Math.abs(stateBounds!.y - bounds!.y)).toBeLessThanOrEqual(1);
        }
        if (width === 320 && scale === "large") await page.screenshot({ path: testInfo.outputPath("phone-large-controls.png") });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
    await stop.scrollIntoViewIfNeeded();
    await expect(stop).toBeInViewport();
    await stop.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("会话保留");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(stop).toBeFocused();
    await expect(details).toHaveAttribute("open", "");
    await details.locator("summary").click();
    await page.screenshot({ path: testInfo.outputPath("bottom-controls.png") });

    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
    await expect(page.locator(".dispatch-session-link")).toHaveCount(0);
    await page.locator(".agent-session-toggle").click();
    const panel = page.locator(".agent-session-panel");
    await expect(panel.locator(".agent-run-details")).toContainText("Codex 运行中");
    await expect(panel.locator(".agent-session-head .status-pill")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "停止当前回合", exact: true })).toHaveCount(0);
  });
});

test("stop stays reachable for live waits and startup, and hides for ended failures", async ({ page }) => {
  const state = await mockSession(page);
  for (const phase of ["waiting", "failed", "starting", "readonly", "archived"] as const) {
    state.phase = phase;
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}${phase === "archived" ? "&consoleFilter=archived" : ""}`);
    await expect(page.locator(".agent-console-heading")).toContainText("底部会话控制");
    const stop = page.getByRole("button", { name: "停止当前回合", exact: true });
    if (phase === "readonly" || phase === "archived" || phase === "failed") await expect(stop).toHaveCount(0);
    else await expect(stop).toBeVisible();
    if (phase === "waiting") await expect(page.locator(".agent-run-details")).toContainText("等待");
    if (phase === "starting") await expect(page.locator(".agent-run-fallback")).toBeVisible();
    if (phase === "failed") await expect(page.locator(".agent-run-fallback")).toHaveCount(0);
    if (phase === "failed") await expect(page.locator(".agent-console-activity-failed")).toHaveCount(0);
    await expect(page.locator(".dispatch-session-link")).toHaveCount(0);
    await expect(page.locator(".agent-console-conversation-head .status-pill")).toHaveCount(0);
  }
});

test("first detail load and failure do not expose stop from a stale summary", async ({ page }) => {
  await mockSession(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(new RegExp(`/api/v1/agent-sessions/${id}(?:\\?.*)?$`), async route => {
    await gate;
    await route.fulfill({ status: 503, json: { title: "Fixture unavailable" } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const row = page.locator(".agent-run-fallback");
  await expect(page.locator(".agent-console-messages .agent-console-empty .spin")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止当前回合", exact: true })).toHaveCount(0);
  release();
  await expect(page.locator(".agent-console-messages .inline-error")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止当前回合", exact: true })).toHaveCount(0);
  await expect(page.locator(".agent-console-conversation-head .status-pill")).toHaveCount(0);
});
