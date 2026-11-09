import { refreshFromConsoleStream } from "./polling";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  for (const failure of [false, true]) test(`merge navigation waits for fresh list, retry=${failure} ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const stalePoll = width === 1440 && theme === "light" && !failure;
    if (stalePoll) await page.clock.install();
    const stamp = new Date().toISOString();
    const id = "new-integration";
    let created = false, failList = failure, creates = 0, freshReads = 0;
    let beforeReads = 0, staleReturned = false;
    let releaseStale!: () => void;
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const summary = { id, agentSessionId: id, dispatchId: "integration-dispatch", productId: fixture.productId,
      agentKind: "codex", status: "idle", dispatchStatus: "launched", sessionName: "新集成会话",
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, nodeId: "merge-node", nodeName: "Fixture",
      nodeConnectionState: "online", mode: "auto", items: [], activities: [], settings: {},
      canReply: true, canStop: false, canRetry: false, canArchive: true, unread: false,
      attention: { state: "not_needed" }, needsAttention: false };
    const batch = { id: "batch", sessionId: id, state: "active", deliveries: ["delivery"], results: {}, publish: false };
    const delivery = { id: "delivery", productId: fixture.productId, sessionId: "source", revision: "r1", state: "confirmed",
      itemKeys: ["EX-436"], head: "a".repeat(40), summary: "导航回归", validation: "Synthetic", requiredArtifacts: ["web"],
      pullRequestUrl: "https://github.com/example/project/pull/1", evidence: { checkedAt: stamp, source: "Fixture" } };
    await page.route("**/merge-deliveries", route => route.fulfill({ json: { deliveries: created ? [] : [delivery], batches: created ? [batch] : [] } }));
    await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: "merge-node", name: "Fixture", online: true,
      supportsFreeSessions: true, agents: [{ kind: "codex", ready: true, planApprovalProtocol: 1, models: [] }],
      repos: [{ productId: fixture.productId, repoPath: "synthetic" }], repoCandidates: [], createdAt: stamp }] } }));
    await page.route("**/api/v1/dispatch-defaults", route => route.fulfill({ json: { nodeId: "merge-node", agentKind: "codex", agents: { codex: { mode: "auto" } } } }));
    await page.route("**/merge-batches", route => { creates++; created = true; return route.fulfill({ json: batch }); });
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      if (path === "/api/v1/agent-sessions") {
        if (!created) {
          beforeReads++;
          if (stalePoll && beforeReads > 1) {
            await staleGate;
            await route.fulfill({ json: { sessions: [] } });
            staleReturned = true;
            return;
          }
          return route.fulfill({ json: { sessions: [] } });
        }
        freshReads++;
        await gate;
        return failList ? route.fulfill({ status: 503, json: { title: "Synthetic list failure" } })
          : route.fulfill({ json: { sessions: [summary] } });
      }
      return route.fulfill({ json: { ...summary, messages: [{ id: "answer", role: "agent", text: "集成会话正文", occurredAt: stamp }] } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent`);
    await page.getByRole("button", { name: "待集成 1", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".merge-row input").check();
    await dialog.getByRole("button", { name: "下一步：配置 Agent" }).click();
    if (stalePoll) {
      await refreshFromConsoleStream(page);
      await page.clock.runFor(5_000);
      await expect.poll(() => beforeReads).toBeGreaterThan(1);
    }
    await page.evaluate(() => {
      const state = window as unknown as { unavailableSeen: boolean };
      state.unavailableSeen = false;
      new MutationObserver(() => { if (document.body.textContent?.includes("该会话已失效")) state.unavailableSeen = true; })
        .observe(document.body, { childList: true, subtree: true });
    });
    await dialog.getByRole("button", { name: "开始处理" }).click();
    await expect.poll(() => freshReads).toBeGreaterThan(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status").filter({hasText:"正在读取对话…"})).toHaveText("正在读取对话…");
    await expect(page.locator(".agent-console-heading")).toHaveCount(0);
    release();
    if (failure) {
      const error = dialog.getByRole("alert").filter({ hasText: "暂时无法读取会话列表" });
      await expect(error).toBeVisible();
      expect(creates).toBe(1);
      failList = false;
      await error.getByRole("button", { name: "重试", exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".agent-console-messages")).toContainText("集成会话正文");
    if (stalePoll) {
      releaseStale();
      await expect.poll(() => staleReturned).toBe(true);
      await expect(page.locator(".agent-console-messages")).toContainText("集成会话正文");
    }
    expect(creates).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { unavailableSeen: boolean }).unavailableSeen)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("opened-integration.png") });
  });
}
