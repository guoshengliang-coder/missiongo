import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import type { AgentSession, AgentSessionCommand, AgentSessionSummary, ExternalNativeConnection } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
for (const width of [375, 768, 1440]) {
  for (const kind of ["codex", "opencode", "claude_code"] as const) {
    test(`external native ${kind} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: width === 1440 ? "dark" : "light" });
      const stamp = new Date().toISOString();
      let connection: ExternalNativeConnection | undefined;
      let command: AgentSessionCommand | undefined;
      let replyText = "";
      const summary = (): AgentSessionSummary => ({
        id: "external-native", agentSessionId: "external-native", source: "external", agentKind: kind,
        status: "idle", progressStatus: "working", refKind: "native", lastReportedAt: stamp,
        ...(connection ? { nativeConnection: connection } : {}), ...(command ? { command } : {}),
        nodeName: kind, nodeRevoked: false, mode: "external", dispatchStatus: "external",
        updatedAt: stamp, activityAt: stamp, createdAt: stamp, sessionName: "处理外部会话",
        items: [{ key: fixture.detailKey, title: "处理条目", productId: fixture.productId }],
        activities: [], canReply: connection?.state === "connected", canRetry: false, canStop: false, canArchive: true,
        canConnectNative: true, canDisconnectNative: Boolean(connection?.nodeId),
        ...(connection?.state !== "connected" ? { replyBlockedReason: connection ? "external_native_unavailable" : "external_progress_only" } : {}),
        settings: { mode: "external", adjustable: false }, attention: { state: "not_needed" },
        needsAttention: false, waitingForReply: false, unread: false,
      });
      const detail = (): AgentSession => ({ ...summary(),
        messages: [{ id: "user", sourceId: "user", role: "user", text: "处理这个条目", occurredAt: stamp },
          { id: "agent", sourceId: "agent", role: "agent", text: "原生会话中的处理结果", occurredAt: stamp }],
        activities: [], canResolveDelivery: true, canAttach: false });
      await page.route("**/api/v1/nodes", (route) => route.fulfill({ json: { nodes: [{ id: "fixture-node", name: "Fixture node", agents: [{ kind }], online: true }] } }));
      await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/native-connection")) {
          if (route.request().method() === "DELETE") connection = { state: "disconnected", lastSyncedAt: stamp };
          else {
            expect(route.request().postDataJSON()).toEqual({ nodeId: "fixture-node" });
            connection = { state: "pending", nodeId: "fixture-node", nodeName: "Fixture node" };
          }
          await route.fulfill({ json: detail() });
        } else if (path.endsWith("/commands")) {
          replyText = route.request().postDataJSON().text;
          expect(route.request().postDataJSON()).not.toHaveProperty("attachmentIds");
          command = { id: "reply", kind: "message", text: replyText, status: "queued", createdAt: stamp };
          await route.fulfill({ status: 201, json: command });
        } else if (path.endsWith("/external-native")) await route.fulfill({ json: detail() });
        else if (path.endsWith("/agent-sessions")) await route.fulfill({ json: { sessions: [summary()] } });
        else throw new Error(`Unexpected native request: ${path}`);
      });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/?product=${fixture.productId}&console=agent&session=external-native`);
      await page.getByRole("button", { name: "同步原生会话" }).click();
      await page.getByRole("combobox", { name: "会话所在节点" }).selectOption("fixture-node");
      await page.getByRole("button", { name: "同步原生会话" }).click();
      await expect(page.getByText("等待 Fixture node 确认这条原生会话。同步成功前暂不开放回复。")).toBeVisible();
      await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
      connection = { state: "connected", nodeId: "fixture-node", nodeName: "Fixture node", lastSyncedAt: stamp };
      await page.reload();
      await expect(page.getByText("正在从 Fixture node 同步原生消息。Web 回复会发到同一条会话。")).toBeVisible();
      await expect(page.getByText("原生会话中的处理结果")).toBeVisible();
      await page.locator(".agent-console-reply textarea").fill("继续核对结果");
      await page.getByRole("button", { name: "发送回复", exact: true }).click();
      await expect.poll(() => replyText).toBe("继续核对结果");
      await expect(page.getByText("此连接目前支持文字回复。")).toBeVisible();
      await expect(page.getByRole("button", { name: "添加文件" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`external-native-${kind}-${width}.png`) });
      command = { ...command!, status: "delivered" }; await page.reload();
      await page.getByRole("button", { name: "断开同步" }).click();
      await expect(page.getByText("原生同步已断开。已同步的消息仍保留，请在原客户端回复。")).toBeVisible();
      await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
      await expect(page.getByText("原生会话中的处理结果")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}
