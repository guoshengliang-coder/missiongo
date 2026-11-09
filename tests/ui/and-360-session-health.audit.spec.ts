import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import { advanceSessionDetailPoll, advanceSessionListPoll } from "./polling";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };

for (const kind of ["opencode", "codex", "claude_code"]) for (const phone of [true, false]) {
  test(`${kind} explains tool waits, queueing and recovery on ${phone ? "phone" : "desktop"}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 },
      isMobile: phone, hasTouch: phone, colorScheme: phone ? "dark" : "light", storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.clock.install();
    const stamp = new Date().toISOString();
    const old = new Date(Date.now() - 12 * 60_000).toISOString();
    const id = `health-${kind}`;
    let status = "active";
    let progressed = false;
    let accepted = false;
    const inputs: string[] = [];
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") {
        if (path.endsWith("/commands")) inputs.push(request.postData() ?? "");
        await route.fulfill({ status: 204 }); return;
      }
      const turnState = { turnActive: status !== "idle", waitingForInput: false, turnStartedAt: old,
        lastProgressAt: progressed ? stamp : old, observedAt: stamp };
      const command = { id: "queued-reply", kind: "message", text: "进度如何？", status: accepted ? "delivered" : "queued", createdAt: old };
      const activities = status === "idle" ? [] : [{ id: "ci", title: "等待 CI", startedAt: old }];
      const summary = { id, agentSessionId: id, dispatchId: "health-dispatch", agentKind: kind, status,
        updatedAt: stamp, activityAt: old, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
        mode: "default", dispatchStatus: "launched", createdAt: old, nodeId: "fixture-node", settings: {}, unread: false,
        items: [{ key: "AND-360", title: "Runtime health", productId: fixture.productId }], activities, turnState,
        command, canReply: true, canRetry: false, canStop: true, canArchive: true,
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
      const detail = { id, agentKind: kind, status, updatedAt: stamp, activities, turnState, command,
        messages: [{ id: "message", sourceId: "message", role: "agent", text: "正在核对检查结果。", occurredAt: old }], canReply: true };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    await page.locator(".agent-run-details > summary").click();
    await expect(page.locator(".agent-console-background")).toContainText("等待 CI");
    await expect(page.locator(".agent-run-diagnostics")).toContainText("正在等待当前工具结束");
    await expect(page.locator(".agent-console-outgoing")).toContainText("排队中");
    await expect(page.locator(".agent-run-diagnostics")).toContainText("当前工具结束");
    accepted = true;
    await advanceSessionDetailPoll(page);
    await expect(page.locator(".agent-run-diagnostics")).toContainText("尚未确认开始处理", { timeout: 10_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`tool-wait-${kind}.png`) });
    status = "stalled";
    await advanceSessionListPoll(page);
    await expect(page.locator(".agent-console-activity-stalled")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".agent-run-warning")).toContainText("没有自动终止");
    status = "unavailable";
    await advanceSessionListPoll(page);
    await expect(page.locator(".agent-console-activity-unavailable")).toBeVisible({ timeout: 10_000 });
    // AND-487: a reply still on its way reads as queued work, not native idle.
    progressed = true; accepted = false; status = "idle";
    await advanceSessionListPoll(page);
    await expect(page.locator(".agent-console-activity-active")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".agent-console-activity-active")).toContainText("排队中");
    await expect(page.locator(".agent-console-background")).toHaveCount(0);
    expect(inputs).toEqual([]);
    await context.close();
  });
}
