import { readFileSync } from "node:fs";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { ARTIFACT_PREVIEW_POLICY, ARTIFACT_PREVIEW_SHELL, validateArtifactBundle } from "../../services/server/src/agent-artifacts";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-12T03:00:00Z";
const file = (name: string, contentType: string, text: string) => ({ name, contentType, base64: Buffer.from(text).toString("base64") });
const html = `<h1>交互原型</h1><input aria-label="原型输入" value="hello"><button onclick="document.querySelector('output').textContent='已点击'">原型按钮</button><output>初始</output><div style="width:200px;overflow:auto"><div style="width:1000px">横向内容</div></div>`;
const text = "[第一张](/tmp/fixture-output/first.png) [原型](/tmp/fixture-output/prototype.html) [最后图片](/tmp/fixture-output/last.png) [缺失](/tmp/fixture-output/missing.html) [重复](file:///tmp/fixture-output/first.png) [文档](/tmp/fixture-output/note.md)";

async function setup(page: Page, panel = false, longName = false, options: { corruptImage?: boolean; longError?: boolean; singleImage?: boolean } = {}) {
  const requests: { messageId: string; href: string }[] = [];
  const pngBytes = new Map(await Promise.all(["first.png", "last.png"].map(async name => [name,
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: name === "first.png" ? "#dddddd" : "#aabbcc" } }).png().toBuffer(),
  ] as const)));
  let missing = true;
  let bundleFailures = 0;
  let corrupted = Boolean(options.corruptImage);
  const bundleFetches = new Map<string, number>();
  let release: (() => void) | undefined;
  let hold = false;
  let holdImage = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const row = { id: "gallery-session", agentSessionId: "gallery-session", dispatchId: "gallery-dispatch", agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", nodeName: "Fixture",
    createdAt: stamp, updatedAt: stamp, activityAt: stamp, activities: [], items: [{ key: fixture.detailKey, productId: fixture.productId, title: "Gallery" }],
    settings: { mode: "auto", adjustable: false }, canReply: true, canAttach: false, canResolveDelivery: false, canArchive: true, canStop: false, canRetry: false, attention: { state: "not_needed" }, turnState: {} };
  const detail = { ...row, messages: [{ id: "gallery-message", role: "agent", text: options.singleImage ? "[第一张](/tmp/fixture-output/first.png)" : longName ? text.replace("prototype.html", "long-filename-".repeat(24) + ".html") : text, occurredAt: stamp }, { id: "solo-message", role: "agent", text: "[另一条消息](/tmp/fixture-output/solo.html)", occurredAt: stamp }] };
  await page.addInitScript(() => { (window as any).MissionGoAndroid = { setBackDepth: (n: number) => { (window as any).galleryDepth = n; } }; });
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return route.fulfill({ contentType: "text/html", headers: { "content-security-policy": ARTIFACT_PREVIEW_POLICY }, body: ARTIFACT_PREVIEW_SHELL });
    if (path.endsWith("/artifacts")) {
      const body = route.request().postDataJSON(); requests.push(body);
      const name = body.href.split("/").at(-1) as string;
      return route.fulfill({ json: { id: name, filename: name, status: name === "missing.html" && missing ? "failed" : "ready", ...(name === "missing.html" && missing ? { error: options.longError ? "resource_missing" : "file_missing", ...(options.longError ? { errorResource: "assets/" + "unbroken-name".repeat(65) + ".css" } : {}) } : {}) } });
    }
    if (path.endsWith("/bundle")) {
      const name = path.split("/").at(-2)!;
      bundleFetches.set(name, (bundleFetches.get(name) ?? 0) + 1);
      if ((hold && name === "prototype.html") || (holdImage && name === "first.png")) await gate;
      if (name === "prototype.html" && bundleFailures > 0) { bundleFailures--; return route.fulfill({ status: 503, json: { error: "temporary_failure" } }); }
      const image = name.endsWith(".png");
      const entry = image ? { name, contentType: "image/png", base64: (corrupted && name === "first.png" ? Buffer.from("invalid image bytes") : pngBytes.get(name)!).toString("base64") }
        : file(name, name.endsWith(".md") ? "text/markdown" : "text/html", html);
      return route.fulfill({ json: validateArtifactBundle({ entry: name, files: [entry] }) });
    }
    if (path.includes("/artifacts/")) {
      const name = path.split("/").at(-1)!;
      return route.fulfill({ json: { id: name, filename: name, status: name === "missing.html" && missing ? "failed" : "ready", ...(name === "missing.html" && missing ? { error: options.longError ? "resource_missing" : "file_missing", ...(options.longError ? { errorResource: "assets/" + "unbroken-name".repeat(65) + ".css" } : {}) } : {}) } });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] } : detail });
  });
  if (panel) {
    await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: row.dispatchId, agentSessionId: row.id, agentKind: "codex", mode: "auto", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey] }] } }));
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
    await page.locator(".agent-session-toggle").click();
  } else await page.goto(`/?product=${fixture.productId}&console=agent&session=${row.id}`);
  return { requests, pngBytes, bundleFetches, holdImage: () => { holdImage = true; }, fixImage: () => { corrupted = false; }, failBundle: () => { bundleFailures = 2; }, fixMissing: () => { missing = false; }, hold: () => { hold = true; }, release: () => release!() };
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "文件预览", exact: true });
const count = (page: Page) => dialog(page).locator(".artifact-navigation strong");
const open = (page: Page, name = "原型") => page.getByRole("button", { name, exact: true }).click();

