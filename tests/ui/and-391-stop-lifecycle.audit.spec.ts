import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
for (const agent of ["codex", "claude_code", "opencode"]) for (const phone of [false, true]) for (const dark of [false, true]) {
  test(`stop and continue ${agent} ${phone ? "phone" : "desktop"} ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
    await page.setViewportSize(phone ? { width: 320, height: 740 } : { width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    const id = "stop-lifecycle";
    const stamp = new Date().toISOString();
    let phase: "running" | "queued" | "failed" | "background" | "continued" = "running";
    const sent: string[] = [];
    await page.route("**/api/v1/dispatches/stop-dispatch/stop", async route => {
      phase = "queued";
      await route.fulfill({ status: 202, json: { command: { id: "stop", kind: "interrupt", status: "queued", createdAt: stamp, text: "stop" } } });
    });
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") {
        if (path.endsWith("/commands")) {
          sent.push(route.request().postData() ?? ""); phase = "continued";
          await route.fulfill({ status: 201, json: { id: "next", kind: "message", text: "继续处理", status: "delivered", createdAt: new Date(Date.now()+1000).toISOString() } });
        } else await route.fulfill({ status: 204 });
        return;
      }
      const stopCommand = phase === "running" ? undefined : { id: "stop", kind: "interrupt", text: "stop", createdAt: stamp,
        stopConfirmed: phase === "background" || phase === "continued", status: phase === "queued" ? "queued" : phase === "failed" ? "failed" : "delivered", ...(phase === "failed" ? { error: "停止尚未确认" } : {}) };
      const command = phase === "continued" ? { id: "next", kind: "message", text: "继续处理", status: "delivered", createdAt: new Date(Date.now()+1000).toISOString() } : stopCommand;
      const common = { id, agentSessionId: id, dispatchId: "stop-dispatch", agentKind: agent, status: phase === "failed" ? "unavailable" : "active",
        createdAt: stamp, updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
        dispatchStatus: "launched", mode: "default", items: [{ key: "AND-391", title: "停止可靠性", productId: fixture.productId }],
        canReply: true, canStop: true, canRetry: false, canArchive: true, settings: {}, unread: false,
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, command, stopCommand,
        activities: phase === "background" ? [{ id: "bg", title: "后台任务", detail: "运行中" }] : [],
        turnState: { turnActive: phase === "running" || phase === "continued", waitingForInput: false } };
      const detail = { ...common, messages: [{ id: "history", sourceId: "history", role: "agent", text: "会话上下文保留。", occurredAt: stamp }] };
      await route.fulfill({ status: 200, json: path === "/api/v1/agent-sessions" ? { sessions: [common] } : detail });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const stop = page.getByRole("button", { name: "停止当前回合", exact: true });
    await expect(stop).toBeVisible();
    const box = await stop.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    await stop.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("会话保留");
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    const composer = page.locator(".agent-console-reply textarea");
    await expect(composer).toBeDisabled();
    await expect(page.locator(".agent-session-command")).toContainText("尚未确认原回合停止");
    expect(sent).toEqual([]);
    phase = "failed"; await page.reload();
    await expect(page.locator(".agent-session-command")).toContainText("停止尚未确认");
    await expect(composer).toBeEnabled();
    phase = "background"; await page.reload();
    await expect(page.locator(".agent-session-command")).toContainText("仍有后台任务运行");
    await expect(composer).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("background-after-stop.png") });
    await composer.fill("继续处理");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(page.locator(".agent-session-command")).toHaveCount(0);
    await expect(page.getByText("会话上下文保留。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
