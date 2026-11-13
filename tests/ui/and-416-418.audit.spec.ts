import { refreshFromConsoleStream } from "./polling";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const now = "2026-11-06T01:00:00.000Z";
function session(kind = "claude_code") {
  return { id: "batch-session", agentSessionId: "batch-session", dispatchId: "batch-dispatch", agentKind: kind,
    status: "idle", mode: "auto", dispatchStatus: "launched", productId: fixture.productId,
    createdAt: now, updatedAt: now, activityAt: now, sessionName: "本批验收会话", items: [], nodeName: "Fixture",
    nodeRevoked: false, nodeConnectionState: "online", activities: [], settings: { adjustable: false },
    canReply: true, canAttach: true, canRetry: false, canStop: false, canArchive: true, unread: false,
    turnState: { turnActive: false, waitingForInput: true }, needsAttention: true, waitingForPermission: true,
    attention: { state: "needed", kind: "answer", revision: "request", reason: "等待回答" } };
}
test.beforeEach(async ({ page }) => {
  await page.route("**/release-status.json*", route => route.fulfill({ json: { version: 1, phase: "idle", expiresAt: 0, release: "fixture" } }));
});
for (const kind of ["claude_code", "opencode", "claude-legacy"]) for (const surface of ["console", "panel"]) for (const width of [375, 1440]) {
  test.describe(`${kind} ${surface} ${width}`, () => {
    test.use({ viewport: { width, height: 850 }, hasTouch: width === 375, colorScheme: width === 375 ? "dark" : "light" });
    test("permission clicks submit exactly once, preserve drafts and retry failures", async ({ page }, info) => {
      const row = session(kind === "claude-legacy" ? "claude_code" : kind);
      let answered: string | undefined;
      const sent: { text: string }[] = [];
      await page.route("**/api/v1/agent-sessions**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/read")) return route.fulfill({ status: 204 });
        if (path.endsWith("/commands")) {
          sent.push(route.request().postDataJSON());
          if (sent.length === 1) return route.fulfill({ status: 500, json: { code: "fixture_failure" } });
          answered = "批准";
          return route.fulfill({ status: 201, json: { id: "answer", kind: "message", status: "queued", text: sent.at(-1)!.text, createdAt: now } });
        }
        const message = { id: "permission-req1", sourceId: "permission-req1", role: "agent", text: "请求使用工具", occurredAt: now,
          questions: [{ header: "授权请求", title: "确认工具权限", ...(kind !== "claude-legacy" ? { key: "授权请求 req1" } : {}),
            options: ["批准", "拒绝"], detail: "规则及保存位置原样保留", ...(answered ? { answered } : {}) }] };
        return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [message] } });
      });
      if (surface === "console") await page.goto(`/?product=${fixture.productId}&console=agent&session=${row.id}`);
      else {
        await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: row.dispatchId,
          agentSessionId: row.id, agentKind: row.agentKind, mode: "auto", nodeName: "Fixture", status: "launched", createdAt: now, itemKeys: [fixture.detailKey] }] } }));
        await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
        await page.locator(".execution-history > summary").click();
        await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
        await page.locator(".agent-session-toggle").click();
      }
      const reply = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
      await reply.fill("保留我的草稿");
      const card = page.locator(".agent-session-question");
      await expect(card).toContainText("等待授权");
      await expect(page.getByRole("button", { name: "无需处理", exact: true })).toHaveCount(0);
      await card.locator("summary").click();
      await expect(card).toContainText("规则及保存位置原样保留");
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; document.documentElement.dataset.consoleFontScale = value; }, scale);
        await expect(card.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
        const bounds = await card.getByRole("button", { name: "批准", exact: true }).boundingBox();
        if (width === 375) expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await card.getByRole("button", { name: "批准", exact: true }).click();
      await expect(card.getByRole("alert")).toBeVisible();
      await expect(card.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
      await expect(reply).toHaveValue("保留我的草稿");
      await card.getByRole("button", { name: "批准", exact: true }).dblclick();
      await expect(card.getByRole("button", { name: "批准", exact: true })).toBeDisabled();
      expect(sent).toEqual([{ text: "授权请求 req1: 批准" }, { text: "授权请求 req1: 批准" }]);
      await expect(reply).toHaveValue("保留我的草稿");
      await expect(card.getByText("已选择，未发送", { exact: true })).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("permission.png"), animations: "disabled" });
    });
  });
}
for (const width of [320, 1440]) test(`archive and restore stay readable without unavailable errors ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const row = { ...session("codex"), turnState: {}, needsAttention: false, archivedAt: undefined as string | undefined };
  await page.route("**/api/v1/agent-sessions**", route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "PATCH") row.archivedAt = request.postDataJSON().archived ? now : undefined;
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] }
      : { ...row, messages: [{ id: "text", sourceId: "text", role: "agent", text: "归档仍可查看的会话正文", occurredAt: now }] } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${row.id}`);
  await page.locator(".agent-console-conversation").getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /确认|归档/ }).click();
  await expect(page.locator(".agent-console-conversation")).toContainText("归档仍可查看的会话正文");
  await expect(page.locator(".agent-console-conversation [role=alert]")).toHaveCount(0);
  await page.locator(".agent-console-conversation").getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  await expect(page.locator(".agent-console-conversation [role=alert]")).toHaveCount(0);
  row.archivedAt = now;
  await page.reload();
  await expect(page.locator(".agent-console-conversation")).toContainText("归档仍可查看的会话正文");
  await expect(page.locator(".agent-console-conversation [role=alert]")).toHaveCount(0);
});
for (const phase of ["idle", "failed", "expired"]) test(`upgrade retains draft and recovers without replay: ${phase}`, async ({ page }, info) => {
  const row = { ...session("codex"), turnState: {}, needsAttention: false };
  let current = "idle";
  let writes = 0;
  await page.route("**/release-status.json*", route => route.fulfill({ json: { version: 1,
    phase: current === "expired" ? "upgrading" : current, expiresAt: current === "expired" ? Date.parse("2026-11-09T01:00:00.000Z") - 1 : Date.parse("2026-11-09T01:00:00.000Z") + 600_000, release: "deploy-1" } }));
  await page.route("**/api/v1/agent-sessions**", route => {
    if (route.request().method() === "POST") { writes++; return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [] } });
  });
  await page.clock.install({ time: new Date("2026-11-09T01:00:00.000Z") });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${row.id}`);
  await page.locator(".agent-console-reply textarea").fill("升级期间保留草稿");
  current = "upgrading";
  await refreshFromConsoleStream(page);
  await page.clock.runFor(5100);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("正在发布新版本");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath("upgrading.png"), animations: "disabled" });
  current = phase;
  await refreshFromConsoleStream(page);
  await page.clock.runFor(5100);
  if (phase === "idle") await expect(dialog).toHaveCount(0);
  else { await expect(dialog).toContainText(phase === "failed" ? "服务更新未通过检查" : "升级尚未确认恢复"); await dialog.getByRole("button", { name: "关闭", exact: true }).click(); }
  await expect(page.locator(".agent-console-reply textarea")).toHaveValue("升级期间保留草稿");
  expect(writes).toBe(0);
});

test("truly missing conversation still reports access failure and a valid selection clears it", async ({ page }) => {
  const row = { ...session("codex"), needsAttention: false, turnState: {} };
  await page.route("**/api/v1/agent-sessions**", route => route.fulfill(new URL(route.request().url()).pathname.endsWith("/unavailable")
    ? { status: 404, json: { code: "not_found" } }
    : { json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [] } }));
  await page.goto(`/?product=${fixture.productId}&console=agent&session=unavailable`);
  await expect(page.locator(".agent-console-conversation [role=alert]")).toContainText("该会话已失效");
  await page.locator(".agent-console-session").first().click();
  await expect(page.locator(".agent-console-conversation [role=alert]")).toHaveCount(0);
});

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`review ${width} ${theme}`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : 900 }, colorScheme: theme, hasTouch: width === 375 });
    test("permission and upgrade surfaces preserve focus, touch size and content", async ({ page }, info) => {
      const row = session("opencode");
      let phase = "idle";
      await page.route("**/release-status.json*", route => route.fulfill({ json: { version: 1, phase, expiresAt: Date.parse("2026-11-09T01:00:00.000Z") + 600_000, release: "review" } }));
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
        ? { sessions: [row] } : { ...row, messages: [{ id: "permission-review", sourceId: "permission-review", role: "agent", occurredAt: now,
          text: "OpenCode 请求使用工具", questions: [{ key: "授权请求 review", title: "请求读取项目文件", detail: "只允许本次读取；原授权范围不变。", options: ["允许一次", "拒绝"] }] }] } }));
      await page.clock.install({ time: new Date("2026-11-09T01:00:00.000Z") });
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${row.id}`);
      const card = page.locator(".agent-session-question");
      await expect(card).toBeVisible();
      await card.locator("summary").click();
      await page.locator(".agent-console-reply textarea").fill("保留未发送内容");
      await card.scrollIntoViewIfNeeded();
      let path = info.outputPath(`permission-${width}-${theme}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await info.attach("permission", { path, contentType: "image/png" });
      phase = "upgrading";
      await refreshFromConsoleStream(page);
      await page.clock.runFor(5100);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("正在发布新版本");
      await page.keyboard.press("Escape");
      await expect(dialog).not.toContainText("正在保存修改");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      path = info.outputPath(`upgrade-${width}-${theme}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await info.attach("upgrade", { path, contentType: "image/png" });
      phase = "idle";
      await refreshFromConsoleStream(page);
      await page.clock.runFor(5100);
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".agent-console-reply textarea")).toHaveValue("保留未发送内容");
    });
  });
}
for (const initial of ["upgrading", "unknown", "expired"]) test(`host first-load fallback distinguishes ${initial}`, async ({ page }) => {
  const directory = new URL("../../deploy/release-status/", import.meta.url);
  let phase: string = initial;
  let loads = 0;
  await page.route("**/release-fallback-fixture", route => { loads++; return route.fulfill({ status: 503, contentType: "text/html", body: readFileSync(new URL("wait.html", directory), "utf8") }); });
  for (const file of ["wait.js", "wait.css"]) await page.route(`**/release-wait/${file}`, route => route.fulfill({ contentType: file.endsWith("js") ? "application/javascript" : "text/css", body: readFileSync(new URL(file, directory), "utf8") }));
  await page.route("**/release-status.json*", route => route.fulfill({ json: { version: 1, phase: phase === "expired" ? "upgrading" : phase,
    expiresAt: phase === "expired" ? Date.parse("2026-11-09T01:00:00.000Z") - 1 : Date.parse("2026-11-09T01:00:00.000Z") + 600_000, release: "fallback" } }));
  await page.route("**/health", route => route.fulfill({ json: { status: "ok", release: "fallback" } }));
  await page.clock.install({ time: new Date("2026-11-09T01:00:00.000Z") });
  await page.goto("/release-fallback-fixture");
  if (initial === "upgrading") {
    await expect(page.getByRole("heading")).toHaveText(/正在发布新版本|A new version is being deployed/);
    await expect(page.getByRole("button")).toBeDisabled();
    phase = "idle";
    await page.clock.runFor(3100);
    await expect.poll(() => loads).toBe(2);
  } else {
    await expect(page.getByRole("heading")).toHaveText(initial === "expired" ? /升级尚未确认恢复|Update recovery is unconfirmed/ : /暂时无法获取服务状态|Service status unavailable/);
    await expect(page.getByRole("button")).toBeEnabled();
    expect(loads).toBe(1);
  }
});
