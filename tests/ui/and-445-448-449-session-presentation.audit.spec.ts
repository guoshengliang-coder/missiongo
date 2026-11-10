import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as {
  productId: string; detailKey: string;
};
const stamp = new Date().toISOString();

type Kind = "waiting" | "claimed" | "integration";

/** One synthetic conversation per case, never a real Agent or batch. */
async function mockSession(page: Page, kind: Kind, id = `and449-${kind}`) {
  const items = kind === "integration" ? [] : [{ key: fixture.detailKey, title: "认领后的条目标题", productId: fixture.productId }];
  const status = kind === "waiting" ? "idle" : "active";
  const common = { id, agentSessionId: id, dispatchId: `and449-${kind}-dispatch`, agentKind: "claude_code", status,
    createdAt: stamp, updatedAt: stamp, activityAt: stamp, mode: "default", dispatchStatus: "launched",
    nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, settings: {},
    ...(kind === "claimed" ? { productId: fixture.productId, sessionName: "这是什么问题？ · 1234abcd" } : {}),
    ...(kind === "integration" ? { productId: fixture.productId, sessionPurpose: "integration", sessionName: `集成 · ${fixture.detailKey}` } : {}),
    items, canReply: true, canStop: false, canArchive: true, canRetry: false, unread: false,
    attention: { state: "not_needed" }, needsAttention: false,
    waitingForReply: kind === "waiting", activities: [],
    turnState: { turnActive: kind !== "waiting", waitingForInput: kind === "waiting" } };
  const detail = { ...common, messages: [{ id: "answer", sourceId: "answer", role: "agent", text: "已读取本批条目与 PR。", occurredAt: stamp }] };
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    await route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [common] } : detail });
  });
  if (kind === "integration") {
    await page.route(/\/merge-deliveries(?:\?.*)?$/, route => route.fulfill({ json: {
      deliveries: [{ id: "and449-delivery", productId: fixture.productId, sessionId: id, revision: "frozen", state: "batched",
        summary: "会话呈现调整", validation: "本地检查通过", itemKeys: [fixture.detailKey, "AND-448", "AND-445"],
        head: "a".repeat(40), requiredArtifacts: ["web"], pullRequestUrl: "https://example.test/pr/1",
        evidence: { checkedAt: stamp, source: "synthetic" } }],
      batches: [{ id: "and449-batch", sessionId: id, state: "active", deliveries: ["and449-delivery"], publish: false, results: {} }],
      attentionSessionIds: [] } }));
  }
  return id;
}

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ hasTouch: width < 1024, isMobile: width < 1024 });

    test(`waiting conversation keeps its own status icon at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      const id = await mockSession(page, "waiting");
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      // The list row and the run summary both read as "your move", not as done (AND-448).
      // Narrow layouts show the conversation alone, so the row is only visible above the breakpoint.
      if (width >= 1024) {
        await expect(page.locator(".agent-console-session-row .agent-console-status-waiting").first()).toBeVisible();
        await expect(page.locator(".agent-console-session-row .agent-console-status-waiting svg")).toHaveClass(/agent-session-waiting/);
      }
      await expect(page.locator(".agent-run-details svg.agent-session-waiting")).toBeVisible();
      await expect(page.locator(".agent-run-details > summary")).toContainText("等待回复");
      await expect(page.locator(".agent-run-details > summary")).not.toContainText("运行中");
      await page.screenshot({ path: testInfo.outputPath(`waiting-${width}-${theme}.png`), fullPage: true });
    });

    test(`claimed project conversation takes the item title at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ colorScheme: theme });
      const id = await mockSession(page, "claimed");
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const heading = page.locator(".agent-console-session-heading strong").first();
      await expect(heading).toContainText(fixture.detailKey);
      await expect(heading).toContainText("认领后的条目标题");
      await expect(heading).not.toContainText("这是什么问题？");
      await page.screenshot({ path: testInfo.outputPath(`claimed-${width}-${theme}.png`), fullPage: true });
    });

    test(`integration conversation lists the batch items in its head at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ colorScheme: theme });
      const id = await mockSession(page, "integration");
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const head = page.locator(".agent-console-conversation-head");
      await expect(head.locator("h2")).toContainText("集成");
      await expect(head.locator(".agent-console-dispatch-head button")).toHaveText([fixture.detailKey, "AND-448", "AND-445"]);
      await page.screenshot({ path: testInfo.outputPath(`integration-${width}-${theme}.png`), fullPage: true });
    });
  });
}
