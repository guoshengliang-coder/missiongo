import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const detailUrl = () => `/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`;
const depth = (page: Page) => page.evaluate(() => ((window as any).reportedDepth ?? 0) as number);
async function back(page: Page) { await page.evaluate(() => history.back()); }
async function focusStaysInTopLayer(page: Page) {
  expect(await page.evaluate(() => {
    const top = Array.from(document.querySelectorAll("dialog[open]")).at(-1);
    const background = Array.from(document.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")).find(node => !node.closest("dialog"));
    background?.focus();
    return Boolean(top?.contains(document.activeElement));
  })).toBe(true);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i < 4 ? "Tab" : "Shift+Tab");
    expect(await page.evaluate(() => document.activeElement === document.body || Boolean(Array.from(document.querySelectorAll("dialog[open]")).at(-1)?.contains(document.activeElement)))).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { (window as any).MissionGoAndroid = { setBackDepth: (n: number) => { (window as any).reportedDepth = n; } }; });
});

test("collapsed toolbar editor returns focus to the visible menu trigger", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(detailUrl());
  await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
  const toolbar = page.locator(".detail-toolbar");
  await expect(toolbar).toHaveAttribute("data-overflow", "true");
  const trigger = toolbar.locator(".detail-more-menu > summary");
  const base = await depth(page), url = page.url();
  for (const close of ["back", "escape", "cancel"]) {
    await trigger.click();
    await toolbar.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => depth(page)).toBe(base + 1);
    if (close === "back") await back(page);
    else if (close === "escape") await page.keyboard.press("Escape");
    else await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => depth(page)).toBe(base);
    await expect(page).toHaveURL(url);
  }
});

for (const closingWidth of [1440, 320]) test(`editor restores visible focus when closed at ${closingWidth}px`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 812 });
  await page.goto(detailUrl());
  await page.locator(".detail-toolbar").getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: closingWidth, height: 812 });
  await expect(page.locator(".detail-toolbar")).toHaveAttribute("data-overflow", String(closingWidth === 320));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const target = closingWidth === 320 ? page.locator(".detail-pane") : page.locator(".detail-toolbar").getByRole("button", { name: "编辑", exact: true });
  await expect(target).toBeFocused();
  await expect(target).toBeVisible();
});

