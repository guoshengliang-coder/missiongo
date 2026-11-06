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

test.describe("project-scoped navigation on touch devices", () => {
test.use({ hasTouch: true });
for (const dark of [false, true]) for (const scale of ["small", "medium", "large"]) {
  test(`project navigation keeps other projects in a read-only hint ${dark} ${scale}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    const current = summary("当前会话", fixture.productId, false);
    const currentAttention = summary("当前待处理", fixture.productId, true);
    const shared = { ...summary("多项目问题", other.id), items: [
      { key: "X-1", title: "shared", productId: fixture.productId },
      { key: "X-2", title: "shared", productId: fixture.productId },
    ] };
    const otherAttention = { ...summary("其他项目待处理", other.id), unread: false };
    const otherUnread = summary("其他项目未读", other.id, false);
    const otherRunning = { ...summary("运行中未读", other.id, false), status: "active" };
    const otherArchived = { ...summary("已归档未读", other.id, true), archivedAt: "2026-11-01T00:00:00.000Z" };
    const sessions = [current, currentAttention, shared, otherAttention, otherUnread, otherRunning, otherArchived];
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
    const unread = nav.getByRole("button", { name: /^未读会话/ });
    const all = nav.getByRole("button", { name: /^全部会话/ });
    await expect(pending.locator("small")).toHaveText("2");
    await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
    await expect(unread.locator("small")).toHaveText("3");
    await expect(all.locator("small")).toHaveText("3");
    await expect(nav.getByRole("group", { name: "所有项目", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("group", { name: "当前项目", exact: true })).toBeVisible();
    const hint = page.locator(".agent-console-other-projects");
    await expect(hint).toHaveAttribute("role", "status");
    await expect(hint.getByRole("button")).toHaveCount(0);
    await expect(hint).toContainText("其他项目：待我处理 1");
    await expect(hint).toContainText("未读会话 1");
    await expect(page.locator(".agent-console-session-project")).toHaveCount(0);
    await expect(page.locator(".agent-console-session")).toHaveCount(3);
    await expect(page.locator(".agent-console-session").filter({ hasText: "其他项目未读" })).toHaveCount(0);
    const hintBox = await hint.boundingBox();
    const controlsBox = await page.locator(".agent-console-list-controls").boundingBox();
    expect(hintBox!.y).toBeLessThan(controlsBox!.y);

    // The shared session reaches the current project through an item, so it stays
    // in this list; its draft is still isolated from the other project's sessions.
    await page.locator(".agent-console-session").filter({ hasText: "多项目问题" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
    await page.locator(".agent-console-reply textarea").fill("另一个项目的草稿");
    await page.locator(".agent-console-session").filter({ hasText: "当前会话" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("");
    await page.locator(".agent-console-session").filter({ hasText: "多项目问题" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("另一个项目的草稿");
    await page.getByRole("button", { name: "进入所属项目", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("missiongo.product"))).toBe(other.id);

    // The list now belongs to the other project; the hint points back at the first.
    // Opening the shared and current rows cleared their unread, not their attention.
    await expect(pending.locator("small")).toHaveText("2");
    await expect(unread.locator("small")).toHaveText("1");
    await expect(hint).toContainText("其他项目：待我处理 1");
    await expect(hint).toContainText("未读会话 1");

    await page.locator(".agent-console-reply textarea").fill("回答");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent).toBe(1);
    await advanceSessionListPoll(page);
    await expect(pending.locator("small")).toHaveText("1");
    await expect(hint).toContainText("待我处理 1");
    expect(await page.evaluate(() => localStorage.getItem("missiongo.product"))).toBe(other.id);

    // Leave the conversation before checking the single-pane layout: the list
    // and its hint are the pane this test measures.
    await nav.getByRole("button", { name: /^异常/ }).click();
    await expect(page.locator(".agent-console-conversation h2")).toHaveCount(0);

    for (const width of [320, 520, 521, 1023, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const visibleNav = page.locator(width <= 1023 ? ".agent-console-mobile-filters" : ".agent-console-filters");
      await expect(visibleNav.getByRole("group", { name: "当前项目", exact: true })).toBeVisible();
      await expect(visibleNav.getByRole("group", { name: "所有项目", exact: true })).toHaveCount(0);
      await expect(hint).toBeVisible();
      const hintAtWidth = await hint.boundingBox();
      const filterBarAtWidth = await page.locator(width <= 1023 ? ".agent-console-mobile-filters" : ".agent-console-list-controls").boundingBox();
      expect(hintAtWidth!.y).toBeLessThan(filterBarAtWidth!.y);
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

test.describe("cross-project hint", () => {
  test("shows separate counts only while another project has work", async ({ page }) => {
    const current = summary("当前会话", fixture.productId, false);
    current.unread = false;
    const otherBoth = summary("其他项目问题", other.id);
    const otherRunning = { ...summary("运行中未读", other.id, false), status: "active" };
    const otherArchived = { ...summary("已归档未读", other.id, true), archivedAt: "2026-11-01T00:00:00.000Z" };
    const sessions = [current, otherBoth, otherRunning, otherArchived];
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const row = sessions.find(session => session.id === id);
      if (path.endsWith("/read")) { row!.unread = false; await route.fulfill({ status: 204 }); return; }
      await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions } : { ...row, messages: [], canResolveDelivery: false } });
    });
    await page.clock.install();
    await page.goto(`/?product=${fixture.productId}&console=agent`);
    const hint = page.locator(".agent-console-other-projects");
    await expect(hint).toContainText("其他项目：待我处理 1");
    await expect(hint).toContainText("未读会话 1");
    const controlsWithHint = await page.locator(".agent-console-list-controls").boundingBox();

    otherBoth.unread = false;
    await advanceSessionListPoll(page);
    await expect(hint).toContainText("其他项目：待我处理 1");
    await expect(hint).not.toContainText("未读会话");

    otherBoth.needsAttention = false;
    otherBoth.attention.state = "not_needed";
    otherBoth.unread = true;
    await advanceSessionListPoll(page);
    await expect(hint).toContainText("其他项目：未读会话 1");
    await expect(hint).not.toContainText("待我处理");

    otherBoth.unread = false;
    await advanceSessionListPoll(page);
    await expect(hint).toHaveCount(0);
    const controlsWithoutHint = await page.locator(".agent-console-list-controls").boundingBox();
    expect(controlsWithoutHint!.y).toBeLessThan(controlsWithHint!.y);
  });
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
