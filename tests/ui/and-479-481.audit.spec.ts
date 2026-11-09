import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-09T01:00:00.000Z";
test.use({ locale: "zh-CN" });
const id = "and481-return";
async function session(page: Page) {
  await page.clock.setFixedTime(new Date(stamp));
  const summary = { id, agentSessionId: id, dispatchId: "and481", agentKind: "codex", status: "active", mode: "auto",
    dispatchStatus: "launched", nodeName: "Fixture", nodeId: "fixture", nodeConnectionState: "online", nodeRevoked: false,
    items: [{ key: fixture.detailKey, productId: fixture.productId, title: "来源返回" }], createdAt: stamp, updatedAt: stamp, activityAt: stamp,
    canReply: true, canRetry: false, canStop: true, canArchive: true, settings: {}, unread: false, activities: [],
    turnState: { turnActive: true }, attention: { state: "not_needed" }, needsAttention: false };
  await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary, messages: [] } }));
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "and481", agentSessionId: id, agentKind: "codex", nodeName: "Fixture", mode: "auto", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
  }] } }));
}
for (const width of [375, 1440]) test(`item-origin return survives resize, reload, Back and forward: ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await session(page);
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  const jump = page.locator(".detail-dispatch-line").getByRole("button", { name: "在控制台查看", exact: true });
  await jump.click();
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  await page.locator(".agent-console-reply textarea").fill("返回保留草稿");
  await page.setViewportSize({ width: width === 375 ? 1440 : 375, height: 900 });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole("button", { name: "返回条目详情", exact: true }).click();
  await expect(jump).toBeVisible();
  await expect(jump).toBeFocused();
  await expect(page).not.toHaveURL(/console=agent/);
  await page.goForward();
  await expect(page.locator(".agent-console-reply textarea")).toHaveValue("返回保留草稿");
  await page.reload();
  await expect(page.getByRole("button", { name: "返回条目详情", exact: true })).toBeVisible();
  await page.goBack();
  await expect(jump).toBeVisible();
});
test("list-origin conversation keeps its list back level", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 }); await session(page);
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await expect(page.locator(".agent-console-session-row")).toHaveCount(1);
  await page.locator(".agent-console-session").click();
  await page.goBack();
  await expect(page.locator(".agent-console-session-row")).toHaveCount(1);
});
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) test.describe(`${width} ${theme}`, () => {
  test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 320 });
  test("failure diagnostics, explicit recheck feedback and recovery preserve draft", async ({ page }, info) => {
    await session(page);
    let phase = "idle", offline = false, delayed = false;
    let complete!: () => void;
    await page.route("**/release-status.json*", async route => {
      if (delayed) await new Promise<void>(resolve => { complete = resolve; });
      if (offline) return route.abort("connectionfailed");
      return route.fulfill({ json: { version: 1, phase, expiresAt: Date.parse(stamp) + 600_000, release: "test-release",
        failure: { stage: "health", reason: "health_timeout", occurredAt: Date.parse(stamp), rawLog: "DO_NOT_DISPLAY" } } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    await page.locator(".agent-console-reply textarea").fill("异常时保留草稿");
    phase = "failed";
    await page.evaluate(async () => {
      // @ts-expect-error Served by the local Vite fixture.
      await (await import("/src/release-status.ts")).checkReleaseStatus();
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("服务更新未通过检查");
    await expect(dialog).toContainText("服务健康检查超时");
    await expect(dialog).not.toContainText("DO_NOT_DISPLAY");
    await expect(dialog).toContainText("仅保留在当前页面");
    delayed = true;
    await dialog.getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(dialog).toContainText("正在检查服务状态");
    await expect(dialog.getByRole("button", { name: "重新检查", exact: true })).toBeDisabled();
    offline = true; delayed = false; complete();
    await expect(dialog).toContainText("暂时无法读取服务状态");
    offline = false;
    await dialog.getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(dialog).toContainText("尚未确认服务恢复，请稍后重新检查");
    await page.screenshot({ path: info.outputPath("release-failure.png") });
    phase = "idle";
    await dialog.getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/服务 API 已恢复/)).toBeInViewport();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue("异常时保留草稿");
  });
});
test("host fallback rechecks without reload, hides unknown reasons and verifies recovery version", async ({ page }) => {
  const directory = new URL("../../deploy/release-status/", import.meta.url);
  let loads = 0, phase = "failed", reason = "health_timeout", release = "old";
  const now = Date.parse(stamp);
  await page.clock.setFixedTime(new Date(stamp));
  await page.route("**/and479-fallback", route => { loads++; return route.fulfill({ contentType: "text/html", body: readFileSync(new URL("wait.html", directory), "utf8") }); });
  for (const file of ["wait.js", "wait.css"]) await page.route(`**/release-wait/${file}`, route => route.fulfill({ contentType: file.endsWith("js") ? "application/javascript" : "text/css", body: readFileSync(new URL(file, directory), "utf8") }));
  await page.route("**/release-status.json*", route => route.fulfill({ json: { version: 1, phase, expiresAt: now + 600_000, release: "target", failure: { stage: "health", reason, occurredAt: now } } }));
  await page.route("**/health", route => route.fulfill({ json: { status: "ok", release } }));
  await page.goto("/and479-fallback");
  await expect(page.locator("#message")).toContainText("服务健康检查超时");
  reason = "PRIVATE_PATH_OR_LOG";
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator("#message")).toContainText("具体原因未知");
  await expect(page.locator("#message")).not.toContainText("PRIVATE_PATH_OR_LOG");
  expect(loads).toBe(1);
  phase = "idle";
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator("#message")).toContainText("服务健康或版本检查未通过");
  expect(loads).toBe(1);
  release = "target";
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect.poll(() => loads).toBe(2);
});
