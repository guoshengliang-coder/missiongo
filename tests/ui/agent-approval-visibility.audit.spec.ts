import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8",
)) as { productId: string; detailKey: string };
const id = "and-272-approval-fixture";
const now = "2026-09-30T09:00:00.000Z";
const summary = {
  id, agentSessionId: id, dispatchId: "and-272-dispatch", agentKind: "codex",
  status: "active", updatedAt: now, activityAt: now, nodeName: "Fixture",
  nodeConnectionState: "online", nodeRevoked: false, mode: "auto",
  dispatchStatus: "in_progress", createdAt: now, nodeId: "and-272-node",
  items: [{ key: "AND-272", title: "授权提示块显示", productId: fixture.productId }],
  activities: [], settings: {}, unread: false, canReply: true, canRetry: false,
  canStop: true, canArchive: true, attention: { state: "not_needed" },
  needsAttention: false, waitingForReply: false,
};
const approval = {
  id: "review", kind: "auto", status: "inProgress", turnId: "turn",
  action: "Fixture permission request", startedAtMs: 1,
};

test("only shows Codex authorization when a person must intervene", async ({ page }, testInfo) => {
  let current: Record<string, unknown> | undefined = approval;
  // Keep a stale denial in the list throughout: the detail response must be
  // authoritative when the request completes or disappears.
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ status: 204 });
    const body = new URL(request.url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [{ ...summary, approval: { ...approval, status: "denied" } }] }
      : { ...summary, messages: [], ...(current ? { approval: current } : {}) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const panel = page.locator(".agent-console-approval");
  const open = async () => {
    await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
    await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  };
  for (const value of [
    approval, { ...approval, status: "approved" }, undefined,
    { ...approval, status: "denied", retryId: "retry", retryStatus: "queued" },
    { ...approval, status: "denied", retryId: "retry", retryStatus: "restored" },
  ]) {
    current = value;
    await open();
    await expect(panel).toHaveCount(0);
  }
  current = { ...approval, kind: "manual", status: "pending" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button")).toHaveCount(2);
  current = { ...approval, kind: "manual", status: "pending", decision: "accept" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button").first()).toBeDisabled();
  current = { ...approval, kind: "manual", status: "unavailable", reason: "授权连接重连中，旧决定已失效" };
  await open();
  await expect(panel).toContainText("授权连接重连中，旧决定已失效");
  await expect(panel.locator("button")).toHaveCount(0);
  current = { ...approval, status: "denied" };
  await open();
  await expect(panel).toBeVisible();
  await expect(panel.locator("button")).toBeEnabled();
  current = { ...approval, status: "denied", retryId: "retry", retryStatus: "failed", retryError: "Fixture retry failed" };
  await open();
  await expect(panel).toContainText("Fixture retry failed");
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const viewport of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }]) {
    // Crossing the console layout breakpoint changes browser history. Resize
    // outside the app so its pending history.back cannot race the next link.
    await page.goto("about:blank");
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      current = { ...approval, status: "approved" };
      await open();
      await expect(panel).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const name = viewport.name + "-" + theme;
      const path = testInfo.outputPath(name + ".png");
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
  }
});

test("Simulator approval stays visible through delivery and clears after source resolution", async ({ page }, testInfo) => {
  let current = { ...approval, kind: "manual", status: "pending", decision: undefined as string | undefined,
    requestKind: "permission",
    action: 'cua_repl：Allow Computer Use to use "Simulator"?', reason: "仅回复这一次请求，不授予会话或永久权限。" };
  const decisions: unknown[] = [];
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    if (route.request().method() === "POST") {
      decisions.push(route.request().postDataJSON());
      current = { ...current, decision: "accept" };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ approval: current }) });
    }
    const session = { ...summary, turnState: { turnActive: true, waitingForInput: current.status === "pending" },
      attention: { state: "needed", kind: "approval" }, needsAttention: true, approval: current };
    const body = new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [session] } : { ...session, messages: [] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  for (const viewport of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }]) {
    await page.goto("about:blank");
    await page.setViewportSize(viewport);
    current = { ...current, status: "pending", decision: undefined };
    await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
    const panel = page.locator(".agent-console-approval");
    await expect(panel).toContainText('Simulator');
    await expect(panel.locator("button").first()).toBeEnabled();
    await expect(page.locator(".agent-console-activity")).toContainText(/等待审批|awaiting approval/);
    const screenshot = testInfo.outputPath(viewport.name + "-simulator-approval.png");
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await testInfo.attach(viewport.name, { path: screenshot, contentType: "image/png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.locator("button").first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator("button").first()).toBeDisabled();
    await expect(panel).toContainText(/Decision queued|决定.*Mac/);
    current = { ...current, status: "resolved" };
    await advanceSessionDetailPoll(page);
    await expect(panel).toHaveCount(0, { timeout: 10_000 });
  }
  expect(decisions).toEqual([{ decision: "accept" }, { decision: "accept" }]);
});

