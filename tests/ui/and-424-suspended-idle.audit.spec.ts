import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const release = "Claude Code 会话已空闲 2 小时，进程已挂起；发送下一条消息时会恢复。";

/**
 * AND-424: releasing an idle Claude session is routine housekeeping, not an
 * error. The explanation belongs inside the run details; the red banner is
 * reserved for sessions that actually failed.
 */
function routes(page: import("@playwright/test").Page, session: Record<string, unknown>) {
  return page.route("**/api/v1/agent-sessions**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: [session] } });
    return route.fulfill({ json: { ...session, messages: [], activities: [], canReply: true, command: undefined } });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`a suspended session explains itself in the run details ${theme}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1440, height: 900 }, colorScheme: theme,
      storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    const stamp = new Date().toISOString();
    const id = `and424-suspended-${theme}`;
    const session = { id, agentSessionId: id, agentKind: "claude_code", status: "suspended", lastError: release,
      updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
      mode: "bypass", dispatchStatus: "launched", settings: {}, activities: [], turnState: { turnActive: false },
      canReply: true, canStop: false, canArchive: true, canRetry: false, unread: false,
      items: [{ key: "EX-424", title: "空闲挂起", productId: fixture.productId }], attention: { state: "not_needed" },
      needsAttention: false, waitingForReply: false };
    await routes(page, session);
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const details = page.locator(".agent-run-details");
    await expect(details.locator("summary")).toContainText("已挂起");
    // The release is routine housekeeping: no danger banner anywhere.
    await expect(page.locator(".inline-error")).toHaveCount(0);
    await expect(page.locator(".agent-run-diagnostics")).not.toBeVisible();
    await details.locator("summary").click();
    await expect(page.locator(".agent-run-diagnostics")).toContainText(release);
    await expect(page.locator(".inline-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`suspended-${theme}.png`) });
    await context.close();
  });
}

test("a genuinely unavailable session keeps the error banner", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1440, height: 900 }, storageState: "./tests/ui/.auth/state.json" });
  const page = await context.newPage();
  const stamp = new Date().toISOString();
  const id = "and424-unavailable";
  const session = { id, agentSessionId: id, agentKind: "claude_code", status: "unavailable", lastError: "节点已离线，暂时无法同步。",
    updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeConnectionState: "offline", nodeRevoked: false,
    mode: "bypass", dispatchStatus: "launched", settings: {}, activities: [], turnState: { turnActive: false },
    canReply: false, canStop: false, canArchive: true, canRetry: false, unread: false,
    items: [{ key: "EX-424", title: "空闲挂起", productId: fixture.productId }], attention: { state: "not_needed" },
    needsAttention: false, waitingForReply: false };
  await routes(page, session);
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  await expect(page.locator(".inline-error")).toContainText("节点已离线");
  await context.close();
});
