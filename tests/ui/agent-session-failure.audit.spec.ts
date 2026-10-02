import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "hg193-failure-fixture";
const stamp = "2026-10-01T15:00:00.000Z";
const url = `/?product=${fixture.productId}&console=agent&session=${id}`;
const failure = { code: "codex_context_window_exceeded", turnId: "turn-failed", detail: "Context limit token=synthetic-private-value https://example.invalid/private /Users/fixture/private.log" };
const summary = {
  id, agentSessionId: id, dispatchId: "dispatch-hg193", agentKind: "codex", status: "failed", failure,
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture Mac", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp,
  items: [{ key: "HG-193", title: "Failure diagnostics", productId: fixture.productId }],
  activities: [], canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, nodeId: "fixture-node", settings: {}, unread: false,
};
const command = { id: "pending", kind: "message", text: "What is the status?", status: "queued", createdAt: stamp };
const detail = { id, dispatchId: summary.dispatchId, agentKind: "codex", status: "failed", failure,
  updatedAt: stamp, messages: [], activities: [], turnState: { turnActive: false }, command,
  canReply: true, canResolveDelivery: false };

for (const theme of ["light", "dark"]) for (const language of ["zh-CN", "en"]) {
  test(`phone failure details and recovery: ${theme} ${language}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 353, height: 757 }, isMobile: true, hasTouch: true,
      colorScheme: theme as "light" | "dark", storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.addInitScript((locale) => {
      localStorage.setItem("missiongo.locale", locale);
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => {
        if (localStorage.getItem("hg193-copy-fail")) throw new Error("fixture copy refusal");
        localStorage.setItem("hg193-copied", text);
      } } });
    }, language);
    let current: unknown = detail;
    const sent: string[] = [];
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") sent.push(request.method());
      const body = new URL(request.url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : current;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(url);
    const card = page.locator(".agent-console-failure");
    await expect(card).toBeVisible();
    await expect(card).toContainText("codex_context_window_exceeded");
    await expect(card).toContainText(language === "zh-CN" ? "上下文上限" : "context limit");
    await expect(page.locator(".agent-console-activity-failed")).toHaveCount(0);
    await expect(card.locator("pre")).toBeHidden();
    await card.locator("summary").click();
    await expect(card.locator("pre")).toBeVisible();
    for (const secret of ["synthetic-private-value", "example.invalid", "/Users/fixture"]) expect(await card.innerText()).not.toContain(secret);
    expect(await card.locator("summary").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await card.getByRole("button").click();
    await expect(card).toContainText(language === "zh-CN" ? "已复制" : "Copied");
    expect(await page.evaluate(() => localStorage.getItem("hg193-copied"))).toContain("turn: turn-failed");
    await page.evaluate(() => localStorage.setItem("hg193-copy-fail", "yes"));
    await card.getByRole("button").click();
    await expect(card).toContainText(language === "zh-CN" ? "手动复制" : "manually");
    await page.screenshot({ path: testInfo.outputPath(`failure-${theme}-${language}.png`) });
    expect(sent).toEqual([]); // Viewing, expanding and copying never replay the queued reply.
    const recovered = { ...detail, status: "idle", command: undefined, failure: undefined };
    current = recovered;
    await page.reload(); // List still has the old failure; detail is authoritative.
    await expect(card).toHaveCount(0);
    expect(sent).toEqual([]);
    await context.close();
  });
}

test("old Mac without error details shows an honest fallback", async ({ page }) => {
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const body = new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [{ ...summary, failure: undefined }] } : { ...detail, failure: undefined };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(url);
  const card = page.locator(".agent-console-failure");
  await expect(card).toContainText("codex_failure_detail_unavailable");
  await expect(card).toContainText("Mac 未提供具体原因");
  await expect(card).toContainText("更新 MissionGo Mac 客户端");
});
