import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, colorScheme: theme });
    test(`limited Codex history preserves conversation controls ${width}px ${theme}`, async ({ page }, testInfo) => {
      const id = "long-codex-history";
      const stamp = new Date().toISOString();
      let limited = true;
      let sends = 0;
      await page.route("**/api/v1/agent-sessions**", async route => {
        if (route.request().method() !== "GET") {
          if (route.request().url().endsWith("/commands")) sends++;
          return route.fulfill({ status: 204 });
        }
        const summary = {
          id, agentSessionId: id, dispatchId: "long-history-dispatch", agentKind: "codex", status: "idle",
          updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
          nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched",
          activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: true, canArchive: true,
          items: [], attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false,
          ...(limited ? { lastError: "codex_history_limited: recent history or runtime metadata only" } : {}),
        };
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : {
          ...summary, messages: [{ id: "cached", sourceId: "cached", role: "agent", text: "Previously synced answer", occurredAt: stamp }],
        } });
      });
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const warning = page.locator(".agent-console-attention-banner").filter({ hasText: "历史同步受限" });
      await expect(warning).toBeVisible();
      await expect(page.locator(".agent-console-message")).toContainText("Previously synced answer");
      await expect(page.locator(".agent-console-reply textarea")).toBeEnabled();
      await expect(page.locator(".agent-console-recovery")).toHaveCount(0);
      await expect(page.getByText("当前会话暂时不可用。", { exact: true })).toHaveCount(0);
      await expect(page.getByText("codex_history_limited:", { exact: false })).toHaveCount(0);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; }, scale);
        await expect(warning).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
      expect(sends).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`history-${width}-${theme}.png`) });
      limited = false;
      await page.reload();
      await expect(page.locator(".agent-console-message")).toContainText("Previously synced answer");
      await expect(warning).toHaveCount(0);
      await expect(page.locator(".agent-console-reply textarea")).toBeEnabled();
    });
  });
}
