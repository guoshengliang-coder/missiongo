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
  test(`phone failure details and recovery with stored locale: ${theme} ${language}`, async ({ browser }, testInfo) => {
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
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const card = page.locator(".agent-console-failure");
    await expect(card).toBeVisible();
    await expect(card).toContainText("codex_context_window_exceeded");
    await expect(card).toContainText("上下文上限");
    await expect(page.locator(".agent-console-activity-failed")).toHaveCount(0);
    await expect(card.locator("pre")).toBeHidden();
    await card.locator("summary").click();
    await expect(card.locator("pre")).toBeVisible();
    for (const secret of ["synthetic-private-value", "example.invalid", "/Users/fixture"]) expect(await card.innerText()).not.toContain(secret);
    expect(await card.locator("summary").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await card.getByRole("button").click();
    await expect(card).toContainText("已复制");
    expect(await page.evaluate(() => localStorage.getItem("hg193-copied"))).toContain("turn: turn-failed");
    await page.evaluate(() => localStorage.setItem("hg193-copy-fail", "yes"));
    await card.getByRole("button").click();
    await expect(card).toContainText("手动复制");
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

for (const outcome of ["delivered", "failed", "delivery_unknown"] as const) {
  test(`phone manually continues after a model failure: ${outcome}`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 375, height: 812 },
      isMobile: true, hasTouch: true, storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("missiongo.locale", "zh-CN"));
    const temporary = { code: "codex_server_error", turnId: "old-turn" };
    let current: Record<string, unknown> = { ...detail, failure: temporary, command: undefined, canResolveDelivery: true };
    const sent: string[] = [];
    const reply = { id: "manual-new", kind: "message", text: "继续检查", status: "queued", createdAt: stamp };
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        sent.push(request.postDataJSON().text);
        current = { ...current, command: reply };
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(reply) });
        return;
      }
      const body = new URL(request.url()).pathname === "/api/v1/agent-sessions"
        ? { sessions: [{ ...summary, failure: temporary }] } : current;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(url);
    const card = page.locator(".agent-console-failure");
    const composer = page.locator(".agent-console-reply textarea");
    await expect(card).toContainText("输入新消息并手动发送");
    expect(sent).toEqual([]);
    await expect(composer).toBeEnabled();
    await composer.fill(reply.text);
    await page.locator(".agent-console-reply button[type=submit]").click();
    await expect(composer).toBeDisabled();
    expect(sent).toEqual([reply.text]);
    current = { ...current, command: { ...reply, status: outcome, updatedAt: "2026-10-01T15:00:01.000Z",
      ...(outcome === "failed" ? { error: "回复未发送：原会话无法恢复" } : {}) },
      ...(outcome === "delivered" ? { status: "active", failure: undefined,
        messages: [{ id: "mirror", sourceId: reply.id, role: "user", text: reply.text, occurredAt: stamp }] } : {}) };
    if (outcome === "delivery_unknown") {
      await expect(page.locator(".agent-console-message-delivery")).toContainText("未收到");
      await expect(composer).toBeDisabled();
    } else {
      await expect(composer).toBeEnabled();
      if (outcome === "delivered") await expect(card).toHaveCount(0);
      else await expect(page.locator(".agent-console-message-delivery")).toContainText("原会话无法恢复");
    }
    await page.reload();
    await expect(composer).toBeVisible();
    expect(sent).toEqual([reply.text]); // Polling and reloading cannot replay it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await context.close();
  });
}
