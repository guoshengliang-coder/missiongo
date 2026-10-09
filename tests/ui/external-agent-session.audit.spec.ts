import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import type { AgentSession, AgentSessionSummary } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };

for (const width of [375, 768, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`external progress ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const stamp = new Date().toISOString();
      let read = false;
      const summary: { -readonly [K in keyof AgentSessionSummary]: AgentSessionSummary[K] } = {
        id: "external-session", agentSessionId: "external-session", source: "external", agentKind: "codex",
        status: "stalled", progressStatus: "waiting_for_input", refKind: "tracking", lastReportedAt: stamp,
        nodeName: "Codex", nodeRevoked: false, mode: "external", dispatchStatus: "external",
        updatedAt: stamp, activityAt: stamp, createdAt: stamp, sessionName: "核对外部会话进展",
        items: [{ key: fixture.detailKey, title: "处理条目", productId: fixture.productId }],
        latestMessage: { role: "agent", text: "请在 Codex 中确认方案" },
        activities: [], turnState: {}, canReply: false, canRetry: false, canStop: false, canArchive: true,
        replyBlockedReason: "external_progress_only", settings: { mode: "external", adjustable: false },
        attention: { state: "needed", kind: "action", reason: "请在 Codex 中确认方案", revision: "question" },
        needsAttention: true, waitingForReply: true, unread: true, unreadAt: stamp,
      };
      const detail: { -readonly [K in keyof AgentSession]: AgentSession[K] } = {
        id: summary.id, source: "external", agentKind: "codex", status: "stalled",
        progressStatus: "waiting_for_input", refKind: "tracking", lastReportedAt: stamp, updatedAt: stamp,
        messages: [{ id: "question", sourceId: "question", role: "agent", text: "已定位问题，请在 Codex 中确认方案。", occurredAt: stamp }],
        activities: [], turnState: {}, canReply: false, canResolveDelivery: false, canAttach: false,
        replyBlockedReason: "external_progress_only",
      };
      await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/read")) {
          read = true;
          await route.fulfill({ status: 204 });
        } else if (path.endsWith("/external-session")) {
          await route.fulfill({ json: detail });
        } else if (path.endsWith("/agent-sessions")) {
          await route.fulfill({ json: { sessions: [{ ...summary, unread: !read }] } });
        } else {
          throw new Error(`Unexpected external control request: ${path}`);
        }
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/?product=${fixture.productId}&console=agent&session=external-session`);
      await expect(page.getByText("已定位问题，请在 Codex 中确认方案。")).toBeVisible();
      await expect(page.getByText("这里显示 Agent 上报的处理进展，并非同步后的完整对话。状态以最近一次上报为准。")).toBeVisible();
      await expect(page.getByText("当前为跟踪记录，尚未绑定原生会话编号。")).toBeVisible();
      await expect(page.getByText("请在原 Agent 客户端回复；这条进展记录暂不支持 Web 回复。")).toBeVisible();
      await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
      await expect(page.locator(".agent-console-connection-banner.offline")).toHaveCount(0);
      await expect.poll(() => read).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`external-${width}-${theme}.png`) });
      summary.status = "failed";
      summary.progressStatus = "failed";
      detail.status = "failed";
      detail.progressStatus = "failed";
      // A reported handling failure must not fabricate a Codex runtime diagnostic.
      await page.reload();
      await expect(page.getByText("上报：处理失败").last()).toBeVisible();
      await expect(page.locator(".agent-console-failure")).toHaveCount(0);
    });
  }
}
