import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import { AUDIT_SOURCE } from "./audit-page.mjs";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "console-recovery-fixture";
const stamp = "2026-10-31T03:00:00.000Z";
const item = { key: "EX-341", title: "Recovery fixture", productId: fixture.productId };
const summary = {
  id, agentSessionId: id, dispatchId: "dispatch-recovery", agentKind: "codex", status: "failed",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture node", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", sessionUrl: "codex://threads/recovery-fixture", dispatchStatus: "launched", createdAt: stamp, items: [item],
  activities: [], canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, settings: {}, unread: false,
};
const detail = {
  id, status: "failed", agentKind: "codex", updatedAt: stamp, activities: [], turnState: {}, canReply: true,
  failure: { code: "codex_server_error" },
  messages: [{ id: "md", role: "agent", text: "- **我的判断：**当前正文\n- **方案： **兼容中文\n\n> 引用\n\n- [x] 已检查\n\n| 项目 | 结果 |\n| --- | --- |\n| 格式 | 正常 |\n\n```md\n**保持代码：**原文\n```", occurredAt: stamp }],
};

for (const theme of ["light", "dark"] as const) for (const phone of [false, true]) {
  test(`recovery actions and CJK markdown: ${theme} ${phone ? "phone" : "desktop"}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 },
      isMobile: phone, hasTouch: phone, colorScheme: theme, storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    let healthRequests = 0;
    const writes: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/dispatches/health")) healthRequests++; });
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      if (route.request().method() !== "GET") writes.push(new URL(route.request().url()).pathname);
      const body = new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const recovery = page.getByRole("region", { name: "接下来可以做什么" });
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("输入新消息并手动发送");
    const titleBox = await recovery.locator(":scope > strong").boundingBox();
    const descriptionBox = await recovery.locator(":scope > p").first().boundingBox();
    expect(descriptionBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    await expect(recovery.getByRole("button", { name: "重新派单" })).toHaveCount(0);
    await expect(recovery.getByRole("button", { name: "归档", exact: true })).toBeVisible();
    await expect(recovery.locator(".dispatch-session-link")).toBeVisible();
    if (!phone) expect(await recovery.locator(".dispatch-session-link a").evaluate((element) => getComputedStyle(element).fontSize)).not.toBe("0px");
    await expect(recovery.getByRole("link", { name: "打开条目 EX-341" })).toHaveAttribute("href", `/?product=${fixture.productId}&item=EX-341`);
    const markdown = page.locator(".agent-console-message .markdown-text");
    await expect(markdown.locator("strong")).toHaveText(["我的判断：", "方案："]);
    await expect(markdown.locator("blockquote")).toContainText("引用");
    await expect(markdown.locator("table")).toContainText("正常");
    await expect(markdown.locator("pre")).toContainText("**保持代码：**原文");
    const checkbox = markdown.getByRole("checkbox");
    await expect(checkbox).toBeDisabled();
    expect((await checkbox.boundingBox())!.height).toBeLessThanOrEqual(20);
    expect((await markdown.locator(".task-list-item").boundingBox())!.height).toBeLessThanOrEqual(28);
    await page.locator(".agent-console-message").screenshot({ path: testInfo.outputPath(`markdown-${theme}-${phone ? "phone" : "desktop"}.png`) });
    await recovery.getByRole("button", { name: "继续回复" }).click();
    await expect(page.locator(".agent-console-reply textarea")).toBeFocused();
    expect(writes).toEqual([]);
    for (const button of await recovery.locator("button, a").all()) {
      expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect(await button.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
      expect(await button.evaluate((element) => getComputedStyle(element).fontSize)).not.toBe("0px");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const audit = await page.evaluate(AUDIT_SOURCE) as { appearance: string; text: { fontSize: number; fontWeight: number; contrast: number; sample: string }[] };
    expect(audit.appearance).toBe(theme);
    expect(audit.text.filter((text) => text.fontSize > 0 && text.fontSize < 11)).toEqual([]);
    expect(audit.text.filter((text) => text.contrast < (text.fontSize >= 24 || (text.fontSize >= 18.66 && text.fontWeight >= 700) ? 3 : 4.5))).toEqual([]);
    await recovery.screenshot({ path: testInfo.outputPath(`recovery-${theme}-${phone ? "phone" : "desktop"}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`console-${phone ? "375x812" : "1440x900"}-${theme}.png`) });
    if (phone) await page.getByRole("button", { name: "返回会话列表" }).click();
    await page.getByRole("button", { name: /^异常/ }).click();
    await expect(page.locator(".dispatch-health")).toHaveCount(0);
    expect(healthRequests).toBe(0);
    await context.close();
  });
}

test("failed dispatch reuses retry and archive confirmations", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    const body = path === "/api/v1/agent-sessions"
      ? { sessions: [{ ...summary, agentSessionId: undefined, canReply: false, canRetry: true, dispatchStatus: "failed", replyBlockedReason: "no_session" }] }
      : { ...detail, canReply: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/dispatches/dispatch-recovery/retry", async (route) => {
    writes.push("retry"); await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/v1/dispatches/dispatch-recovery/archive", async (route) => {
    writes.push("archive"); await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const recovery = page.getByRole("region", { name: "接下来可以做什么" });
  await expect(recovery).toContainText("检查节点与 Agent 配置");
  await expect(recovery.getByRole("button", { name: "继续回复" })).toHaveCount(0);
  await recovery.getByRole("button", { name: "重新派单" }).click();
  expect(writes).toEqual([]);
  const dialog = page.getByRole("dialog", { name: "确认操作" });
  await expect(dialog).toContainText("服务端会重新检查条目状态与权限");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => writes).toEqual(["retry"]);
  await recovery.getByRole("button", { name: "归档", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => writes).toEqual(["retry", "archive"]);
});

test("pending replies and read-only failures show the reason and withhold unavailable actions", async ({ page }) => {
  let pending = true;
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const command = pending ? { id: "pending", kind: "message", text: "Continue", status: "delivery_unknown", createdAt: stamp } : undefined;
    const body = new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [{ ...summary, canReply: false, canArchive: false, replyBlockedReason: "operate_permission" }] }
      : { ...detail, canReply: false, command };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const recovery = page.getByRole("region", { name: "接下来可以做什么" });
  await expect(recovery).toContainText("先处理下方投递状态");
  await expect(recovery.getByRole("button")).toHaveCount(0);
  pending = false;
  await page.reload();
  await expect(recovery).toContainText("原 Agent 客户端");
  await expect(recovery).toContainText("权限");
  await expect(recovery.getByRole("button")).toHaveCount(0);
});