test("native authorization scopes survive navigation and reconnect with a fresh request", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 353, height: 757 });
  let current = { ...approval, id: "scope-1", kind: "manual", status: "pending", decision: undefined as string | undefined,
    options: [{ id: "accept", kind: "once" }, { id: "acceptForSession", kind: "session" },
      { id: "execpolicy-2", kind: "rule", detail: '"git" "status"' }, { id: "decline", kind: "decline" }] };
  const decisions: unknown[] = [];
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    if (route.request().method() === "POST") {
      const decision = route.request().postDataJSON() as { decision: string };
      decisions.push(decision);
      current = { ...current, decision: decision.decision };
      return route.fulfill({ json: { approval: current } });
    }
    const session = { ...summary, approval: current };
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [session] } : { ...session, messages: [] } });
  });
  const open = () => page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
  const panel = page.locator(".agent-console-approval");
  await open();
  await expect(panel.locator("button")).toHaveCount(4);
  await expect(panel).toContainText('"git" "status"');
  await page.goto("about:blank"); // phone can leave and return without deciding
  await open();
  await expect(panel.getByRole("button", { name: /本会话内允许|Allow for this session/ })).toBeEnabled();
  current = { ...current, status: "reconnecting" };
  await advanceSessionDetailPoll(page);
  await expect(panel).toContainText(/正在重新连接|Reconnecting/);
  await expect(panel.locator("button")).toHaveCount(0);
  current = { ...current, id: "scope-2", status: "pending" };
  await advanceSessionDetailPoll(page);
  await expect(panel.locator("button")).toHaveCount(4);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`native-scopes-${theme}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(theme, { path, contentType: "image/png" });
  }
  await panel.getByRole("button", { name: /本会话内允许|Allow for this session/ }).dblclick();
  await expect(panel.locator("button").first()).toBeDisabled();
  expect(decisions).toEqual([{ decision: "acceptForSession" }]);
  current = { ...current, id: "scope-3", decision: undefined,
    options: [{ id: "accept", kind: "once" }, { id: "decline", kind: "decline" }] };
  await advanceSessionDetailPoll(page);
  await expect(panel.locator("button")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /本会话内允许|Allow for this session/ })).toHaveCount(0);
});

for (const scope of ["acceptForSession", "acceptAlways", "choice-2"]) {
  test(`MCP authorization exposes native lifetimes and submits ${scope}`, async ({ page }, testInfo) => {
    const offered = [
      { id: "accept", kind: "once" }, { id: "acceptForSession", kind: "session" },
      { id: "acceptAlways", kind: "always" },
      { id: "choice-2", kind: "choice", label: "Always allow this app", detail: "Remember Chrome access" },
      { id: "decline", kind: "decline" },
    ];
    let current = { ...approval, id: "mcp-scope", kind: "manual", status: "pending",
      action: 'cua_repl: Allow Computer Use to use "Chrome"?', options: offered, decision: undefined as string | undefined };
    const decisions: unknown[] = [];
    await page.route("**/api/v1/agent-sessions**", async route => {
      if (route.request().method() === "POST") {
        const decision = route.request().postDataJSON() as { decision: string };
        decisions.push(decision);
        current = { ...current, decision: decision.decision };
        return route.fulfill({ json: { approval: current } });
      }
      const session = { ...summary, approval: current };
      return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
        ? { sessions: [session] } : { ...session, messages: [] } });
    });
    const panel = page.locator(".agent-console-approval");
    for (const width of [375, 1440]) {
      await page.goto("about:blank");
      await page.setViewportSize({ width, height: 850 });
      await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
      await expect(panel.locator("button")).toHaveCount(5);
      await expect(panel.getByRole("button", { name: /本会话内允许|Allow for this session/ })).toBeEnabled();
      await expect(panel.getByRole("button", { name: /^(始终允许|Always allow)$/ })).toBeEnabled();
      await expect(panel.getByRole("button", { name: "Always allow this app", exact: true })).toBeEnabled();
      expect(decisions).toEqual([]); // Rendering or navigating must never choose a scope.
      await panel.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const path = testInfo.outputPath(`mcp-scopes-${scope}-${width}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(String(width), { path, contentType: "image/png" });
    }
    await panel.locator("button").nth(offered.findIndex(option => option.id === scope)).click();
    await expect(panel.locator("button").first()).toBeDisabled();
    expect(decisions).toEqual([{ decision: scope }]);
  });
}

