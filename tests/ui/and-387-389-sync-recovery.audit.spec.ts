import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };

for (const phone of [false, true]) {
  test(`read timeout and queued stop recover without a duplicate input: ${phone ? "phone" : "desktop"}`, async ({ page }, testInfo) => {
    await page.setViewportSize(phone ? { width: 375, height: 812 } : { width: 1440, height: 900 });
    const id = "sync-recovery";
    const stamp = new Date().toISOString();
    let commandStatus = "queued";
    let recovered = false;
    const sent: string[] = [];
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") {
        if (path.endsWith("/commands")) sent.push(route.request().postData() ?? "");
        await route.fulfill({ status: 204 }); return;
      }
      const command = recovered ? undefined : { id: "stop", kind: "interrupt", text: "停止当前任务",
        status: commandStatus, createdAt: stamp, ...(commandStatus === "failed" ? { error: "终止尚未确认：请在来源客户端核实。" } : {}) };
      const common = { id, agentSessionId: id, dispatchId: "sync-dispatch", agentKind: "codex",
        status: recovered ? "idle" : "unavailable", createdAt: stamp, updatedAt: stamp, activityAt: stamp,
        nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, dispatchStatus: "launched", mode: "default",
        items: [{ key: "AND-389", title: "Sync timeout", productId: fixture.productId }], activities: [],
        canReply: true, canStop: false, canRetry: false, canArchive: true, settings: {}, unread: false,
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, command,
        ...(recovered ? {} : { lastError: "Codex 会话同步失败：读取超时，尚不能确认原任务是否停止。" }) };
      const detail = { ...common, messages: [{ id: "history", sourceId: "history", role: "agent", text: "此前的会话记录仍然保留。", occurredAt: stamp }], turnState: {} };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [common] } : detail) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const composer = page.locator(".agent-console-reply textarea");
    await expect(composer).toBeDisabled();
    await expect(page.locator(".agent-run-warning")).toHaveText("当前会话暂时不可用。");
    await expect(page.locator(".agent-session-command")).toContainText("等待节点接收停止请求；尚未确认原回合停止");
    await expect(page.getByText(/排队回复会在|回复仍在排队/)).toHaveCount(0);
    commandStatus = "failed";
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(page.locator(".agent-session-command")).toContainText("停止未确认");
    await expect(page.getByText("此前的会话记录仍然保留。", { exact: true })).toBeVisible();
    expect(sent).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`stop-unconfirmed-${phone ? "phone" : "desktop"}.png`) });
    recovered = true;
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(page.locator(".agent-console-recovery")).toHaveCount(0);
    await expect(page.locator(".inline-error")).toHaveCount(0);
    expect(sent).toEqual([]);
  });
}
