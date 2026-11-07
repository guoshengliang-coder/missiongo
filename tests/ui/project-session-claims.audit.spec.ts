import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentSessionSummary } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };

for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) test.describe(`project claims ${theme} ${touch ? "touch" : "mouse"}`, () => {
  test.use({ colorScheme: theme, hasTouch: touch, isMobile: touch });
  test("names the conversation after the items it claimed, keeps one running conversation, history and reply", async ({ page }, info) => {
    const id = "project-conversation", stamp = new Date().toISOString();
    let items: AgentSessionSummary["items"] = [];
    let sent = "";
    const summary = (): AgentSessionSummary => ({
      id, agentSessionId: id, dispatchId: "project-dispatch", productId: fixture.productId,
      agentKind: "codex", status: "active", sessionName: "这是什么问题？", round: 2,
      nodeName: "Fixture node", nodeRevoked: false, nodeConnectionState: "online", mode: "plan", dispatchStatus: "launched",
      updatedAt: stamp, activityAt: stamp, createdAt: stamp, items, activities: [], turnState: { turnActive: true },
      canReply: true, canRetry: false, canStop: true, canArchive: true,
      settings: { mode: "plan", adjustable: false }, attention: { state: "not_needed" }, unread: false,
    });
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/commands")) {
        sent = route.request().postDataJSON().text;
        return route.fulfill({ status: 201, json: { id: "reply", kind: "message", text: sent, status: "queued", createdAt: stamp } });
      }
      if (path.endsWith("/read")) return route.fulfill({ status: 204 });
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary()] } : {
        ...summary(), canAttach: false, messages: [
          { id: "question", sourceId: "question", role: "user", text: "这是什么问题？", occurredAt: stamp },
          { id: "answer", sourceId: "answer", role: "agent", text: "原项目会话的消息历史", occurredAt: stamp },
        ],
      } });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    await expect(page.locator(".agent-console-heading h2")).toContainText("这是什么问题？");
    await expect(page.locator(".agent-console-heading h2 [data-session-category=unlinked]")).toHaveText("无关联会话");
    await expect(page.locator(".agent-console-session-heading [data-session-category]")).toHaveCount(0);
    const meta = page.locator(".agent-console-session-meta");
    await expect(meta.locator('[data-session-category=unlinked]')).toHaveText("无关联会话");
    for (const width of [320, 520, 521, 1440]) for (const scale of ["small", "medium", "large"]) {
      await page.setViewportSize({ width, height: width === 1440 ? 375 : 900 });
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      if (width <= 520) {
        await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
      }
      const badge = meta.locator('[data-session-category=unlinked]');
      await expect(badge).toBeVisible();
      const labelBox = await meta.locator("small").boundingBox();
      const badgeBox = await badge.boundingBox();
      const sameRow = Math.abs(badgeBox!.y + badgeBox!.height / 2 - labelBox!.y - labelBox!.height / 2) <= 1;
      if (sameRow) expect(badgeBox!.x).toBeGreaterThanOrEqual(labelBox!.x + labelBox!.width);
      else expect(badgeBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      if (width === 320 && scale === "large") await page.screenshot({ path: info.outputPath("unlinked-meta-phone.png") });
      if (width <= 520) await page.locator(".agent-console-session").click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: info.outputPath("unlinked-meta.png") });
    for (const linked of [
      [{ key: fixture.detailKey, title: "首个处理条目", productId: fixture.productId }],
      [{ key: fixture.detailKey, title: "首个处理条目", productId: fixture.productId }, { key: "EXAMPLE-2", title: "第二个处理条目", productId: fixture.productId }],
    ]) {
      items = linked;
      await page.reload();
      await expect(page.locator(".agent-console-session")).toHaveCount(1);
      const keys = linked.map(item => item.key).join("、");
      // Claiming items renames the conversation after the work it does (AND-445).
      await expect(page.locator(".agent-console-session-heading strong")).toHaveText(`${keys} · 首个处理条目`);
      await expect(page.locator(".agent-console-heading h2")).toContainText(`${keys} · 首个处理条目`);
      await expect(page.locator('[data-session-category="unlinked"]')).toHaveCount(0);
      await expect(page.locator('.agent-console-session [data-session-category="linked"]')).toHaveText("条目会话");
      await expect(page.locator('.agent-console-heading h2 [data-session-category="linked"]')).toHaveText("条目会话");
      await expect(page.getByRole("button", { name: /^运行中 \d+$/ }).locator("small")).toHaveText("1");
      await expect(page.locator(".agent-console-dispatch-head button")).toHaveCount(items.length);
      await expect(page.getByText("原项目会话的消息历史", { exact: true })).toBeVisible();
      for (const width of [320, 520, 768, 1440]) for (const scale of ["small", "medium", "large"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        await expect(page.locator(".agent-console-heading h2")).toContainText(`${keys} · 首个处理条目`);
        await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
    }
    await page.locator(".agent-console-reply textarea").fill("继续原会话");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent).toBe("继续原会话");
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("project-conversation.png") });
  });
});