test("Claude authorization shows rule scope and sends the selected lifetime as its native answer", async ({ page }, testInfo) => {
  const selected = "始终允许（当前项目本机设置，建议 1）";
  const answer = "授权请求 fixture: " + selected;
  const sent: unknown[] = [];
  const session = { ...summary, agentKind: "claude_code", messages: [{ id: "permission-fixture", sourceId: "permission-fixture", role: "agent",
    text: "Inspect the current working tree", questions: [{ header: "授权请求", title: "Claude Code 请求使用 Bash", key: "授权请求 fixture",
      detail: '将记住规则 Bash(git status *)，保存到当前项目本机设置。',
      options: ["批准", "本会话内允许（本会话，建议 1）", selected, "拒绝"] }] }] };
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() === "POST") {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { command: { id: "answer", status: "queued" } } });
    }
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [session] } : session });
  });
  await page.setViewportSize({ width: 375, height: 850 });
  await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
  const rule = page.locator(".agent-session-question-detail").filter({ hasText: "将记住规则 Bash(git status *)" });
  await page.locator(".agent-session-question summary").first().click();
  await expect(rule).toBeVisible();
  await page.getByRole("button", { name: selected, exact: true }).click();
  await expect(page.locator(".agent-console-reply textarea")).toHaveValue("");
  await expect.poll(() => sent.length).toBe(1); // A permission decision submits immediately.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const path = testInfo.outputPath("claude-rule-scopes-phone.png");
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach("claude", { path, contentType: "image/png" });
  expect(sent[0]).toMatchObject({ text: answer });
});

for (const viewport of [
  { width: 320, height: 568, touch: true, surface: "console" },
  { width: 812, height: 375, touch: true, surface: "console" },
  { width: 1440, height: 900, touch: false, surface: "console" },
  { width: 320, height: 568, touch: true, surface: "panel" },
  { width: 1440, height: 900, touch: false, surface: "panel" },
]) for (const theme of ["light", "dark"] as const) {
  test.describe(`Claude MCP confirmation ${viewport.surface} ${viewport.width} ${theme}`, () => {
    test.use({ viewport, hasTouch: viewport.touch, colorScheme: theme });
    test("shows the exact request while waiting and submits only the selected request-bound answer", async ({ page }, testInfo) => {
      const sent: unknown[] = [];
      const plan = "确认当前方案与验证目标。\n" + "Review the exact plan, scope and validation goals. ".repeat(36);
      const question = { header: "授权请求", title: "MCP 服务 fixture 请求确认", key: "授权请求 mcp-confirm-1",
        detail: plan, options: ["批准", "拒绝", "取消"] };
      let answered: string | undefined;
      await page.route("**/api/v1/agent-sessions**", async route => {
        if (route.request().method() === "POST") {
          sent.push(route.request().postDataJSON());
          answered = "取消";
          return route.fulfill({ json: { command: { id: "answer", status: "delivered" } } });
        }
        const session = { ...summary, agentKind: "claude_code", status: "idle",
          items: [{ key: fixture.detailKey, title: "MCP confirmation fixture", productId: fixture.productId }],
          turnState: { turnActive: answered === undefined, waitingForInput: answered === undefined },
          attention: answered ? { state: "not_needed" } : { state: "needed", kind: "question" },
          needsAttention: answered === undefined, waitingForReply: answered === undefined,
          messages: [{ id: "form", sourceId: "permission-mcp-confirm-1", role: "agent", text: plan,
            questions: [{ ...question, ...(answered ? { answered } : {}) }] }] };
        return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [session] } : session });
      });
      if (viewport.surface === "console") await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
      else {
        await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{
          id: summary.dispatchId, agentSessionId: id, agentKind: "claude_code", mode: "plan", nodeName: "Fixture", status: "launched", createdAt: now, itemKeys: [fixture.detailKey],
        }] } }));
        await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
        await page.locator(".execution-history > summary").click();
        await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
        await page.locator(".agent-session-toggle").click();
      }
      const reply = page.locator(viewport.surface === "console" ? ".agent-console-reply" : ".agent-session-reply");
      const card = page.locator(".agent-session-question");
      await expect(card.getByText(question.title, { exact: true })).toBeVisible();
      await expect(card.locator(".agent-session-question-detail")).toHaveText(plan);
      if (viewport.surface === "console") await expect(page.locator(".agent-console-activity")).toContainText(/等待|awaiting/);
      expect(sent).toEqual([]);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => {
          document.documentElement.dataset.fontScale = value;
          document.documentElement.dataset.consoleFontScale = value;
        }, scale);
        for (const button of await card.getByRole("button").all()) {
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport();
          const metrics = await button.evaluate(element => ({ height: element.getBoundingClientRect().height,
            font: parseFloat(getComputedStyle(element).fontSize), overflow: element.scrollWidth > element.clientWidth }));
          expect(metrics.font).toBeGreaterThanOrEqual(11);
          if (viewport.touch) expect(metrics.height).toBeGreaterThanOrEqual(44);
          expect(metrics.overflow).toBe(false);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      const path = testInfo.outputPath("claude-mcp-confirmation.png");
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach("confirmation", { path, contentType: "image/png" });
      await card.getByRole("button", { name: "取消", exact: true }).click();
      await expect(reply.locator("textarea")).toHaveValue("");
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ text: "授权请求 mcp-confirm-1: 取消" });
      await expect(card.getByRole("button", { name: "批准", exact: true })).toBeDisabled();
    });
  });
}

