import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
test.use({ hasTouch: true });
const { productId } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
const mode = "本会话内允许（本会话，建议 1）";
const directory = "本会话内允许（本会话，建议 2）";
const question = { header: "授权请求", key: "授权请求 request-431", title: "Claude Code 请求使用 Edit",
  options: ["批准", mode, directory, "拒绝"],
  detail: `${mode}：{"type":"setMode","mode":"acceptEdits","destination":"session"}\n${directory}：{"type":"addDirectories","directories":["/example/long-project/apps/node/src/fixtures"],"destination":"session"}` };
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`all scopes visible and original answer retained ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const stamp = new Date().toISOString();
    const detail = { id: "permission-431", agentSessionId: "permission-431", agentKind: "claude_code", status: "idle", updatedAt: stamp,
      activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", mode: "default", settings: {}, items: [], activities: [],
      canReply: true, canArchive: true, canStop: false, attention: { state: "needed", kind: "question" },
      messages: [{ id: "message", sourceId: "message", role: "agent", text: "等待授权", occurredAt: stamp, questions: [question] }] };
    const sent: unknown[] = [];
    await page.route("**/api/v1/agent-sessions**", route => {
      if (route.request().method() === "POST") {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: "command-431", sessionId: "permission-431", kind: "message", status: "queued", text: `授权请求 request-431: ${directory}`, createdAt: stamp } });
      }
      return route.fulfill({ json:
      new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [detail] } : detail });
    });
    await page.goto(`/?product=${productId}&console=agent&session=permission-431`);
    const card = page.locator(".agent-session-permission");
    await expect(card.getByRole("button")).toHaveCount(4);
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const button of await card.getByRole("button").all()) {
        expect(await button.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(11);
        expect(await button.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
    }
    await expect(card.locator("details")).not.toHaveAttribute("open");
    for (const button of await card.getByRole("button").all()) {
      await expect(button).toBeVisible();
      expect(await button.evaluate(el => el.closest("details") === null)).toBe(true);
    }
    await expect(card).toContainText("修改是否需要确认，仍按当前权限规则执行");
    await card.getByRole("button", { name: /本次会话允许访问指定文件夹/ }).click();
    await expect(page.locator(".agent-console-reply textarea")).toHaveValue(/授权请求 request-431: 本次会话允许访问指定文件夹/);
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ text: `授权请求 request-431: ${directory}` });
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator(".agent-console-message-outgoing")).not.toContainText("建议 2");
    await page.screenshot({ path: testInfo.outputPath("permission.png") });
  });
}
