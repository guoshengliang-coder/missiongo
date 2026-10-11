import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentSession, AgentSessionSummary, ExternalNativeConnection } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
for (const width of [375, 1440]) {
  for (const kind of ["codex", "opencode", "claude_code"] as const) {
    test(`automatic external reply ${kind} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      let copied = "", sent = "";
      await page.exposeFunction("captureRegistration", (text: string) => { copied = text; });
      await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => (window as unknown as { captureRegistration(text: string): Promise<void> }).captureRegistration(text) } }));
      let refKind: "tracking" | "native" = "tracking";
      let connection: ExternalNativeConnection | undefined;
      const stamp = new Date().toISOString();
      const summary = (): AgentSessionSummary => ({
        id: "12345678-1234-1234-1234-123456789abc", agentSessionId: "12345678-1234-1234-1234-123456789abc", source: "external", agentKind: kind,
        status: "idle", progressStatus: "working", refKind, lastReportedAt: stamp, ...(connection ? { nativeConnection: connection } : {}),
        nodeName: kind, nodeRevoked: false, mode: "external", dispatchStatus: "external", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
        items: [{ key: fixture.detailKey, title: "处理条目", productId: fixture.productId }], activities: [], turnState: {},
        canReply: connection?.state === "connected", canArchive: true, canRetry: false, canStop: false, canRegisterNative: true,
        canConnectNative: refKind === "native", canDisconnectNative: Boolean(connection),
        ...(connection?.state !== "connected" ? { replyBlockedReason: connection ? "external_native_unavailable" : "external_progress_only" } : {}),
        settings: { mode: "external", adjustable: false }, attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, unread: false,
      });
      const detail = (): AgentSession => ({ ...summary(), canAttach: false, messages: [{ id: "progress", sourceId: "progress", role: "agent", text: "原有处理进展保留", occurredAt: stamp }] });
      await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/commands")) {
          sent = route.request().postDataJSON().text;
          await route.fulfill({ status: 201, json: { id: "command", kind: "message", text: sent, status: "queued", createdAt: stamp } });
        } else if (path.endsWith(summary().id)) await route.fulfill({ json: detail() });
        else if (path.endsWith("/agent-sessions")) await route.fulfill({ json: { sessions: [summary()] } });
        else throw new Error(`Unexpected automatic connection action: ${path}`);
      });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${summary().id}`);
      await page.getByText("自动接入设置", { exact: true }).click();
      await expect(page.getByRole("link", { name: "下载配置脚本" })).toHaveAttribute("href", "/downloads/missiongo-agent-integration/install.mjs");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByText("自动接入设置", { exact: true }).click();
      await page.getByRole("button", { name: "启用回复" }).click();
      await page.getByRole("button", { name: "复制接入请求" }).click();
      await expect.poll(() => copied).toContain(summary().id);
      await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      refKind = "native"; connection = { state: "pending", automatic: true };
      await page.reload();
      await expect(page.getByText("正在自动等待已启用的本机节点确认这条会话。连接成功后，可在这里回复原 Agent。")).toBeVisible();
      await expect(page.getByText("原有处理进展保留")).toBeVisible();
      await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`auto-pending-${kind}-${width}.png`) });
      connection = { state: "connected", automatic: true, nodeId: "node", nodeName: "本机" };
      await page.reload();
      await page.locator(".agent-console-reply textarea").fill("继续原会话");
      await page.getByRole("button", { name: "发送回复", exact: true }).click();
      await expect.poll(() => sent).toBe("继续原会话");
      expect(errors).toEqual([]);
    });
  }
}
