import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-05T00:00:00.000Z";
const execution = { id: "legacy-tool", sourceId: "legacy-tool", role: "agent", phase: "execution", occurredAt: stamp, text: '{"aggregatedOutput":"INTERNAL_TOOL_PAYLOAD"}' };
function message(n: number) {
  return { id: `message-${n}`, sourceId: `source-${n}`, role: "agent", occurredAt: stamp,
    text: `Conversation message ${n}\n\n${"Historical conversation context. ".repeat(8)}` };
}

test("a late history page cannot cross conversations and drafts remain scoped", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const summaries = ["first", "second"].map(name => ({ id: name, agentSessionId: name, productId: fixture.productId,
    sessionName: `${name} conversation`, agentKind: "codex", status: "idle", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched",
    activities: [], settings: {}, unread: false, canReply: true, canStop: true, canArchive: true, items: [],
    attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false }));
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/history")) {
      await gate; completed = true;
      return route.fulfill({ json: { status: "ready", messages: [{ ...message(-1), text: "Late first history" }] } });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: summaries } });
    const summary = summaries.find(entry => path.endsWith(`/${entry.id}`))!;
    return route.fulfill({ json: { ...summary, messages: [{ ...message(0), text: `${summary.id} recent` }],
      ...(summary.id === "first" ? { history: { nextCursor: "first-page" } } : {}) } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=first`);
  const reply = page.locator(".agent-console-reply textarea");
  await reply.fill("First draft");
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(page.locator(".agent-console-messages").getByRole("status").filter({ hasText: "正在加载更早消息" })).toBeVisible();
  await page.locator(".agent-console-session").filter({ hasText: "second conversation" }).click();
  await expect(page.locator(".agent-console-message")).toContainText("second recent");
  await expect(reply).toHaveValue("");
  release(); await expect.poll(() => completed).toBe(true);
  await page.waitForTimeout(100);
  await expect(page.getByText("Late first history")).toHaveCount(0);
  await page.locator(".agent-console-session").filter({ hasText: "first conversation" }).click();
  await expect(reply).toHaveValue("First draft");
});

test("polling a newer recent window preserves the messages already on screen", async ({ page }) => {
  await page.clock.install();
  let shifted = false;
  const summary = { id: "window", agentSessionId: "window", productId: fixture.productId, sessionName: "Window fixture",
    agentKind: "codex", status: "idle", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, dispatchStatus: "launched",
    activities: [], settings: {}, unread: false, canReply: true, canStop: true, canArchive: true, items: [],
    attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
  await page.route("**/api/v1/agent-sessions**", route => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] }
      : { ...summary, messages: Array.from({ length: 50 }, (_, n) => message(n + (shifted ? 51 : 50))) } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=window`);
  await expect(page.locator("[data-agent-message-id]")).toHaveCount(50);
  shifted = true;
  await advanceSessionDetailPoll(page);
  await expect(page.locator("[data-agent-message-id]")).toHaveCount(51);
  await expect(page.locator('[data-agent-message-id="agent:source-50"]')).toHaveCount(1);
  await expect(page.locator('[data-agent-message-id="agent:source-100"]')).toHaveCount(1);
});

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, colorScheme: theme });
    for (const surface of ["console", "panel"] as const) test(`${surface} prepends cached and source history without moving the reader or losing a draft`, async ({ page }, testInfo) => {
      const id = "history-pagination";
      const summary = { id, agentSessionId: id, dispatchId: "history-dispatch", agentKind: "codex", status: "idle",
        updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
        nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched",
        activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: true, canArchive: true,
        items: [{ key: fixture.detailKey, title: "History fixture", productId: fixture.productId }],
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let sourceFailed = true; let sends = 0; const pages: string[] = []; let recentReads = 0;
      await page.route("**/api/v1/agent-sessions**", async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.pathname.endsWith("/history")) {
          const cursor = request.method() === "POST" ? request.postDataJSON().cursor : url.searchParams.get("cursor");
          if (request.method() === "POST") pages.push(cursor);
          if (cursor === "stored:message-50") {
            await gate;
            return route.fulfill({ json: { status: "ready", messages: [execution, ...Array.from({ length: 50 }, (_, n) => message(n))], nextCursor: "source-page" } });
          }
          if (request.method() === "POST") return route.fulfill({ json: { status: "pending", messages: [] } });
          if (sourceFailed) return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Fixture unavailable" } } });
          return route.fulfill({ json: { status: "ready", messages: [...Array.from({ length: 10 }, (_, n) => ({ ...message(n - 10), id: `history:source-${n - 10}`,
            ...(n === 9 ? { questions: [{ title: "Historical question", options: ["Historical option"] }] } : {}) })), message(0)] } });
        }
        if (request.method() !== "GET") {
          if (url.pathname.endsWith("/commands")) sends++;
          return route.fulfill({ status: 204 });
        }
        if (url.searchParams.get("history") === "recent") recentReads++;
        return route.fulfill({ json: url.pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : {
          ...summary, messages: [execution, ...Array.from({ length: 50 }, (_, n) => message(n + 50))], history: { nextCursor: "stored:message-50" },
        } });
      });
      await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{
        id: summary.dispatchId, agentSessionId: id, agentKind: "codex", mode: "plan", nodeName: "Fixture",
        status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
      }] } }));
      if (surface === "console") await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      else {
        await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
        await page.locator(".execution-history > summary").click();
        await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
        await page.locator(".agent-session-toggle").click();
      }
      const area = page.locator(surface === "console" ? ".agent-console-messages" : ".agent-session-messages");
      const reply = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
      await expect(area.locator("[data-agent-message-id]")).toHaveCount(50);
      expect(recentReads).toBeGreaterThan(0);
      await reply.fill("Keep this draft");
      await area.scrollIntoViewIfNeeded();
      // A real upward scroll triggers pagination; measure relative to the chat
      // container so the panel's outer page position does not affect the result.
      await area.evaluate(element => { element.scrollTop = 200; });
      await page.waitForTimeout(50);
      const before = await area.evaluate(element => {
        element.scrollTop = 0;
        return element.querySelector('[data-agent-message-id="agent:source-50"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top;
      });
      await expect.poll(() => pages.filter(cursor => cursor === "stored:message-50").length).toBe(1);
      await expect(reply).toBeEnabled();
      release();
      await expect(area.locator("[data-agent-message-id]")).toHaveCount(100);
      const after = await area.evaluate(element => element.querySelector('[data-agent-message-id="agent:source-50"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
      await expect(reply).toHaveValue("Keep this draft");
      await area.evaluate(element => { element.scrollTop = 0; });
      await expect(area.getByRole("alert")).toContainText("当前消息和草稿已保留");
      await expect(area.locator("[data-agent-message-id]")).toHaveCount(100);
      await expect(reply).toHaveValue("Keep this draft");
      sourceFailed = false;
      const retry = area.getByRole("button", { name: "重试加载更早消息" });
      await retry.click();
      await expect(area.locator("[data-agent-message-id]")).toHaveCount(110);
      await expect(area.locator('[data-agent-message-id="agent:source-0"]')).toHaveCount(1);
      await expect(area.getByRole("button", { name: "加载更早消息" })).toHaveCount(0);
      await expect(reply).toHaveValue("Keep this draft");
      await expect(area.getByRole("button", { name: "Historical option", exact: true })).toBeDisabled();
      await expect(area).not.toContainText("INTERNAL_TOOL_PAYLOAD");
      expect(sends).toBe(0);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; }, scale);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
      await area.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`history-${surface}-${width}-${theme}.png`) });
    });
  });
}