for (const panel of [false, true]) test(`mixed message gallery preserves context in ${panel ? "item panel" : "console"}`, async ({ page }) => {
  const state = await setup(page, panel);
  const editor = page.locator(panel ? ".agent-session-panel textarea" : ".agent-console-reply textarea");
  await editor.fill("未发送草稿");
  const trigger = page.getByRole("button", { name: "原型", exact: true });
  const url = page.url();
  await trigger.scrollIntoViewIfNeeded();
  const messages = page.locator(panel ? ".agent-session-messages" : ".agent-console-messages");
  const scroll = await messages.evaluate(el => el.scrollTop);
  const depth = await page.evaluate(() => (window as any).galleryDepth);
  await open(page);
  await expect(count(page)).toHaveText("2 / 4");
  const frame = page.frameLocator('iframe[title="prototype.html"]');
  await frame.getByRole("textbox").fill("保留输入键盘操作");
  await frame.getByRole("textbox").press("ArrowLeft");
  await frame.getByRole("button", { name: "原型按钮" }).click();
  await expect(frame.locator("output")).toHaveText("已点击");
  await expect(count(page)).toHaveText("2 / 4");
  const next = dialog(page).getByRole("button", { name: "下一个附件", exact: true });
  const previous = dialog(page).getByRole("button", { name: "上一个附件", exact: true });
  await next.click();
  await expect(dialog(page).locator("header strong")).toHaveText("last.png");
  await expect(dialog(page).getByRole("link", { name: "下载", exact: true })).toHaveAttribute("download", "last.png");
  await previous.click();
  await expect(frame.locator("output")).toHaveText("初始");
  await previous.click();
  await expect(count(page)).toHaveText("1 / 4");
  await expect(previous).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("2 / 4");
  await previous.click();
  await expect(dialog(page).locator(".zoomable-image")).toBeVisible();
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("2 / 4");
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("3 / 4");
  await next.click();
  await expect(count(page)).toHaveText("4 / 4");
  await expect(next).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(count(page)).toHaveText("3 / 4");
  await next.click();
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  state.fixMissing();
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.frameLocator('iframe[title="missing.html"]').getByRole("heading")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).galleryDepth)).toBe(depth + 1);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(editor).toHaveValue("未发送草稿");
  expect(Math.abs(await messages.evaluate(el => el.scrollTop) - scroll)).toBeLessThanOrEqual(1);
  await expect(page).toHaveURL(url);
  await open(page, "另一条消息");
  await expect(dialog(page).locator(".artifact-navigation")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await open(page, "文档");
  await expect(dialog(page).locator(".artifact-navigation")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(state.requests.filter(r => r.href.endsWith("prototype.html"))).toHaveLength(1);
  expect(state.requests.filter(r => !r.href.endsWith("solo.html")).every(r => r.messageId === "gallery-message")).toBe(true);
  expect(state.requests.find(r => r.href.endsWith("solo.html"))?.messageId).toBe("solo-message");
});