async function conversation(page: Page, html = false) {
  const stamp = "2026-10-31T12:00:00Z";
  const summary = { id: "overlay-session", agentSessionId: "overlay-session", source: "external", agentKind: "codex", status: "idle",
    nodeName: "Fixture", nodeRevoked: false, mode: "external", dispatchStatus: "external", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    items: [{ key: fixture.detailKey, title: "浮层契约", productId: fixture.productId }], activities: [], turnState: {}, canReply: false,
    canRetry: false, canStop: false, canArchive: true, settings: { mode: "external", adjustable: false }, attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, unread: false };
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/bundle")) return route.fulfill({ json: { entry: "preview.html", files: [{ name: "preview.html", contentType: "text/html", base64: Buffer.from("<button>Inside preview</button>").toString("base64") }] } });
    if (path.endsWith("/preview")) return route.fulfill({ contentType: "text/html", body: "<button>Inside preview</button>" });
    if (path.includes("/artifacts")) return route.fulfill({ json: { id: "overlay-file", status: html ? "ready" : "failed", filename: "preview.html", error: "file_missing" } });
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    if (path.endsWith("/overlay-session")) return route.fulfill({ json: { id: summary.id, source: "external", agentKind: "codex", status: "idle", updatedAt: stamp,
      messages: [{ id: "output", role: "agent", text: "[文件预览](/tmp/fixture-output/preview.html)", occurredAt: stamp }], activities: [], turnState: {}, canReply: false, canAttach: false, canResolveDelivery: false } });
    return route.fulfill({ json: { sessions: [summary] } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=overlay-session`);
  await expect(page.getByRole("button", { name: fixture.detailKey, exact: true })).toBeVisible();
}

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width} ${theme} common overlay contract`, () => {
    test.use({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("media closes one layer and preserves URL, scroll and trigger focus on repeat", async ({ page }) => {
      await page.goto(detailUrl());
      const card = page.locator(".attachment-card").first();
      await card.scrollIntoViewIfNeeded();
      const trigger = card.locator(".attachment-media-open");
      const url = page.url();
      const scroll = await page.locator(".detail-scroll").evaluate(el => el.scrollTop);
      const base = await depth(page);
      for (const close of ["back", "escape", "button"]) {
        await trigger.click();
        await expect(page.locator(".selected-media-lightbox[open]")).toBeVisible();
        await expect.poll(() => depth(page)).toBe(base + 1);
        await focusStaysInTopLayer(page);
        if (close === "back") await back(page);
        else if (close === "escape") await page.keyboard.press("Escape");
        else await page.getByRole("button", { name: "关闭预览", exact: true }).click();
        await expect(page.locator(".selected-media-lightbox")).toHaveCount(0);
        await expect.poll(() => depth(page)).toBe(base);
        await expect(page).toHaveURL(url);
        await expect(trigger).toBeFocused();
        expect(Math.abs(await page.locator(".detail-scroll").evaluate(el => el.scrollTop) - scroll)).toBeLessThanOrEqual(1);
      }
    });

    test("Select consumes Back before a dirty parent, then the parent still guards input", async ({ page }) => {
      await page.goto("/settings/connections");
      await page.getByRole("button", { name: "新建个人令牌", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const input = dialog.getByRole("textbox", { name: "名称", exact: true });
      await input.fill("保留草稿");
      const control = dialog.getByRole("combobox").first();
      const base = await depth(page);
      await control.click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await expect.poll(() => depth(page)).toBe(base + 1);
      await back(page);
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(input).toHaveValue("保留草稿");
      await expect(control).toBeFocused();
      await expect(dialog.getByRole("heading", { name: "放弃修改？" })).toHaveCount(0);
      await back(page);
      await expect(dialog.getByRole("heading", { name: "放弃修改？" })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(input).toHaveValue("保留草稿");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => depth(page)).toBe(base - 1);
      await page.goForward();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => depth(page)).toBe(base - 1);
    });

    test("item preview owns focus and nested media each consumes one Back", async ({ page }) => {
      await conversation(page);
      const trigger = page.getByRole("button", { name: fixture.detailKey, exact: true });
      const base = await depth(page), url = page.url();
      await trigger.click();
      const preview = page.locator(".item-preview-backdrop");
      await expect(preview).toBeVisible();
      expect(await preview.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await focusStaysInTopLayer(page);
      const tile = preview.locator(".item-preview-media button").first();
      await tile.click();
      await expect(page.locator(".item-preview-media-viewer")).toBeVisible();
      await expect.poll(() => depth(page)).toBe(base + 2);
      await back(page);
      await expect(page.locator(".item-preview-media-viewer")).toHaveCount(0);
      await expect(preview).toBeVisible();
      await expect(tile).toBeFocused();
      await back(page);
      await expect(preview).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page).toHaveURL(url);
      await expect.poll(() => depth(page)).toBe(base);
    });

    test("conversation fonts keep their readable floor at every user scale", async ({ page }) => {
      await conversation(page);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        const audit = await page.evaluate(AUDIT_SOURCE) as { text: { fontSize: number; where: string; sample: string }[] };
        expect(audit.text.filter(t => t.fontSize > 0 && t.fontSize < 11), scale).toEqual([]);
      }
    });

    test("file errors close before the conversation and restore focus", async ({ page }) => {
      await conversation(page);
      const trigger = page.getByRole("button", { name: "文件预览", exact: true });
      const base = await depth(page), url = page.url();
      await trigger.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("alert")).toContainText("原文件已删除或移动");
      await focusStaysInTopLayer(page);
      await back(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page).toHaveURL(url);
      await expect.poll(() => depth(page)).toBe(base);
    });
  });
}

test("a focused artifact iframe cannot make Back dismiss its underlying conversation", async ({ page }) => {
  await conversation(page, true);
  const base = await depth(page), url = page.url();
  await page.getByRole("button", { name: "文件预览", exact: true }).click();
  await page.frameLocator('iframe[title="preview.html"]').getByRole("button").click();
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(url);
  await expect.poll(() => depth(page)).toBe(base);
});

test("native SDK bridge sees a child layer and pending submit independently", async ({ page }) => {
  await page.addInitScript(() => { (window as any).MissionGoAndroid.setEditorBusy = (busy: boolean) => { (window as any).editorBusy = busy; }; });
  const draft = { id: "overlay-sdk", productName: "SDK fixture", status: "editing", title: "SDK feedback", description: "Keep the editor", type: "bug", priority: "normal", environment: { platform: "android" }, context: {}, logs: [] };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/sdk/drafts/overlay-sdk**", async route => {
    if (route.request().method() !== "GET") await gate;
    return route.fulfill({ json: { ...draft, ...(route.request().url().endsWith("/finalize") ? { status: "submitted", itemKey: "FX-1" } : {}) } });
  });
  await page.goto("/sdk/feedback?draft=overlay-sdk");
  await page.getByRole("combobox", { name: "优先级", exact: true }).click();
  await expect.poll(() => depth(page)).toBe(1);
  await back(page);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect.poll(() => depth(page)).toBe(0);
  await page.getByRole("button", { name: "保存到草稿", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).editorBusy)).toBe(true);
  release();
  await expect(page.getByRole("heading", { name: "已保存到草稿", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).editorBusy)).toBe(false);
});
