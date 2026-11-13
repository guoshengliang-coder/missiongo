import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const stamp = "2026-11-06T00:00:00Z";
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`old delivered receipt respects the loaded window ${width}px ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width, height: 900 }, hasTouch: width === 320,
      colorScheme: theme, storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.clock.install();
    await page.clock.setFixedTime(new Date("2026-11-13T03:19:00Z"));
    const id = `and428-${width}-${theme}`;
    let count = 50;
    let withinWindow = false;
    let mirror = false;
    let historyReads = 0;
    const summary = { id, agentSessionId: id, productId: fixture.productId, sessionName: "Receipt window fixture",
      agentKind: "codex", status: "idle", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, dispatchStatus: "launched",
      activities: [], settings: {}, unread: false, canReply: true, canStop: true, canArchive: true, items: [],
      attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
    const command = () => ({ id: "old-command", kind: "message", text: "Old reply", status: "delivered",
      createdAt: withinWindow ? "2026-11-06T00:02:00Z" : stamp });
    const message = (n: number) => ({ id: `m${n}`, sourceId: `m${n}`, role: "agent", text: `Later message ${n}`,
      occurredAt: new Date(Date.parse(stamp) + (n + 1) * 60_000).toISOString() });
    await page.route("**/api/v1/agent-sessions**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/history")) {
        historyReads++;
        return route.fulfill({ json: { status: "ready", messages: [
          { id: "original", sourceId: "old-command", role: "user", text: "Old reply", occurredAt: stamp },
        ] } });
      }
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: [summary] } });
      return route.fulfill({ json: { ...summary, command: command(), history: { nextCursor: "older-page" },
        messages: [...Array.from({ length: count }, (_, n) => message(n)), ...(mirror ? [
          { id: "mirror", sourceId: "old-command", role: "user", text: "Old reply", occurredAt: command().createdAt },
        ] : [])] } });
    });
    const url = `/?product=${fixture.productId}&console=agent&session=${id}`;
    await page.goto(url);
    const outgoing = page.locator(".agent-console-message-outgoing");
    await expect(page.locator("[data-agent-message-id]")).toHaveCount(50);
    await expect(outgoing).toHaveCount(0);
    // Byte-limited recent windows can contain fewer than 50 messages.
    count = 2;
    await page.reload();
    await expect(page.locator("[data-agent-message-id]")).toHaveCount(2);
    await expect(outgoing).toHaveCount(0);
    const reply = page.locator(".agent-console-reply textarea");
    await reply.fill("Keep this draft");
    await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
    await expect.poll(() => historyReads).toBe(1);
    await expect(page.getByText("Old reply", { exact: true })).toBeVisible();
    await expect(outgoing).toHaveCount(0);
    await expect(reply).toHaveValue("Keep this draft");
    // Start with a fresh loaded window, then check receipt → actual mirror.
    withinWindow = true;
    await page.reload();
    await expect(page.locator(".agent-console-outgoing")).toContainText("已送达");
    await reply.fill("Preserve while polling");
    mirror = true;
    await advanceSessionDetailPoll(page);
    await expect(outgoing).toHaveCount(0);
    await expect(reply).toHaveValue("Preserve while polling");
    await context.close();
  });
}
