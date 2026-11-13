import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { solidPng } from "../../scripts/seed-ui-fixture.mjs";
import { expectUsableControl } from "./visible-control";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-13T09:00:00Z";
const png = solidPng(640, 360, [214, 226, 240]);
const image = { name: "draft.png", mimeType: "image/png", buffer: png };
const composer = (page: Page) => page.locator(".agent-console-reply");
const preview = (page: Page) => page.locator(".selected-media-lightbox");
const editor = (page: Page) => page.locator(".annotator");

async function setup(page: Page, newSession = false) {
  await page.clock.setFixedTime(new Date(stamp));
  const uploads: { name: string; type: string; bytes: Buffer }[] = [];
  let blockUpload: Promise<void> | undefined;
  let releaseUpload: (() => void) | undefined;
  let command: Record<string, unknown> | undefined;
  const summary = (id = "image-a") => ({ id, agentSessionId: id, productId: fixture.productId, source: "external", agentKind: "codex",
    status: "idle", progressStatus: "working", refKind: "native", lastReportedAt: stamp,
    nativeConnection: { state: "connected", nodeId: "node", nodeName: "Fixture", lastSyncedAt: stamp },
    nodeName: "Fixture", nodeRevoked: false, mode: "external", dispatchStatus: "external", updatedAt: stamp, activityAt: stamp,
    createdAt: stamp, sessionName: id === "image-a" ? "图片会话 A" : "图片会话 B", items: [], activities: [],
    canReply: true, canRetry: false, canStop: false, canArchive: true, settings: { mode: "external", adjustable: false },
    attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, unread: false,
    ...(command && id === "image-a" ? { command } : {}) });
  const dispatch = { id: "image-dispatch", agentSessionId: "image-a", productId: fixture.productId, nodeId: "node", nodeName: "Fixture",
    agentKind: "codex", mode: "auto", status: "queued", itemKeys: [], createdAt: stamp };
  await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: "node", name: "Fixture", online: true,
    supportsFreeSessions: true, supportsChatAttachments: true, agents: [{ kind: "codex", planApprovalProtocol: 1, ready: true }],
    repos: [{ productId: fixture.productId, repoPath: "fixture-repository" }], repoCandidates: [], createdAt: stamp }] } }));
  await page.route("**/api/v1/dispatch-defaults", route => route.fulfill({ json: { nodeId: "node", agentKind: "codex", agents: { codex: { mode: "auto" } } } }));
  await page.route("**/api/v1/project-conversations**", route => route.fulfill({ status: 201, json: { ...dispatch, startReady: true } }));
  await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/attachments") && route.request().method() === "POST") {
      const headers = route.request().headers();
      uploads.push({ name: decodeURIComponent(headers["x-missiongo-filename"]!), type: headers["x-missiongo-content-type"]!, bytes: route.request().postDataBuffer()! });
      await blockUpload;
      return route.fulfill({ status: 201, json: { id: `upload-${uploads.length}`, filename: uploads.at(-1)!.name, contentType: uploads.at(-1)!.type,
        kind: "image", sizeBytes: uploads.at(-1)!.bytes.length, sha256: "fixture", createdAt: stamp } });
    }
    if (path.endsWith("/commands")) {
      command = { id: "image-command", kind: "message", text: route.request().postDataJSON().text, status: "queued", createdAt: stamp,
        attachments: [{ id: "upload-1", kind: "image", filename: uploads[0]!.name, contentType: uploads[0]!.type, sizeBytes: uploads[0]!.bytes.length, sha256: "fixture", createdAt: stamp }] };
      return route.fulfill({ status: 201, json: command });
    }
    if (path.endsWith("/preview") || path.endsWith("/content")) return route.fulfill({ contentType: uploads[0]?.type ?? "image/png", body: uploads[0]?.bytes ?? png });
    if (path.endsWith("/agent-sessions")) return route.fulfill({ json: { sessions: newSession ? [] : [summary(), summary("image-b")] } });
    return route.fulfill({ json: { ...summary(path.includes("image-b") ? "image-b" : "image-a"), messages: [], canAttach: true } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent${newSession ? "" : "&session=image-a"}`);
  if (newSession) {
    const direct = page.locator(".agent-console-topbar-new");
    await expect(direct).toHaveCount(1);
    if (await direct.isVisible()) await direct.click();
    else {
      await page.locator(".agent-console-topbar-more > summary").click();
      await page.locator(".agent-console-topbar-more-menu").getByRole("button", { name: "新会话", exact: true }).click();
    }
    await page.locator(".dispatch-form").getByRole("button", { name: "进入会话", exact: true }).click();
  }
  await expect(composer(page).locator("textarea")).toBeEnabled();
  return { uploads, block: () => { blockUpload = new Promise(resolve => { releaseUpload = resolve; }); }, release: () => releaseUpload?.() };
}
async function openImage(page: Page, file = image) {
  await composer(page).locator('input[type="file"]').setInputFiles(file);
  await composer(page).getByRole("button", { name: `预览 ${file.name}`, exact: true }).click();
  await expect(preview(page)).toBeVisible();
}
async function enterEditor(page: Page) {
  await preview(page).getByRole("button", { name: "编辑图片", exact: true }).click();
  await expect(editor(page).getByRole("button", { name: "保存", exact: true })).toBeEnabled();
}
async function draw(page: Page, tool = "自由画笔") {
  await editor(page).getByRole("button", { name: tool, exact: true }).click();
  const box = await editor(page).locator("canvas").boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height * .4);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * .75, box!.y + box!.height * .6, { steps: 12 });
  await page.mouse.up();
  await expect(editor(page).getByRole("button", { name: "撤销上一笔", exact: true })).toBeEnabled();
}
async function expectMarked(bytes: Buffer, format = "png") {
  const meta = await sharp(bytes).metadata();
  expect(meta).toMatchObject({ width: 640, height: 360, format });
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 180 && data[i + 1]! < 160 && data[i + 2]! < 160) red++;
  expect(red).toBeGreaterThan(30);
}

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`AND-517 ${width} ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, isMobile: width === 320, colorScheme: theme });
    test("preview, protected cancellation, save, locked upload and actual image bytes", async ({ page }, testInfo) => {
      const state = await setup(page);
      await composer(page).locator("textarea").fill("保留这段文字");
      await openImage(page);
      await expectUsableControl(preview(page).getByRole("button", { name: "编辑图片", exact: true }), width === 320);
      await enterEditor(page);
      await draw(page);
      await editor(page).locator("footer").getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("button", { name: "放弃修改", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "放弃修改", exact: true }).click();
      await expect(editor(page)).toHaveCount(0);
      await expect(preview(page)).toBeVisible();
      await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toBeFocused();
      await enterEditor(page);
      await draw(page, "矩形框");
      await draw(page, "椭圆框");
      await editor(page).getByRole("button", { name: "撤销上一笔", exact: true }).click();
      await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
      await expectUsableControl(editor(page).getByRole("button", { name: "保存", exact: true }), width === 320);
      await page.screenshot({ path: testInfo.outputPath("editing.png") });
      await editor(page).getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor(page)).toHaveCount(0);
      await expect(preview(page)).toBeVisible();
      const blob = await preview(page).locator("img").evaluate(async (img: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
      await expectMarked(Buffer.from(blob));
      await page.keyboard.press("Escape");
      await expect(composer(page).getByRole("button", { name: "预览 draft.png", exact: true })).toBeFocused();
      await expect(composer(page).locator("textarea")).toHaveValue("保留这段文字");
      expect(state.uploads).toHaveLength(0);
      state.block();
      await composer(page).locator('button[type="submit"]').click();
      await expect.poll(() => state.uploads.length).toBe(1);
      await composer(page).getByRole("button", { name: "预览 draft.png", exact: true }).click();
      await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      state.release();
      await expect(composer(page).locator(".agent-chat-draft-file")).toHaveCount(0);
      await expectMarked(state.uploads[0]!.bytes);
      await page.locator(".agent-chat-image-open").click();
      await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test("export failure and oversize retain the canvas and permit retry", async ({ page }) => {
  await setup(page); await openImage(page); await enterEditor(page); await draw(page);
  await editor(page).locator("canvas").evaluate(canvas => {
    const original = canvas.toBlob.bind(canvas);
    let calls = 0;
    canvas.toBlob = (callback, type, quality) => {
      calls++;
      if (calls === 1) callback(null);
      else if (calls === 2) callback(new Blob([new Uint8Array(21 * 1024 * 1024)], { type: "image/png" }));
      else original(callback, type, quality);
    };
  });
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("生成失败");
  await expect(editor(page).locator("canvas")).toBeVisible();
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("20 MiB");
  await expect(editor(page).getByRole("button", { name: "撤销上一笔", exact: true })).toBeEnabled();
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
});

test("HEIC and undecodable images stay in the draft and explain editing limits", async ({ page }) => {
  await setup(page);
  await openImage(page, { name: "camera.heic", mimeType: "image/heic", buffer: Buffer.from("heic fixture") });
  await expect(preview(page).getByRole("alert")).toContainText("HEIC");
  await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await openImage(page, { ...image, buffer: Buffer.from("invalid png") });
  await expect(preview(page).getByRole("alert")).toContainText("附件加载失败");
  await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(composer(page).locator(".agent-chat-draft-file")).toHaveCount(2);
});

test("GIF prompts before losing animation; WebP saves with JPEG bytes and filename", async ({ page }) => {
  const state = await setup(page);
  const gif = await sharp(png).gif().toBuffer();
  await openImage(page, { name: "animated.gif", mimeType: "image/gif", buffer: gif });
  await preview(page).getByRole("button", { name: "编辑图片", exact: true }).click();
  await expect(page.getByText("编辑后将保存为静态图片，原有动画会丢失。是否继续？", { exact: true })).toBeVisible();
  await page.locator("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await preview(page).getByRole("button", { name: "编辑图片", exact: true }).click();
  await page.locator("dialog").last().getByRole("button", { name: "编辑图片", exact: true }).click();
  await draw(page);
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(preview(page)).toHaveAttribute("aria-label", "animated.jpg");
  await page.keyboard.press("Escape");
  await composer(page).getByRole("button", { name: "移除 animated.jpg", exact: true }).click();
  const webp = await sharp(png).webp().toBuffer();
  await openImage(page, { name: "photo.webp", mimeType: "image/webp", buffer: webp });
  await enterEditor(page); await draw(page);
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(preview(page)).toHaveAttribute("aria-label", "photo.jpg");
  await page.keyboard.press("Escape");
  await composer(page).locator('button[type="submit"]').click();
  await expect.poll(() => state.uploads.length).toBe(1);
  expect(state.uploads[0]!.name).toBe("photo.jpg");
  expect(state.uploads[0]!.type).toBe("image/jpeg");
  await expectMarked(state.uploads[0]!.bytes, "jpeg");
});

for (const width of [320, 1440]) test(`new conversation sends edited bytes at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await setup(page, true);
  await composer(page).locator("textarea").fill("首条消息");
  await openImage(page); await enterEditor(page); await draw(page);
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(composer(page).locator("textarea")).toHaveValue("首条消息");
  await composer(page).locator('button[type="submit"]').click();
  await expect.poll(() => state.uploads.length).toBe(1);
  await expectMarked(state.uploads[0]!.bytes);
});

test("switching conversations keeps edited and original drafts isolated", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page); await openImage(page); await enterEditor(page); await draw(page);
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page)).toHaveCount(0); await page.keyboard.press("Escape");
  await page.locator(".agent-console-session").filter({ hasText: "图片会话 B" }).click();
  await expect(composer(page).locator(".agent-chat-draft-file")).toHaveCount(0);
  await openImage(page, { ...image, name: "other.png" }); await page.keyboard.press("Escape");
  await page.locator(".agent-console-session").filter({ hasText: "图片会话 A" }).click();
  await expect(composer(page).getByRole("button", { name: "预览 draft.png", exact: true })).toBeVisible();
  await expect(composer(page).getByRole("button", { name: "预览 other.png", exact: true })).toHaveCount(0);
  await composer(page).getByRole("button", { name: "预览 draft.png", exact: true }).click();
  const bytes = await preview(page).locator("img").evaluate(async (img: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
  await expectMarked(Buffer.from(bytes));
});

test("an uncertain submission keeps image editing locked and never resubmits on preview", async ({ page }) => {
  const state = await setup(page);
  let submissions = 0;
  await page.route("**/api/v1/agent-sessions/image-a/commands", route => { submissions++; return route.abort("failed"); });
  await page.route("**/api/v1/agent-sessions/image-a/send-requests/**", route => route.fulfill({ status: 503, json: { title: "Unavailable" } }));
  await openImage(page); await page.keyboard.press("Escape");
  await composer(page).locator('button[type="submit"]').click();
  await expect(composer(page).getByText("提交结果待核对", { exact: false })).toBeVisible();
  await composer(page).getByRole("button", { name: "预览 draft.png", exact: true }).click();
  await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(state.uploads).toHaveLength(1);
  expect(submissions).toBe(1);
});

test("exporting blocks close and Back; Esc and Back protect marks after completion", async ({ page }) => {
  await setup(page); await openImage(page); await enterEditor(page); await draw(page);
  await editor(page).locator("canvas").evaluate(canvas => {
    const original = canvas.toBlob.bind(canvas);
    canvas.toBlob = (callback, type, quality) => {
      (window as typeof window & { finishExport?: () => void }).finishExport = () => original(callback, type, quality);
    };
  });
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page).getByRole("button", { name: "取消", exact: true }).first()).toBeDisabled();
  await expect(editor(page).getByRole("button", { name: "取消", exact: true }).last()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeVisible();
  await page.evaluate(() => (window as typeof window & { finishExport?: () => void }).finishExport?.());
  await expect(editor(page)).toHaveCount(0);
  await enterEditor(page); await draw(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "放弃修改", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "放弃修改？", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("button", { name: "放弃修改", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
});

test("comment drafts retain their existing preview without an editing action", async ({ page }) => {
  await page.goto(`/?product=${fixture.productId}&status=all&item=${fixture.detailKey}`);
  const comment = page.locator(".detail-composer");
  await comment.locator('input[type="file"]').setInputFiles(image);
  await comment.getByRole("button", { name: "预览 draft.png", exact: true }).click();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).getByRole("button", { name: "编辑图片", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(comment.getByRole("button", { name: "预览 draft.png", exact: true })).toBeFocused();
});

test("pasted and dropped images can be edited independently without changing file order", async ({ page }) => {
  await setup(page);
  await composer(page).locator("textarea").fill("多图草稿");
  await composer(page).locator("textarea").evaluate((element, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await composer(page).locator("form").evaluate((element, bytes) => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
  }, [...png]);
  await composer(page).getByRole("button", { name: "预览 dropped.png", exact: true }).click();
  await enterEditor(page); await draw(page);
  await editor(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor(page)).toHaveCount(0); await page.keyboard.press("Escape");
  const names = await composer(page).locator(".agent-chat-draft-file").evaluateAll(nodes => nodes.map(node => node.getAttribute("title")));
  expect(names).toEqual(["pasted.png", "dropped.png"]);
  const bytes = await composer(page).locator(".agent-chat-draft-file img").evaluateAll(async nodes => Promise.all(nodes.map(async node =>
    Array.from(new Uint8Array(await (await fetch((node as HTMLImageElement).src)).arrayBuffer())))));
  expect(Buffer.from(bytes[0]!)).toEqual(png);
  await expectMarked(Buffer.from(bytes[1]!));
  await expect(composer(page).locator("textarea")).toHaveValue("多图草稿");
});
