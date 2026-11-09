import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { chooseOption } from "./select-helpers";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-09T06:00:00.000Z";

async function stubConversations(page: Page) {
  await page.clock.setFixedTime(new Date(stamp));
  const node = { id: "and495-node", name: "Fixture", online: true, supportsFreeSessions: true,
    agents: [{ kind: "codex", planApprovalProtocol: 1, ready: true, models: [] }],
    repos: [{ productId: fixture.productId, repoPath: "synthetic" }], repoCandidates: [], createdAt: stamp };
  const conversation = (id: string, linked = false) => ({ id, agentSessionId: id, dispatchId: `dispatch-${id}`,
    productId: fixture.productId, nodeId: node.id, nodeName: node.name, agentKind: "codex", mode: "auto",
    status: "idle", dispatchStatus: "launched", createdAt: stamp, updatedAt: stamp, activityAt: stamp,
    items: linked ? [{ key: fixture.detailKey, productId: fixture.productId, title: "来源条目" }] : [], activities: [],
    canReply: true, canStop: false, canArchive: true, canRetry: false, unread: false,
    attention: { state: "not_needed" }, nodeConnectionState: "online", nodeRevoked: false, settings: {},
    sessionName: id });
  const sessions = [conversation("and495-original", true)];
  let created = 0;
  const dispatch = () => ({ id: `and495-dispatch-${created}`, agentSessionId: `and495-created-${created}`,
    productId: fixture.productId, nodeId: node.id, nodeName: node.name, agentKind: "codex", mode: "auto",
    status: "queued", itemKeys: [], createdAt: stamp });
  await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node] } }));
  await page.route("**/api/v1/dispatch-defaults", route => route.fulfill({ json: {
    nodeId: node.id, agentKind: "codex", agents: { codex: { mode: "auto" } },
  } }));
  await page.route("**/api/v1/project-conversations**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/start")) {
      sessions.push(conversation(dispatch().agentSessionId));
      return route.fulfill({ json: { ...dispatch(), startReady: true } });
    }
    created++;
    return route.fulfill({ status: 201, json: dispatch() });
  });
  await page.route("**/api/v1/agent-sessions**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const selected = sessions.find(session => path.endsWith(`/${session.id}`)) ?? sessions[0];
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions } : { ...selected, messages: [] } });
  });
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "and495-original-dispatch", agentSessionId: "and495-original", agentKind: "codex", nodeName: node.name,
    mode: "auto", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
  }] } }));
  return { created: () => created };
}

async function createConversation(page: Page, number: number) {
  const direct = page.locator(".agent-console-topbar-new");
  if (await direct.isVisible()) await direct.click();
  else {
    await page.locator(".agent-console-topbar-more > summary").click();
    await page.locator(".agent-console-topbar-more-menu").getByRole("button", { name: "新会话", exact: true }).click();
  }
  const form = page.locator(".dispatch-form");
  await chooseOption(form.getByRole("combobox", { name: "权限模式", exact: true }), "auto");
  await form.getByRole("button", { name: "进入会话", exact: true }).click();
  await page.locator(".agent-console-reply textarea").fill(`导航回归 ${number}`);
  await page.locator(".agent-console-reply button[type=submit]").click();
  await expect(page.locator(".new-session-head")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`session=and495-created-${number}`));
  await expect(page.locator(".agent-console-conversation-head h2")).toContainText(`and495-created-${number}`);
}

for (const width of [375, 768, 1440]) {
  test(`new conversations preserve list-origin Back and Forward at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const counts = await stubConversations(page);
    await page.goto(`/?product=${fixture.productId}&console=agent`);
    await expect(page.locator(".agent-console-topbar-new")).toBeAttached();
    await createConversation(page, 1);
    if (width > 520) {
      await createConversation(page, 2);
      expect(counts.created()).toBe(2);
    } else {
      await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
      const createdRow = page.locator(".agent-console-session").filter({ hasText: "and495-created-1" });
      await expect(createdRow).toBeVisible();
      await createdRow.click();
      await page.goBack();
      await expect(createdRow).toBeVisible();
    }
    await page.locator(".agent-console-topbar-back").click();
    await expect(page).not.toHaveURL(/console=agent/);
    await page.goForward();
    await expect(page).toHaveURL(/console=agent/);
    if (width > 520) await expect(page.locator(".agent-console-conversation-head h2")).toContainText("and495-created-2");
  });
}

for (const width of [375, 1440]) {
  test(`new conversation preserves item-origin return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubConversations(page);
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    const jump = page.locator(".detail-dispatch-line").getByRole("button", { name: "在控制台查看", exact: true });
    await jump.click();
    await expect(page).toHaveURL(/session=and495-original/);
    // On a phone the global toolbar is hidden until the console is wide.
    await page.setViewportSize({ width: 1440, height: 900 });
    await createConversation(page, 1);
    await page.setViewportSize({ width, height: 900 });
    if (width === 375) await page.getByRole("button", { name: "返回条目详情", exact: true }).click();
    else await page.locator(".agent-console-topbar-back").click();
    await expect(page).not.toHaveURL(/console=agent/);
    await expect(jump).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/session=and495-created-1/);
  });
}

test("new conversation survives a desktop-phone-desktop layout round trip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubConversations(page);
  await page.goto(`/?product=${fixture.productId}&console=agent`);
  await expect(page.locator(".agent-console-topbar-new")).toBeVisible();
  await createConversation(page, 1);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByRole("button", { name: "返回会话列表", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".agent-console-session.active")).toBeVisible();
  await page.locator(".agent-console-topbar-back").click();
  await expect(page).not.toHaveURL(/console=agent/);
  await page.goForward();
  await expect(page.locator(".agent-console-conversation-head h2")).toContainText("and495-created-1");
});
