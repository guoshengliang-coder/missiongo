import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionListPoll, advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
let other: { id: string; name: string };
test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/v1/products", { data: { name: "跨项目验收", keyPrefix: `C${Date.now().toString(36).toUpperCase()}` } });
  expect(response.status()).toBe(201);
  other = await response.json();
});

function summary(id: string, productId: string, attention = true) {
  return { id, agentSessionId: id, dispatchId: `dispatch-${id}`, agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched",
    productId, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", activityAt: "2026-11-01T00:00:00.000Z",
    sessionName: id, items: [], nodeName: "Fixture", nodeRevoked: false, nodeConnectionState: "online", activities: [], settings: { adjustable: false },
    canReply: true, canAttach: true, canRetry: false, canStop: false, canArchive: true, unread: true, unreadAt: "2026-11-01T00:00:00.000Z",
    needsAttention: attention, attention: { state: attention ? "needed" : "not_needed", kind: "answer", revision: id, reason: "请回答问题" } };
}

test.describe("grouped navigation on touch devices", () => {
test.use({ hasTouch: true });
for (const dark of [false, true]) for (const scale of ["small", "medium", "large"]) {
  test(`global navigation preserves context ${dark} ${scale}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    const a = summary("当前会话", fixture.productId, false);
    const b = summary("其他项目问题", other.id);
    const shared = { ...summary("多项目问题", other.id), items: [
      { key: "X-1", title: "shared", productId: fixture.productId },
      { key: "X-2", title: "shared", productId: fixture.productId },
    ] };
    const running = { ...summary("运行中未读", other.id, false), status: "active" };
    const sessions = [a, b, shared, running];
    let sent = 0;
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const row = sessions.find(session => session.id === id);
      if (path.endsWith("/read")) { row!.unread = false; await route.fulfill({ status: 204 }); return; }
      if (path.endsWith("/commands")) {
        sent++; row!.needsAttention = false; row!.attention.state = "not_needed";
        await route.fulfill({ status: 201, json: { id: "sent", kind: "message", status: "delivered", text: "回答", createdAt: new Date().toISOString() } }); return;
      }
      await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions } : { ...row, messages: [{ id: "ask", role: "agent", text: "请回答问题", occurredAt: row!.createdAt }], canResolveDelivery: false } });
    });
    await page.clock.install();
    await page.goto(`/?product=${fixture.productId}&console=agent`);
    const nav = page.locator(".agent-console-filters");
    const pending = nav.getByRole("button", { name: /^待我处理/ });
    await expect(pending.locator("small")).toHaveText("2");
    await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
    await expect(nav.getByRole("button", { name: /^未读会话/ }).locator("small")).toHaveText("3");
    await expect(page.locator(".agent-console-total-unread")).toHaveCount(0);
    await pending.click();
    await expect(page.locator(".agent-console-session")).toHaveCount(2);
    const row = page.locator(".agent-console-session").filter({ hasText: "其他项目问题" });
    await expect(row).toContainText(other.name);
    await row.click();
    await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
    await advanceSessionListPoll(page);
    await expect(pending.locator("small")).toHaveText("2");
    expect(await page.evaluate(() => localStorage.getItem("missiongo.product"))).toBe(fixture.productId);
    await page.locator(".agent-console-reply textarea").fill("另一个项目的草稿");
    await page.locator(".agent-console-session").filter({ hasText: "多项目问题" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("");
    await row.click();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("另一个项目的草稿");
    await page.getByRole("button", { name: "进入所属项目", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("missiongo.product"))).toBe(other.id);
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("另一个项目的草稿");
    await page.locator(".agent-console-reply textarea").fill("回答");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent).toBe(1);
    await expect(pending.locator("small")).toHaveText("1");
    await pending.click();
    await expect(page.locator(".agent-console-conversation h2")).toHaveCount(0);
    for (const width of [320, 520, 521, 1023, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const visibleNav = page.locator(width <= 1023 ? ".agent-console-mobile-filters" : ".agent-console-filters");
      await expect(visibleNav.getByRole("group", { name: "所有项目", exact: true })).toBeVisible();
      await expect(visibleNav.getByRole("group", { name: "当前项目", exact: true })).toBeVisible();
      for (const label of ["待我处理", "未读会话", "运行中", "全部会话", "异常", "已归档"]) {
        const button = visibleNav.getByRole("button", { name: new RegExp(`^${label}`) });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(await button.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await visibleNav.locator(".agent-console-filter-items").evaluateAll(rows => rows.forEach(row => { row.scrollLeft = 0; }));
      if (width === 320 || width === 1440) await page.screenshot({ path: test.info().outputPath(`navigation-${width}.png`) });
    }
  });
}

});

for (const phone of [false, true]) test(`cancellation race stays in its session and clears on next send ${phone}`, async ({ page }) => {
  await page.setViewportSize({ width: phone ? 320 : 1440, height: 900 });
  const a = summary("撤回竞态", fixture.productId, false);
  const b = summary("另一会话", fixture.productId, false);
  let phase = "queued";
  const command = () => ({ id: phase === "continued" ? "next" : "first", kind: "message", text: "继续", status: phase === "queued" ? "queued" : "delivered", createdAt: phase === "continued" ? new Date().toISOString() : a.createdAt });
  let cancelCalls = 0;
  let sends = 0;
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) {
      cancelCalls++; phase = "delivered";
      await route.fulfill({ status: 409, json: { code: "agent_reply_not_pending", title: "Only a queued reply can be cancelled." } }); return;
    }
    if (path.endsWith("/commands")) { sends++; phase = "continued"; await route.fulfill({ status: 201, json: command() }); return; }
    if (route.request().method() !== "GET") { await route.fulfill({ status: 204 }); return; }
    const isA = path.includes(encodeURIComponent(a.id));
    await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a, b] }
      : { ...(isA ? a : b), command: isA ? command() : undefined, messages: [{ id: "message", role: "agent", text: "已有会话正文", occurredAt: a.createdAt }], canResolveDelivery: false } });
  });
  await page.clock.install();
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${encodeURIComponent(a.id)}`);
  await page.getByRole("button", { name: "撤回编辑", exact: true }).click();
  const feedback = page.getByLabel("会话操作反馈");
  await expect(feedback).toContainText("无法再撤回编辑");
  await expect(page.locator(".agent-console-reply .inline-error")).toHaveCount(0);
  await advanceSessionDetailPoll(page);
  await expect(feedback).toContainText("无法再撤回编辑");
  if (await page.getByRole("button", { name: "返回会话列表", exact: true }).isVisible()) await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await page.locator(".agent-console-session").filter({ hasText: b.id }).click();
  await expect(page.getByLabel("会话操作反馈")).not.toContainText("无法再撤回编辑");
  if (await page.getByRole("button", { name: "返回会话列表", exact: true }).isVisible()) await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await page.locator(".agent-console-session").filter({ hasText: a.id }).click();
  await expect(page.getByLabel("会话操作反馈")).toContainText("无法再撤回编辑");
  await page.locator(".agent-console-reply textarea").fill("继续");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await expect(page.getByLabel("会话操作反馈")).not.toContainText("无法再撤回编辑");
  expect(cancelCalls).toBe(1);
});

test("a late recall failure belongs to its original conversation", async ({ page }) => {
  const a = summary("迟到失败", fixture.productId, false);
  const b = summary("当前输入", fixture.productId, false);
  let release: (() => void) | undefined;
  let cancelling = false;
  let stopped = 0;
  await page.route("**/api/v1/dispatches/**/stop", async route => { stopped++; await route.fulfill({ status: 204 }); });
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) {
      cancelling = true;
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 409, json: { code: "agent_reply_not_pending", title: "Only a queued reply can be cancelled." } }); return;
    }
    if (path.endsWith("/commands")) { await route.fulfill({ status: 201, json: { id: "b-send", kind: "message", text: "独立回复", status: "delivered", createdAt: new Date().toISOString() } }); return; }
    if (route.request().method() !== "GET") { await route.fulfill({ status: 204 }); return; }
    const isA = path.includes(encodeURIComponent(a.id));
    await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a, b] } : {
      ...(isA ? a : b), messages: [], canResolveDelivery: false,
      command: isA ? { id: "recall", kind: "message", text: "原消息", status: cancelling ? "delivered" : "queued", createdAt: a.createdAt } : undefined,
    } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${encodeURIComponent(a.id)}`);
  await page.getByRole("button", { name: "撤回编辑", exact: true }).click();
  await expect.poll(() => cancelling).toBe(true);
  await page.locator(".agent-console-session").filter({ hasText: b.id }).click();
  await page.locator(".agent-console-reply textarea").fill("独立回复");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  release!();
  await expect(page.getByLabel("会话操作反馈")).not.toContainText("无法再撤回编辑");
  await page.locator(".agent-console-session").filter({ hasText: a.id }).click();
  await expect(page.getByLabel("会话操作反馈")).toContainText("无法再撤回编辑");
  expect(stopped).toBe(0);
});

test("embedded item conversation shares recall recovery and visible run feedback", async ({ page }) => {
  const { detailKey } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { detailKey: string };
  let phase = "queued";
  const a = summary("embedded-recall", fixture.productId, false);
  const command = () => ({ id: phase === "continued" ? "next" : "first", kind: "message", text: "继续", status: phase === "queued" ? "queued" : "delivered", createdAt: phase === "continued" ? new Date().toISOString() : a.createdAt });
  await page.route(`**/api/v1/items/${detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: a.dispatchId, agentSessionId: a.id, nodeName: "Fixture", agentKind: "codex", mode: "auto", status: "launched", itemKeys: [detailKey], createdAt: a.createdAt,
  }] } }));
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) { phase = "delivered"; await route.fulfill({ status: 409, json: { code: "agent_reply_not_pending", title: "Only a queued reply can be cancelled." } }); return; }
    if (path.endsWith("/commands")) { phase = "continued"; await route.fulfill({ status: 201, json: command() }); return; }
    if (route.request().method() !== "GET") { await route.fulfill({ status: 204 }); return; }
    await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a] } : { ...a, command: command(), messages: [], canResolveDelivery: false } });
  });
  await page.goto(`/?product=${fixture.productId}&item=${detailKey}`);
  await page.locator(".execution-history > summary").click();
  await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
  await page.locator(".agent-session-toggle").click();
  const panel = page.locator(".agent-session-panel");
  await panel.getByRole("button", { name: "撤回编辑", exact: true }).click();
  await expect(panel.getByLabel("会话操作反馈")).toContainText("无法再撤回编辑");
  await expect(panel.locator(".agent-run-details")).not.toHaveAttribute("open", "");
  await panel.locator("textarea").fill("继续");
  await panel.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect(panel.getByLabel("会话操作反馈")).not.toContainText("无法再撤回编辑");
});
