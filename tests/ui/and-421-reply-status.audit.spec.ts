import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import type { AgentSessionCommand } from "../../apps/web/src/types";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

/**
 * AND-441: normal receipts sit outside the bubble. Switching delivery states
 * must not resize the text bubble; no hidden state reserves extra width.
 */
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`reply status keeps its place while words change ${width}px ${theme}`, async ({ browser }, testInfo) => {
    const touch = width < 1024;
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch,
      colorScheme: theme, storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.clock.install();
    const stamp = new Date().toISOString();
    const id = `and421-${width}-${theme}`;
    const baseCommand: AgentSessionCommand = { id: "queued-message", kind: "message", text: "那你重新更新下条目内容，准备提交", status: "queued", createdAt: stamp };
    const commands = { queued: baseCommand, delivering: { ...baseCommand, status: "delivering" as const }, delivered: { ...baseCommand, status: "delivered" as const } };
    let command: AgentSessionCommand = commands.queued;
    const turnState = { turnActive: true, waitingForInput: false, turnStartedAt: stamp, observedAt: stamp, lastProgressAt: stamp };
    const summary = { id, agentSessionId: id, agentKind: "codex", status: "active", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched", settings: {},
      activities: [], turnState, canReply: true, canStop: true, canArchive: true, canRetry: false, unread: false,
      items: [{ key: "EX-421", title: "会话反馈", productId: fixture.productId }], attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/read")) return route.fulfill({ status: 204 });
      if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: [{ ...summary, command }] } });
      return route.fulfill({ json: { ...summary, command, canAttach: true, canResolveDelivery: true, messages: [
        { id: "previous", sourceId: "previous", role: "user", text: "前一条消息", occurredAt: stamp },
      ] } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const bubble = page.locator(".agent-console-message-outgoing");
    const group = page.locator(".agent-console-outgoing");
    const feedback = group.locator(".agent-reply-feedback");
    await expect(page.locator(".agent-console-outgoing")).toContainText("排队中");

    // One spinner for every state, and no pencil beside the recall text.
    await expect(page.locator(".agent-reply-current .agent-reply-spin")).toHaveCSS("animation-name", "spin");
    await expect(page.locator(".agent-reply-edit svg")).toHaveCount(0);
    // The recall action sits right beside the state, underlined and slightly bolder.
    const edit = page.locator(".agent-console-outgoing").getByRole("button", { name: "撤回编辑" });
    const state = page.locator(".agent-reply-current .agent-reply-state");
    await expect(edit).toHaveCSS("text-decoration-line", "underline");
    await expect(edit).toHaveCSS("font-weight", "600");
    const stateFont = await state.evaluate((node) => getComputedStyle(node).fontSize);
    await expect(edit).toHaveCSS("font-size", stateFont);
    const stateBox = (await state.boundingBox())!;
    const editBox = (await edit.boundingBox())!;
    expect(editBox.x - (stateBox.x + stateBox.width)).toBeGreaterThanOrEqual(4);
    expect(editBox.x - (stateBox.x + stateBox.width)).toBeLessThanOrEqual(12);
    await expect(page.locator(".agent-reply-sizer")).toHaveCount(0);
    await expect(bubble.locator(".agent-reply-feedback")).toHaveCount(0);
    const bubbleBox = (await bubble.boundingBox())!;
    expect((await feedback.boundingBox())!.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height);
    if (touch) {
      // The 44px touch target must not vertically center the visible receipt
      // and manufacture a large blank band below the bubble.
      expect(stateBox.y - bubbleBox.y - bubbleBox.height).toBeLessThanOrEqual(6);
      expect(editBox.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(stateBox.y - editBox.y)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`reply-queued-${width}-${theme}.png`) });

    // Every later state keeps the queued footprint exactly.
    const before = (await bubble.boundingBox())!;
    for (const status of ["delivering", "delivered"] as const) {
      command = commands[status];
      await advanceSessionDetailPoll(page);
      await expect(page.locator(`.agent-console-message-outgoing-${status}`)).toBeVisible();
      await expect(page.locator(".agent-console-outgoing").getByRole("button", { name: "撤回编辑" })).toHaveCount(0);
      expect((await bubble.boundingBox())!.x, `${status} x`).toBeCloseTo(before.x, 0);
      expect((await bubble.boundingBox())!.width, `${status} width`).toBeCloseTo(before.width, 0);
      expect((await bubble.boundingBox())!.height, `${status} height`).toBeCloseTo(before.height, 0);
    }
    await expect(page.locator(".agent-reply-current .agent-reply-spin")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`reply-status-${width}-${theme}.png`) });
    await context.close();
  });
}

test("a short message keeps the same footprint when delivery starts", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1440, height: 900 }, storageState: "./tests/ui/.auth/state.json" });
  const page = await context.newPage();
  await page.clock.install();
  const stamp = new Date().toISOString();
  const id = "and421-short";
  let command: AgentSessionCommand = { id: "queued-short", kind: "message", text: "提交", status: "queued", createdAt: stamp };
  const turnState = { turnActive: true, waitingForInput: false, turnStartedAt: stamp, observedAt: stamp, lastProgressAt: stamp };
  const summary = { id, agentSessionId: id, agentKind: "codex", status: "active", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched", settings: {},
    activities: [], turnState, canReply: true, canStop: true, canArchive: true, canRetry: false, unread: false,
    items: [{ key: "EX-421", title: "会话反馈", productId: fixture.productId }], attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: [{ ...summary, command }] } });
    return route.fulfill({ json: { ...summary, command, canAttach: true, canResolveDelivery: true, messages: [] } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const bubble = page.locator(".agent-console-message-outgoing");
  await expect(page.locator(".agent-console-outgoing")).toContainText("排队中");
  const before = (await bubble.boundingBox())!;
  command = { ...command, status: "delivering" };
  await advanceSessionDetailPoll(page);
  await expect(page.locator(".agent-console-message-outgoing-delivering")).toBeVisible();
  expect((await bubble.boundingBox())!.x).toBeCloseTo(before.x, 0);
  expect((await bubble.boundingBox())!.width).toBeCloseTo(before.width, 0);
  expect((await bubble.boundingBox())!.height).toBeCloseTo(before.height, 0);
  await context.close();
});
