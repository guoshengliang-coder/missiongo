import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AgentSessionMessage } from "../../apps/web/src/types";

// AND-279: exercise both real reply surfaces against isolated session reads.
const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8",
)) as { productId: string; detailKey: string };
const id = "and-279-question-fixture";
const stamp = "2026-10-02T02:00:00.000Z";
const summary = {
  id, agentSessionId: id, dispatchId: "and-279-dispatch", agentKind: "codex",
  status: "active", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
  nodeId: "fixture-node", nodeName: "Fixture", nodeConnectionState: "online",
  nodeRevoked: false, mode: "plan", dispatchStatus: "in_progress",
  items: [{ key: fixture.detailKey, title: "Question scrolling", productId: fixture.productId }],
  activities: [], settings: {}, unread: false, canReply: true, canRetry: false,
  canStop: true, canArchive: true, attention: { state: "not_needed" },
  needsAttention: false, waitingForReply: false,
};

function message(index: number): AgentSessionMessage {
  return { id: `message-${index}`, role: "agent", occurredAt: stamp,
    text: `Conversation history ${index}\n\n${"A line of conversation context. ".repeat(12)}` };
}

async function stubSession(page: Page, replyControl?: { wait: Promise<void>; fail?: boolean }) {
  const messages: AgentSessionMessage[] = [
    ...Array.from({ length: 8 }, (_, index) => message(index)),
    { id: "raw-question", role: "agent", occurredAt: stamp, text: "Choose or edit your answer.", questions: [
      { title: "本次范围", options: ["人工评论、MCP 都支持（推荐）", "仅人工评论"] },
    ] },
    { id: "questions", role: "agent", occurredAt: stamp, text: "Please choose each answer.", questions: [
      { key: "single", title: "单选", options: ["方案 A", "方案 B"] },
      { key: "multi", title: "多选", options: ["项目 A", "项目 B"], multiSelect: true },
      { key: "boolean", title: "继续吗", kind: "boolean" },
    ] },
    ...Array.from({ length: 12 }, (_, index) => message(index + 8)),
  ];
  const sent: string[] = [];
  let command: Record<string, unknown> | undefined;
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/commands")) {
      const text = JSON.parse(request.postData() ?? "{}").text as string;
      sent.push(text);
      await replyControl?.wait;
      if (replyControl?.fail) return route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ code: "request_failed", title: "Reply unavailable" }) });
      command = { id: "reply-command", kind: "message", text, status: "queued", createdAt: stamp };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(command) });
    }
    const body = new URL(request.url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [summary] }
      : { ...summary, messages, command, canResolveDelivery: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/items/*/dispatches", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ dispatches: [{
      id: summary.dispatchId, agentSessionId: id, agentKind: "codex", mode: "plan",
      nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
    }] }),
  }));
  return { messages, sent,
    setReplyStatus: (status: "queued" | "delivering" | "delivery_unknown" | "delivered") => {
      if (command) command.status = status;
    },
    deliverReply: () => { if (command) command.status = "delivered"; },
  };
}

const scrollTop = (area: Locator) => area.evaluate((element) => element.scrollTop);
const bottomGap = (area: Locator) => area.evaluate((element) =>
  element.scrollHeight - element.scrollTop - element.clientHeight);

async function chooseWithoutScrolling(
  button: Locator, area: Locator, reply: Locator, expected: string, touch: boolean, selected = true,
) {
  // Make the target visible before measuring: Playwright's own click scrolling
  // is not the application behaviour this regression protects.
  await button.scrollIntoViewIfNeeded();
  await button.page().waitForTimeout(100);
  const before = await scrollTop(area);
  expect(await bottomGap(area)).toBeGreaterThan(200);
  if (touch) await button.tap();
  else await button.click();
  await expect(reply).toHaveValue(expected);
  if (selected) await expect(button).toHaveClass("selected");
  else await expect(button).not.toHaveClass("selected");
  // The old callback used smooth scrolling: let its animation finish before
  // measuring, so a transient initial position cannot make the test pass.
  await button.page().waitForTimeout(400);
  expect(Math.abs(await scrollTop(area) - before)).toBeLessThanOrEqual(1);
  await expect(button).toBeInViewport();
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "phone", width: 375, height: 812, touch: true },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch, isMobile: viewport.touch });

    for (const surface of ["console", "panel"] as const) {
      for (const fail of [false, true]) {
        test(`${surface} locks question edits until a reply ${fail ? "fails" : "is delivered"} (AND-350)`, async ({ page }) => {
          await page.addInitScript(() => localStorage.setItem("missiongo.locale", "zh-CN"));
          let releaseReply!: () => void;
          const wait = new Promise<void>((resolve) => { releaseReply = resolve; });
          const state = await stubSession(page, { wait, fail });
          if (surface === "console") {
            await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
          } else {
            await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
            await page.locator(".execution-history > summary").click();
            await page.locator(".agent-session-toggle").click();
          }
          const area = page.locator(surface === "console" ? ".agent-console-messages" : ".agent-session-messages");
          const form = page.locator(surface === "console" ? ".agent-console-reply" : ".agent-session-reply");
          const reply = form.locator("textarea");
          const option = area.getByRole("button", { name: "方案 B", exact: true });
          const otherOption = area.getByRole("button", { name: "方案 A", exact: true });
          await expect(reply).toBeVisible();
          await option.click();
          const answer = await reply.inputValue();
          await form.locator("button[type=submit]").click();
          await expect.poll(() => state.sent).toEqual([answer]);

          // Hold the POST: the question must obey the same lock as the editor.
          // Dispatching an extra click also verifies it cannot change the draft.
          await expect(reply).toBeDisabled();
          await expect(otherOption).toBeDisabled();
          await otherOption.dispatchEvent("click");
          await expect(reply).toHaveValue(answer);
          releaseReply();

          if (fail) {
            await expect(reply).toBeEnabled();
            await expect(reply).toHaveValue(answer);
            await expect(otherOption).toBeEnabled();
            await otherOption.click();
            await expect(reply).toHaveValue("single: 方案 A");
            return;
          }

          // A successful POST clears the draft, but the mirrored questions may
          // not be marked answered until a later poll. Taps in that interval
          // used to refill the disabled editor and survive the eventual answer.
          await expect(reply).toHaveValue("");
          for (const status of ["queued", "delivering", "delivery_unknown"] as const) {
            state.setReplyStatus(status);
            await expect(form.locator("button[type=submit]")).toBeDisabled();
            await expect(otherOption).toBeDisabled();
            await otherOption.dispatchEvent("click");
            await expect(reply).toHaveValue("");
            // Observe the actual status poll before moving to the next stage.
            await expect.poll(async () => {
              const response = await page.waitForResponse((response) => response.request().method() === "GET"
                && new URL(response.url()).pathname === `/api/v1/agent-sessions/${id}`);
              return (await response.json()).command?.status;
            }).toBe(status);
          }
          const index = state.messages.findIndex((message) => message.id === "questions");
          const questionMessage = state.messages[index]!;
          state.messages[index] = { ...questionMessage,
            questions: questionMessage.questions!.map((question) => ({ ...question, answered: question.key === "single" ? "方案 B" : "" })),
          };
          state.messages.push({ id: "answer-received", role: "agent", text: "已收到回答", occurredAt: stamp });
          state.deliverReply();
          await expect(area.getByText("已收到回答", { exact: true })).toBeVisible();
          await expect(reply).toBeEnabled();
          await expect(reply).toHaveValue("");
          await expect(option).toBeDisabled();
          await expect(option).toHaveClass("selected");
          await reply.fill("接下来我想补充说明");
          await expect(reply).toHaveValue("接下来我想补充说明");
          expect(state.sent).toEqual([answer]);
        });
      }

      test(`${surface} options update answers without moving the conversation`, async ({ page }, testInfo) => {
        await page.addInitScript(() => localStorage.setItem("missiongo.locale", "zh-CN"));
        const state = await stubSession(page);
        if (surface === "console") {
          await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
        } else {
          await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
          await page.locator(".execution-history > summary").click();
          await page.locator(".agent-session-toggle").click();
        }
        const area = page.locator(surface === "console" ? ".agent-console-messages" : ".agent-session-messages");
        const reply = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
        await expect(reply).toBeVisible();
        const option = (name: string) => area.getByRole("button", { name, exact: true });
        const choose = (name: string, answer: string, selected = true) =>
          chooseWithoutScrolling(option(name), area, reply, answer, viewport.touch, selected);

        // AND-347: the real failing format is a single question without a key.
        const rawQuestion = area.locator(".agent-session-question").filter({ hasText: "本次范围" });
        const draftStatus = rawQuestion.getByRole("status");
        await choose("人工评论、MCP 都支持（推荐）", "人工评论、MCP 都支持（推荐）");
        await expect(option("人工评论、MCP 都支持（推荐）")).toHaveAttribute("aria-pressed", "true");
        await expect(draftStatus).toHaveText("已选择，未发送");
        await reply.fill("仅人工评论");
        await expect(option("人工评论、MCP 都支持（推荐）")).not.toHaveClass("selected");
        await expect(option("仅人工评论")).toHaveClass("selected");
        await reply.fill("仅人工评论，另外补充我的要求");
        await expect(rawQuestion.locator("button.selected")).toHaveCount(0);
        await expect(draftStatus).toHaveCount(0);
        await reply.fill("");
        await expect(rawQuestion.locator("button.selected")).toHaveCount(0);
        await choose("人工评论、MCP 都支持（推荐）", "人工评论、MCP 都支持（推荐）");
        await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          const path = testInfo.outputPath(`${surface}-${viewport.name}-${theme}-unsent.png`);
          await page.screenshot({ path, animations: "disabled" });
          await testInfo.attach(`${surface}-${theme}-unsent`, { path, contentType: "image/png" });
        }
        await reply.fill("");

        await choose("方案 A", "single: 方案 A");
        await choose("方案 B", "single: 方案 B");
        await expect(option("方案 A")).not.toHaveClass("selected");
        await choose("项目 A", "single: 方案 B\nmulti: 项目 A");
        await choose("项目 B", "single: 方案 B\nmulti: 项目 A、项目 B");
        await choose("项目 A", "single: 方案 B\nmulti: 项目 B", false);
        await choose("是", "single: 方案 B\nmulti: 项目 B\nboolean: 是");
        await choose("否", "single: 方案 B\nmulti: 项目 B\nboolean: 否");
        await expect(option("是")).not.toHaveClass("selected");
        expect(state.sent).toEqual([]);

        await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          const path = testInfo.outputPath(`${surface}-${viewport.name}-${theme}.png`);
          await page.screenshot({ path, animations: "disabled" });
          await testInfo.attach(`${surface}-${theme}`, { path, contentType: "image/png" });
        }

        if (surface === "console") {
          const before = await scrollTop(area);
          state.messages.push({ id: "new-message", role: "agent", occurredAt: stamp, text: "New incoming message" });
          await expect(area.locator("article").last()).toContainText("New incoming message");
          // Picking an option must also leave followLatest disabled while the
          // person is reading history, even after the next detail poll.
          expect(Math.abs(await scrollTop(area) - before)).toBeLessThanOrEqual(1);
          await page.locator(".agent-console-new-messages").click();
          await expect.poll(() => bottomGap(area)).toBeLessThanOrEqual(1);
          state.messages.push({ id: "followed-message", role: "agent", occurredAt: stamp, text: "Following latest still works" });
          await expect(area.locator("article").last()).toContainText("Following latest still works");
          await expect.poll(() => bottomGap(area)).toBeLessThanOrEqual(1);
          await area.evaluate((element) => { element.scrollTop = 0; });
          await page.waitForTimeout(100);
          expect(await bottomGap(area)).toBeGreaterThan(200);
        }
        const answer = await reply.inputValue();
        await page.locator(surface === "console"
          ? ".agent-console-reply button[type=submit]" : ".agent-session-reply button[type=submit]").click();
        await expect.poll(() => state.sent).toEqual([answer]);
        await expect(reply).toHaveValue("");
        if (surface === "console") await expect.poll(() => bottomGap(area)).toBeLessThanOrEqual(1);

        // Confirmed history comes from the session, independently of new drafts.
        state.deliverReply();
        const answeredIndex = state.messages.findIndex((message) => message.id === "questions");
        const answered = state.messages[answeredIndex]!;
        state.messages[answeredIndex] = { ...answered,
          questions: answered.questions!.map((question, index) => ({
            ...question, answered: ["方案 B", "项目 B", "否"][index],
          })),
        };
        await expect(option("方案 B")).toBeDisabled();
        await expect(option("方案 B")).toHaveClass("selected");
        await reply.fill("接下来我想补充说明");
        await expect(option("方案 B")).toHaveClass("selected");
        await expect(area.locator(".agent-session-question.answered .agent-session-question-draft")).toHaveCount(0);

      });
    }
  });
}
