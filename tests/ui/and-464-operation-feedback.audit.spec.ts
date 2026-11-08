import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";
import { chooseOption } from "./select-helpers";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
test.use({ hasTouch: true });

const stamp = "2026-11-01T00:00:00.000Z";
function row(id: string) {
  return { id, agentSessionId: id, dispatchId: `dispatch-${id}`, sessionName: id, productId: fixture.productId,
    agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", nodeName: "Fixture",
    nodeConnectionState: "online", nodeRevoked: false, createdAt: stamp, updatedAt: stamp, activityAt: stamp,
    activities: [], items: [], settings: { mode: "auto", adjustable: false }, canReply: true, canArchive: true,
    canStop: false, canRetry: false, unread: false, needsAttention: false, attention: { state: "not_needed" } };
}

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`independent archive failure survives chat and can be dismissed ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install();
    const a = row("archive-feedback");
    let turn = stamp; let output = "原有正文"; let sends = 0;
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "PATCH") return route.fulfill({ status: 503, json: { code: "request_failed", title: "Archive rejected" } });
      if (path.endsWith("/commands")) { sends++; turn = new Date().toISOString(); return route.fulfill({ status: 201,
        json: { id: "next", kind: "message", status: "delivered", text: "继续", createdAt: turn } }); }
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a] } : { ...a, messages: [{ id: "output", role: "agent", text: output, occurredAt: turn }],
        turnState: { turnStartedAt: turn, turnActive: false }, canResolveDelivery: false } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${a.id}`);
    await page.locator(".agent-console-conversation").getByRole("button", { name: "归档", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /确认|归档/ }).click();
    const error = page.getByLabel("会话操作反馈").locator("[role=alert]");
    await expect(error).toContainText("归档／恢复会话");
    output = "同轮继续输出";
    await advanceSessionDetailPoll(page);
    await expect(error).toBeVisible();
    await page.locator(".agent-console-reply textarea").fill("继续");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sends).toBe(1);
    await advanceSessionDetailPoll(page);
    await expect(error).toBeVisible();
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; }, scale);
      const close = error.getByRole("button", { name: "关闭反馈：归档／恢复会话" });
      await expect(close).toBeVisible();
      expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await error.locator("summary").click();
    await expect(error).toContainText("Archive rejected");
    expect((await error.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`operation-feedback-${width}-${theme}.png`) });
    await error.getByRole("button", { name: "关闭反馈：归档／恢复会话" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toBeFocused();
    await expect(error).toHaveCount(0);
    await advanceSessionDetailPoll(page);
    await expect(error).toHaveCount(0);
  });
}

test("stale approval retry becomes neutral and delayed reads cannot revive it", async ({ page }) => {
  await page.clock.install();
  const a = row("approval-feedback");
  let approval: object | undefined = { id: "denial", kind: "auto", status: "denied", action: "Fixture denied action", turnId: "turn", startedAtMs: 1 };
  const original = approval; let retries = 0;
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/retry")) { retries++; approval = undefined; return route.fulfill({ status: 409,
      json: { code: "approval_retry_unavailable", title: "Only a current automatic-review denial can be retried." } }); }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a] } : { ...a, approval, messages: [], canResolveDelivery: false } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${a.id}`);
  await page.getByRole("button", { name: "发起人工审批重试", exact: true }).dblclick();
  const feedback = page.getByLabel("会话操作反馈");
  await expect(feedback).toContainText("旧结果已不适用");
  await expect(feedback.locator("[role=alert]")).toHaveCount(0);
  expect(retries).toBe(1);
  approval = original;
  await advanceSessionDetailPoll(page);
  await expect(feedback).toContainText("旧结果已不适用");
  await expect(feedback.locator("[role=alert]")).toHaveCount(0);
  await feedback.getByRole("button", { name: "关闭反馈：发起人工审批重试" }).click();
  await advanceSessionDetailPoll(page);
  await expect(feedback).not.toContainText("旧结果已不适用");
});

test("failed retry delivery gives a verification path and never sends again", async ({ page }) => {
  const a = row("unknown-retry"); let retries = 0;
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/retry")) retries++;
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a] } : { ...a, messages: [], approval: {
      id: "denial", kind: "auto", status: "denied", action: "Denied action", turnId: "turn", startedAtMs: 1,
      retryId: "retry", retryStatus: "failed", retryError: "Fixture unconfirmed delivery",
    } } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${a.id}`);
  await expect(page.locator(".agent-console-approval")).toContainText("请在原 Codex 会话核实");
  await expect(page.getByRole("button", { name: "发起人工审批重试", exact: true })).toBeDisabled();
  expect(retries).toBe(0);
});

test("late settings failure cannot leak into the next conversation or block its controls", async ({ page }) => {
  const a = { ...row("Settings A"), nodeId: "node", settings: { mode: "auto", model: "first", adjustable: true } };
  const b = { ...a, id: "Settings B", agentSessionId: "Settings B", sessionName: "Settings B" };
  let release!: () => void; let started = false;
  await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: "node", agents: [{ kind: "codex",
    models: [{ id: "first", label: "First", efforts: [] }, { id: "second", label: "Second", efforts: [] }] }] }] } }));
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path.endsWith("/settings")) {
      started = true; await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: 503, json: { code: "request_failed", title: "Settings A failed" } });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [a, b] }
      : { ...(path.includes(a.id) ? a : b), messages: [], canResolveDelivery: false } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${encodeURIComponent(a.id)}`);
  await chooseOption(page.locator(".agent-session-quick-settings").getByRole("combobox", { name: "模型", exact: true }), "second");
  await expect.poll(() => started).toBe(true);
  await page.locator(".agent-console-session").filter({ hasText: b.sessionName }).click();
  await page.locator(".agent-console-reply textarea").fill("B的草稿");
  release();
  const settings = page.locator(".agent-session-quick-settings");
  await expect(settings.locator(".error")).toHaveCount(0);
  await expect(settings.getByRole("combobox", { name: "模型", exact: true })).toBeEnabled();
  await expect(page.locator(".agent-console-reply textarea")).toHaveValue("B的草稿");
  await page.locator(".agent-console-session").filter({ hasText: a.sessionName }).click();
  await expect(settings.getByRole("combobox", { name: "模型", exact: true })).toBeEnabled();
  await expect(settings.locator(".error")).toContainText("服务端暂时无法完成");
  await settings.locator(".error").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings.locator(".error")).toHaveCount(0);
});