test("AND-408 renders a question as a question instead of a permission request", async ({ page }, testInfo) => {
  const question = {
    id: "question", kind: "manual", status: "pending", turnId: "turn",
    action: "选择产品偏好", startedAtMs: 1, requestKind: "question",
    options: [{ id: "choice-0", kind: "choice", label: "方案 A" }, { id: "choice-1", kind: "choice", label: "方案 B" }],
  };
  const attention = { state: "needed", kind: "answer", reason: "Codex 正在等待回答。" };
  const decisions: unknown[] = [];
  let current: Record<string, unknown> | undefined = question;
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      if (path.endsWith("/decision")) {
        decisions.push(request.postDataJSON());
        current = { ...question, decision: (request.postDataJSON() as { decision: string }).decision };
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ approval: current }) });
      }
      return route.fulfill({ status: 204 });
    }
    const detail = { ...summary, messages: [], needsAttention: true, waitingForReply: true,
      attention, ...(current ? { approval: current } : {}) };
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [detail] } : detail) });
  });
  const open = async () => {
    await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
    await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  };
  await open();
  const panel = page.locator(".agent-console-approval");
  await expect(panel).toBeVisible();
  await expect(panel.locator("strong")).toHaveText("Codex 提问");
  await expect(panel).toContainText("等待你回答");
  await expect(panel).not.toContainText("权限");
  // A question has no default answer: no primary action, only its choices.
  await expect(panel.locator(".primary-button")).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "方案 A", exact: true })).toBeEnabled();
  await expect(page.locator("i.agent-console-attention").first()).toHaveText("待回答");
  await panel.getByRole("button", { name: "方案 A", exact: true }).click();
  await expect(panel.getByRole("button").first()).toBeDisabled();
  expect(decisions).toEqual([{ decision: "choice-0" }]);
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const viewport of [{ width: 375, height: 812, name: "phone" }, { width: 1440, height: 900, name: "desktop" }]) {
    await page.goto("about:blank");
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await open();
      await expect(panel).toBeVisible();
      await expect(panel.locator("strong")).toHaveText("Codex 提问");
      const screenshot = testInfo.outputPath(`${viewport.name}-question-${theme}.png`);
      await panel.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach(`${viewport.name}-${theme}`, { path: screenshot, contentType: "image/png" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test("AND-408 keeps legacy prompts without requestKind on neutral copy", async ({ page }) => {
  const legacy = { ...approval, kind: "manual", status: "pending" };
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ status: 204 });
    const detail = { ...summary, messages: [], approval: legacy, needsAttention: true,
      waitingForReply: true, attention: { state: "needed", kind: "approval", reason: "Codex 正在等待处理。" } };
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(new URL(request.url()).pathname === "/api/v1/agent-sessions"
        ? { sessions: [detail] } : detail) });
  });
  await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  const panel = page.locator(".agent-console-approval");
  await expect(panel).toBeVisible();
  await expect(panel.locator("strong")).toHaveText("Codex 请求");
  await expect(page.locator("i.agent-console-attention").first()).toHaveText("待处理");
});

for (const choice of ["批准", "取消"]) test(`AND-443 OpenCode empty confirmation binds ${choice} to its source request`, async ({ page }) => {
  const sent: unknown[] = [];
  const detail = "协作请求 · 当前版本 3\n仅提交本次草稿；不启动接收方 Agent，不授权合并或发布。";
  const question = { title: "确认此请求", key: "确认请求 form-443", options: ["批准", "取消"] };
  const session = { ...summary, agentKind: "opencode", status: "idle", waitingForReply: true,
    messages: [{ id: "native-form", sourceId: "form-443", role: "agent", text: detail, questions: [question] }] };
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (route.request().method() === "POST") {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { command: { id: "answer", status: "delivered" } } });
    }
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [session] } : session });
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/?product=' + fixture.productId + '&console=agent&session=' + id);
  const card = page.locator(".agent-session-question");
  await expect(page.locator("body")).toContainText(detail);
  await expect(card).toContainText("确认此请求");
  expect(sent).toEqual([]);
  await card.getByRole("button", { name: choice, exact: true }).click();
  const reply = page.locator(".agent-console-reply");
  await expect(reply.locator("textarea")).toHaveValue(`确认请求 form-443: ${choice}`);
  expect(sent).toEqual([]);
  await reply.locator('button[type="submit"]').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ text: `确认请求 form-443: ${choice}` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