test("late slide response cannot replace the active file or its download", async ({ page }) => {
  const state = await setup(page); state.hold();
  await open(page);
  await expect(count(page)).toHaveText("2 / 4");
  await dialog(page).getByRole("button", { name: "下一个附件", exact: true }).click();
  await expect(dialog(page).getByRole("link", { name: "下载", exact: true })).toHaveAttribute("download", "last.png");
  state.release();
  await dialog(page).locator(".zoomable-image img").evaluate(img => img.dispatchEvent(new Event("error")));
  await expect(dialog(page).getByRole("alert")).toContainText("图片");
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog(page).locator(".zoomable-image img")).toBeVisible();
  await expect(dialog(page).locator("header strong")).toHaveText("last.png");
  await expect(dialog(page).locator("iframe")).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await dialog(page).getByRole("link", { name: "下载", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("last.png");
  await download.saveAs(test.info().outputPath("last.png"));
  expect(readFileSync(test.info().outputPath("last.png"))).toEqual(state.pngBytes.get("last.png"));
});

for (const theme of ["light", "dark"] as const) test.describe(`touch layout ${theme}`, () => {
  test.use({ hasTouch: true, colorScheme: theme, viewport: { width: 320, height: 568 } });
  test("navigation remains reachable at every font scale and image gestures stay distinct", async ({ page, context }) => {
    await setup(page); await open(page, "第一张");
    await expect(dialog(page).locator(".zoomable-image img")).toBeVisible();
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      const nav = dialog(page).locator(".artifact-navigation");
      const buttons = nav.getByRole("button");
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.y + box.height).toBeLessThanOrEqual(568);
      }
      expect(await dialog(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await nav.locator("span").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(11);
    }
    const cdp = await context.newCDPSession(page);
    const touch = async (type: string, points: { x: number; y: number; id: number }[]) => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    };
    const viewport = (await dialog(page).locator(".zoomable-image-viewport").boundingBox())!;
    const y = Math.round(viewport.y + viewport.height / 2);
    await touch("touchStart", [{ x: 110, y, id: 1 }, { x: 210, y, id: 2 }]);
    await touch("touchMove", [{ x: 60, y, id: 1 }, { x: 260, y, id: 2 }]);
    await touch("touchEnd", []);
    await expect(dialog(page).locator(".zoomable-image")).toHaveAttribute("data-zoomed", "true");
    await touch("touchStart", [{ x: 250, y, id: 1 }]);
    await touch("touchMove", [{ x: 70, y, id: 1 }]); await touch("touchEnd", []);
    await expect(count(page)).toHaveText("1 / 4");
    await dialog(page).getByRole("button", { name: "适应屏幕", exact: true }).tap();
    await touch("touchStart", [{ x: 170, y: y - 60, id: 1 }]);
    await touch("touchMove", [{ x: 170, y: y + 60, id: 1 }]); await touch("touchEnd", []);
    await expect(count(page)).toHaveText("1 / 4");
    await touch("touchStart", [{ x: 250, y, id: 1 }]);
    await touch("touchMove", [{ x: 70, y, id: 1 }]); await touch("touchCancel", []);
    await expect(count(page)).toHaveText("1 / 4");
    await touch("touchStart", [{ x: 250, y, id: 1 }]);
    await touch("touchMove", [{ x: 70, y, id: 1 }]); await touch("touchEnd", []);
    await expect(count(page)).toHaveText("2 / 4");
    await page.screenshot({ path: test.info().outputPath(`gallery-${theme}.png`) });
    await cdp.detach();
  });
});

