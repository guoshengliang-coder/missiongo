import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/**
 * Enter in the reply box, on a keyboard and on a touch screen (AND-256).
 *
 * The reply box only renders for a session the server says canReply, and the
 * fixture has no way to seed one, so the two agent-session reads are answered
 * from this file instead. Everything under test -- the app, the component, the
 * keyboard handling, the form submit -- is the real thing.
 */

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8"),
) as { productId: string };

const SESSION_ID = "and-256-ui-fixture";
const CONSOLE_URL = `/?product=${fixture.productId}&console=agent&session=${SESSION_ID}`;
const now = "2026-09-29T03:00:00.000Z";

const summary = {
  id: SESSION_ID,
  agentSessionId: SESSION_ID,
  dispatchId: "dispatch-and-256",
  agentKind: "opencode",
  status: "active",
  updatedAt: now,
  activityAt: now,
  nodeName: "fixture-node",
  nodeConnectionState: "online",
  nodeRevoked: false,
  mode: "bypass",
  dispatchStatus: "in_progress",
  createdAt: now,
  // The console scopes the list to the selected product through the items, so an
  // item-less session is filtered out of every filter, "全部会话" included.
  items: [{ key: "AND-256", title: "代理控制台输入框回车发送的PC与移动端支持问题", productId: fixture.productId }],
  activities: [],
  canReply: true,
  attention: { state: "not_needed" },
  needsAttention: false,
  waitingForReply: false,
  canRetry: false,
  canStop: true,
  canArchive: true,
  nodeId: "node-and-256",
  settings: {},
  unread: false,
};

const detail = {
  id: SESSION_ID,
  dispatchId: "dispatch-and-256",
  agentKind: "opencode",
  status: "active",
  updatedAt: now,
  messages: [],
  activities: [],
  canReply: true,
  canResolveDelivery: false,
};

/** Answers the session reads, and records every command the box sends. */
async function stubSession(page: Page, sent: { text?: string }[]): Promise<void> {
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      if (url.pathname.endsWith("/commands")) sent.push(JSON.parse(request.postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "command-1", kind: "instruction", status: "queued", text: "x", createdAt: now }),
      });
      return;
    }
    const body = url.pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

const box = (page: Page) => page.locator(".agent-console-reply textarea");

test("keyboard Enter sends, Shift+Enter breaks the line, an empty Enter does nothing", async ({ page }) => {
  const sent: { text?: string }[] = [];
  await stubSession(page, sent);
  await page.goto(CONSOLE_URL);
  await expect(box(page)).toBeVisible();
  expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(false);

  // Empty: nothing sent, and no blank line started either.
  await box(page).click();
  await box(page).press("Enter");
  expect(await box(page).inputValue()).toBe("");
  expect(sent).toHaveLength(0);

  // Shift+Enter is the newline, and does not send.
  await box(page).fill("第一行");
  await box(page).press("Shift+Enter");
  expect(await box(page).inputValue()).toBe("第一行\n");
  expect(sent).toHaveLength(0);

  // A plain Enter sends what was typed.
  await box(page).fill("第二行");
  await box(page).press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text).toBe("第二行");
  // Auto-retrying: the command is recorded when the request goes out, the draft
  // is cleared a moment later when the response lands.
  await expect(box(page)).toHaveValue("");
});

test("the Enter that confirms an input method candidate is never sent", async ({ page }) => {
  const sent: { text?: string }[] = [];
  await stubSession(page, sent);
  await page.goto(CONSOLE_URL);
  await expect(box(page)).toBeVisible();
  await box(page).fill("nihao");

  // Synthetic: this is the keydown a browser delivers while an IME owns the key.
  // Playwright cannot drive a real input method, so a dispatched event is the
  // closest this harness gets -- the handler under test is the real one.
  await page.evaluate(() => {
    document.querySelector<HTMLTextAreaElement>(".agent-console-reply textarea")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
    );
  });
  expect(sent).toHaveLength(0);

  // The Safari order: composition ends first, then the confirming Enter arrives
  // reporting isComposing false. The component's own flag has to cover that.
  await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agent-console-reply textarea");
    textarea?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(sent).toHaveLength(0);

  // ...and the flag must not stick: a later plain Enter still sends.
  await box(page).press("Enter");
  await expect.poll(() => sent.length).toBe(1);
});

test.describe("touch screen", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("Enter is a newline, and the button is the only way to send", async ({ page }) => {
    const sent: { text?: string }[] = [];
    await stubSession(page, sent);
    await page.goto(CONSOLE_URL);
    await expect(box(page)).toBeVisible();
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);

    await box(page).click();
    await box(page).fill("第一行");
    await box(page).press("Enter");
    expect(await box(page).inputValue()).toBe("第一行\n");
    expect(sent).toHaveLength(0);

    await page.locator(".agent-console-reply button[type=submit]").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].text).toBe("第一行");
  });
});
