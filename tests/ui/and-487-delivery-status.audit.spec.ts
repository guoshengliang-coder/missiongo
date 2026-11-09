import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { AgentSessionCommand } from "../../apps/web/src/types";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-09T00:00:00.000Z";
const id = "and487-delivery";

async function mockSession(page: Page) {
  const state = { command: undefined as AgentSessionCommand | undefined, active: false, release: () => {} };
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/commands") && route.request().method() === "POST") {
      await new Promise<void>(resolve => { state.release = resolve; });
      state.command = { id: "new-message", kind: "message", text: "继续处理", status: "queued", createdAt: stamp };
      return route.fulfill({ status: 201, json: state.command });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const common = { id, agentSessionId: id, dispatchId: "and487-dispatch", agentKind: "claude_code",
      status: state.active ? "active" : "idle", createdAt: stamp, updatedAt: stamp, activityAt: stamp,
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "default", dispatchStatus: "launched", settings: {},
      activities: [], turnState: { turnActive: state.active, waitingForInput: false, observedAt: stamp },
      canReply: true, canStop: false, canAttach: true, canArchive: true, canRetry: false, unread: false,
      items: [{ key: fixture.detailKey, title: "投递状态", productId: fixture.productId }],
      attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, command: state.command };
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [common] }
      : { ...common, messages: [{ id: "previous", sourceId: "previous", role: "agent", text: "上轮已结束", occurredAt: stamp }] } });
  });
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "and487-dispatch", agentSessionId: id, nodeName: "Fixture", agentKind: "claude_code", mode: "default",
    status: "launched", itemKeys: [fixture.detailKey], createdAt: stamp,
  }] } }));
  return state;
}

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`delivery phase agrees across the console ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install({ time: new Date(stamp) });
    const state = await mockSession(page);
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const run = page.locator(".agent-run-details > summary");
    await expect(run).toContainText("本轮结束");
    await page.locator(".agent-console-reply textarea").fill("继续处理");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(run).toContainText("发送中");
    await expect(page.locator(".agent-console-session .agent-session-running")).toHaveCount(1);
    state.release();
    await expect(run).toContainText("排队中");
    await expect(page.locator(".agent-console-outgoing")).toContainText("排队中");
    for (const status of ["delivering", "delivery_unknown", "failed", "cancelled", "delivered"] as const) {
      state.command = { ...state.command!, status };
      await advanceSessionDetailPoll(page);
      await expect(run).toContainText(status === "delivering" ? "送达中" : status === "delivery_unknown" ? "送达待核实" : "本轮结束");
      const spinning = status === "delivering" ? 1 : 0;
      await expect(run.locator(".agent-session-running")).toHaveCount(spinning);
      await expect(page.locator(".agent-console-session .agent-session-running")).toHaveCount(spinning);
    }
    state.active = true;
    await advanceSessionDetailPoll(page);
    await expect(run).toContainText("Claude Code 运行中");
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; document.documentElement.dataset.consoleFontScale = value; }, scale);
      await expect(run).toBeVisible();
      expect(await run.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath("delivery-state.png") });
  });
}

test("embedded item conversation uses the same send and delivery phases", async ({ page }) => {
  await page.clock.install({ time: new Date(stamp) });
  const state = await mockSession(page);
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  await page.locator(".execution-history > summary").click();
  await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
  await page.locator(".agent-session-toggle").click();
  const panel = page.locator(".agent-session-panel");
  const run = panel.locator(".agent-run-details > summary");
  await expect(run).toContainText("本轮结束");
  await panel.locator("textarea").fill("继续处理");
  await panel.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect(run).toContainText("发送中");
  state.release();
  await expect(run).toContainText("排队中");
  state.command = { ...state.command!, status: "delivering" };
  await advanceSessionDetailPoll(page);
  await expect(run).toContainText("送达中");
  state.command = { ...state.command!, status: "delivered" };
  await advanceSessionDetailPoll(page);
  await expect(run).toContainText("本轮结束");
});
