import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

const sessionId = "and-331-compact-settings";
const stamp = "2026-10-30T15:30:00.000Z";
const modelName = "GPT-6.1 Sol（用于验证完整名称展示的长模型名称）";

async function openConversation(page: Page) {
  const { productId } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
  const settings = { adjustable: true, mode: "plan", model: "fixture-model", requestedModel: "fixture-model", effort: "high" };
  const summary = {
    id: sessionId, agentSessionId: sessionId, dispatchId: "dispatch-and-331", agentKind: "codex", status: "active",
    updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeId: "compact-node", nodeName: "Fixture Mac",
    nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "in_progress",
    items: [{ key: "AND-331", title: "窄屏会话设置", productId }], activities: [], settings, unread: false,
    canReply: true, canRetry: false, canStop: false, canArchive: true,
    attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false,
  };
  const changes: Record<string, string>[] = [];
  const sent: string[] = [];
  await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{
    id: "compact-node", name: "Fixture Mac", repos: [], repoCandidates: [], online: true, createdAt: stamp,
    agents: [{ kind: "codex", ready: true, models: [{ id: "fixture-model", label: modelName, efforts: ["medium", "high"] }] }],
  }] } }));
  await page.route("**/api/v1/agent-sessions**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.endsWith("/settings")) {
      const change = request.postDataJSON();
      changes.push(change);
      Object.assign(settings, change);
      await route.fulfill({ json: settings });
    } else if (request.method() === "POST" && path.endsWith("/commands")) {
      sent.push(request.postDataJSON().text);
      await route.fulfill({ json: { id: "compact-command", kind: "message", status: "queued", text: sent.at(-1), createdAt: stamp } });
    } else {
      await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : {
        id: sessionId, dispatchId: summary.dispatchId, agentKind: "codex", status: "active", updatedAt: stamp,
        messages: [], activities: [], canReply: true, canAttach: true, canResolveDelivery: false,
      } });
    }
  });
  await page.goto(`/?product=${productId}&console=agent&session=${sessionId}`);
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  return { changes, sent };
}

async function fits(control: Locator, touch = true) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!, viewport = control.page().viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  if (touch) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [320, 353, 390]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} compact conversation settings`, () => {
    test.use({ viewport: { width, height: 757 }, hasTouch: true, isMobile: true, colorScheme: theme });
    test("model stays readable, More changes settings, and reply actions fit", async ({ page }) => {
      const { changes, sent } = await openConversation(page);
      const row = page.locator(".agent-session-quick-settings-row");
      await expect(row.locator("button.agent-settings-mode")).toBeHidden();
      await expect(row.locator("button.agent-settings-effort")).toBeHidden();
      const model = row.getByRole("combobox", { name: "模型", exact: true });
      const more = row.getByRole("button", { name: "更多操作", exact: true });
      const attach = page.locator(".agent-chat-send-actions button[type=button]");
      const send = page.locator(".agent-console-reply button[type=submit]");
      for (const large of [false, true]) {
        if (large) await page.locator("html").evaluate(node => node.setAttribute("data-font-scale", "large"));
        for (const control of [model, more, attach, send]) await fits(control);
        // The text gets usable width rather than an arrow-only trigger.
        expect(await model.locator(".single-select-text").evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(45);
        await model.click();
        const option = page.getByRole("option", { name: modelName, exact: true });
        await fits(option, false);
        expect(await option.locator(".single-select-option-content").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (width === 353 && large) await page.screenshot({ path: test.info().outputPath(`model-menu-${theme}.png`) });
        await model.press("Escape");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await more.click();
      const panel = page.locator(".agent-settings-more-panel");
      await fits(panel, false);
      await expect(panel.getByRole("combobox", { name: "权限模式", exact: true })).toBeVisible();
      await expect(panel.getByRole("combobox", { name: "强度", exact: true })).toBeVisible();
      if (width === 353) await page.screenshot({ path: test.info().outputPath(`more-panel-${theme}.png`) });
      await page.goBack();
      await expect(panel).toBeHidden();
      await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
      await more.click();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      for (const [label, field, value] of [["权限模式", "mode", "default"], ["强度", "effort", "medium"]] as const) {
        await more.click();
        await panel.getByRole("combobox", { name: label, exact: true }).click();
        await page.getByRole("listbox").locator(`[role=option][data-value="${value}"]`).click();
        // Picking a setting unmounts the panel along with its combobox.
        await expect(panel).toBeHidden();
        await expect.poll(() => changes).toContainEqual({ [field]: value });
      }
      await expect(attach).toBeEnabled();
      const chooser = page.waitForEvent("filechooser");
      await attach.click();
      expect((await chooser).isMultiple()).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`compact-${width}-${theme}.png`) });
      await page.locator(".agent-console-reply textarea").fill("继续检查");
      await expect(send).toBeEnabled();
      await send.click();
      await expect.poll(() => sent).toEqual(["继续检查"]);
    });
  });
}

test("desktop shows all settings and a narrow conversation pane uses compact settings", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openConversation(page);
  const row = page.locator(".agent-session-quick-settings-row");
  await expect(row.locator("button.agent-settings-mode")).toBeVisible();
  await expect(row.locator("button.agent-settings-effort")).toBeVisible();
  await expect(row.locator(".agent-settings-more")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("desktop-settings.png") });
  // Container width, rather than device width, also governs split desktop panes.
  await page.locator(".agent-console-conversation").evaluate(node => node.style.maxWidth = "600px");
  await expect(row.locator("button.agent-settings-mode")).toBeHidden();
  await expect(row.locator("button.agent-settings-effort")).toBeHidden();
  await expect(row.locator(".agent-settings-more")).toBeVisible();
});