for (const width of [320, 1440]) test(`long filename at short height keeps close and navigation visible at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 420 });
  await setup(page, false, true);
  await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
  await open(page);
  await expect(count(page)).toHaveText("2 / 4");
  await expect(dialog(page).locator("iframe")).toBeVisible();
  for (const control of await dialog(page).getByRole("button").all()) {
    const box = (await control.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(420);
  }
  expect(await dialog(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await dialog(page).getByRole("button", { name: "下一个附件", exact: true }).click();
  await expect(count(page)).toHaveText("3 / 4");
});

test("a failed bundle can be retried without losing gallery navigation", async ({ page }) => {
  const state = await setup(page); state.failBundle();
  await open(page);
  await expect(dialog(page).getByRole("alert")).toBeVisible({ timeout: 15000 });
  await expect(count(page)).toHaveText("2 / 4");
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.frameLocator('iframe[title="prototype.html"]').getByRole("heading")).toBeVisible();
  await dialog(page).getByRole("button", { name: "下一个附件", exact: true }).click();
  await expect(count(page)).toHaveText("3 / 4");
});

for (const control of ["zoom", "download"]) test(`audit 1: ${control} focus survives replacing its slide`, async ({ page }) => {
  await setup(page); await open(page, "第一张");
  await expect(dialog(page).locator(".zoomable-image img")).toBeVisible();
  const target = control === "zoom" ? dialog(page).getByRole("button", { name: "放大图片", exact: true }) : dialog(page).getByRole("link", { name: "下载", exact: true });
  await target.focus();
  await page.keyboard.press("Control+ArrowRight");
  await expect(count(page)).toHaveText("1 / 4");
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("2 / 4");
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("3 / 4");
  expect(await dialog(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
});

test("audit 1: image decode retry retrieves repaired bytes", async ({ page }) => {
  const state = await setup(page, false, false, { corruptImage: true });
  await open(page, "第一张");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  const before = state.bundleFetches.get("first.png") ?? 0;
  state.fixImage();
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => state.bundleFetches.get("first.png") ?? 0).toBeGreaterThan(before);
  await expect(dialog(page).locator(".zoomable-image img")).toBeVisible();
  await expect.poll(() => dialog(page).locator(".zoomable-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("2 / 4");
});

for (const theme of ["light", "dark"] as const) test(`audit 2: long failure diagnostic stays readable at 320px ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 320, height: 420 });
  const state = await setup(page, false, false, { longError: true });
  await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
  await open(page, "缺失");
  const alert = dialog(page).getByRole("alert");
  await expect(alert).toBeVisible();
  expect(await dialog(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await alert.evaluate(el => { el.scrollTop = 0; });
  const firstLine = (await alert.locator("p").first().boundingBox())!;
  const box = (await alert.boundingBox())!;
  expect(firstLine.y).toBeGreaterThanOrEqual(box.y);
  await alert.getByRole("button", { name: "重试", exact: true }).scrollIntoViewIfNeeded();
  const retryBox = (await alert.getByRole("button", { name: "重试", exact: true }).boundingBox())!;
  expect(retryBox.y).toBeGreaterThanOrEqual(box.y);
  expect(retryBox.y + retryBox.height).toBeLessThanOrEqual(box.y + box.height);
  state.fixMissing();
  await alert.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.frameLocator('iframe[title="missing.html"]').getByRole("heading")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(count(page)).toHaveText("3 / 4");
});

test("audit 3: a late image retry cannot replace the selected HTML", async ({ page }) => {
  const state = await setup(page, false, false, { corruptImage: true });
  await open(page, "第一张");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  state.fixImage(); state.holdImage();
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => state.bundleFetches.get("first.png") ?? 0).toBeGreaterThan(1);
  await dialog(page).getByRole("button", { name: "下一个附件", exact: true }).click();
  const frame = page.frameLocator('iframe[title="prototype.html"]');
  await expect(frame.getByRole("heading")).toBeVisible();
  state.release();
  await expect(count(page)).toHaveText("2 / 4");
  await expect(dialog(page).locator("header strong")).toHaveText("prototype.html");
  await expect(dialog(page).getByRole("link", { name: "下载", exact: true })).toHaveAttribute("download", "prototype.html");
  await expect(dialog(page).locator(".zoomable-image")).toHaveCount(0);
  await frame.getByRole("button", { name: "原型按钮" }).click();
  await expect(frame.locator("output")).toHaveText("已点击");
});

test("audit 3: single-image retry keeps focus inside its modal", async ({ page }) => {
  const state = await setup(page, false, false, { corruptImage: true, singleImage: true });
  await open(page, "第一张");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(dialog(page).locator(".artifact-navigation")).toHaveCount(0);
  state.fixImage();
  await dialog(page).getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog(page).locator(".zoomable-image img")).toBeVisible();
  expect(await dialog(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
});
