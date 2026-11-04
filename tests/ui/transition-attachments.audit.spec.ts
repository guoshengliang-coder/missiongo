import { postItemCommand } from "./item-command";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { expectUsableControl } from "./visible-control";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const file = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from("State reason evidence") });
async function create(request: APIRequestContext, status = "pending_verification") {
  const response = await request.post("/api/v1/items", { data: { productId: fixture.productId, title: "Reason attachment regression", description: "", type: "requirement", priority: "normal", status: "ready", environment: { platform: "web" } } });
  expect(response.ok()).toBeTruthy();
  const item = await response.json() as { key: string };
  expect((await postItemCommand(request,`/api/v1/items/${item.key}/transitions`, { data: { to: status, reason: "manual_override" } })).ok()).toBeTruthy();
  return item;
}
async function openReason(page: Page, key: string, source: "list" | "detail" = "list", cancel = false) {
  await page.goto(`/?product=${fixture.productId}&status=all&q=${key}${source === "detail" ? `&item=${key}` : ""}`);
  const menu = source === "list" ? page.locator(".item-row .row-more-menu") : page.locator(".detail-pane .detail-more-menu");
  await menu.locator(":scope > summary").click();
  if (cancel) await menu.locator("button.danger").click();
  else await menu.getByRole("button", { name: "验收打回", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".transition-note-form")).toBeVisible();
  return dialog;
}

for (const viewport of [
  { width: 320, height: 740 }, { width: 375, height: 812 }, { width: 812, height: 375 },
  { width: 768, height: 1024 }, { width: 1180, height: 820 }, { width: 1280, height: 800 }, { width: 1440, height: 900 },
]) for (const theme of ["light", "dark"] as const) test.describe(`${viewport.width} ${theme} reason attachments`, () => {
  test.use({ viewport, colorScheme: theme, hasTouch: viewport.width < 1280, isMobile: viewport.width < 1280 });
  test("stages files, guards file-only drafts and submits one status record", async ({ page, request }) => {
    const item = await create(request);
    const dialog = await openReason(page, item.key);
    await dialog.locator('input[type="file"]').setInputFiles(file("evidence.txt"));
    expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).attachments).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("heading", { name: "放弃修改？", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
    await dialog.getByRole("button", { name: "移除 evidence.txt", exact: true }).click();
    await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
    await dialog.locator("textarea").fill("图片与文件说明需要继续处理");
    await dialog.locator('input[type="file"]').setInputFiles(file("evidence.txt"));
    for (const control of [dialog.getByRole("button", { name: "添加附件", exact: true }), dialog.locator('button[type="submit"]')]) {
      await control.scrollIntoViewIfNeeded(); await expectUsableControl(control, viewport.width < 1280);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("reason-dialog.png") });
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toHaveCount(0);
    const stored = await (await request.get(`/api/v1/items/${item.key}`)).json();
    expect(stored.status).toBe("ready");
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0].transitionEventId).toBeTruthy();
    const timeline = await (await request.get(`/api/v1/items/${item.key}/timeline`)).json();
    expect(timeline.events.filter((event: { eventType: string }) => event.eventType === "comment_added")).toHaveLength(0);
    await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
    const record = page.locator(".timeline .timeline-event").filter({ hasText: "图片与文件说明需要继续处理" });
    await expect(record).toContainText("evidence.txt");
    await expect(page.locator(".timeline").getByText("evidence.txt", { exact: true })).toHaveCount(1);
  });
});

test("detail cancellation keeps reason/files after upload and write failures, retries a lost write response once, and blocks close while pending", async ({ page, request }) => {
  const item = await create(request);
  const uploads: string[] = [];
  let failUpload = true, loseResponse = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/items/${item.key}/attachments`, async route => {
    const name = decodeURIComponent(route.request().headers()["x-missiongo-filename"]);
    uploads.push(name);
    if (name === "retry.txt" && failUpload) await route.fulfill({ status: 503, contentType: "application/json", body: '{}' });
    else await route.continue();
  });
  await page.route(`**/items/${item.key}/transitions`, async route => {
    await gate;
    const response = await route.fetch();
    if (loseResponse) { loseResponse = false; await route.fulfill({ status: 503, contentType: "application/json", body: '{}' }); }
    else await route.fulfill({ response });
  });
  const dialog = await openReason(page, item.key, "detail", true);
  await dialog.locator("textarea").fill("No longer needed, with evidence");
  await dialog.locator('input[type="file"]').setInputFiles([file("first.txt"), file("retry.txt")]);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.locator(".inline-error")).toBeVisible();
  expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).status).toBe("pending_verification");
  failUpload = false;
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.locator("textarea")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog.locator("textarea")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(dialog.locator("textarea")).toBeVisible();
  release();
  await expect(dialog.locator("textarea")).toBeEnabled();
  await expect(dialog.locator(".inline-error")).toBeVisible();
  await expect(dialog.locator("textarea")).toHaveValue("No longer needed, with evidence");
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
  expect(uploads).toEqual(["first.txt", "retry.txt", "retry.txt"]);
  const timeline = await (await request.get(`/api/v1/items/${item.key}/timeline`)).json();
  expect(timeline.events.filter((event: { payload: { attachmentIds?: string[] } }) => event.payload.attachmentIds?.length)).toHaveLength(1);
});

test("batch return applies evidence per item, keeps partial results and only retries failed items", async ({ page, request }) => {
  const items = await Promise.all([create(request, "in_progress"), create(request, "in_progress")]);
  const writes = new Map<string, number>();
  let fail = true;
  for (const item of items) await page.route(`**/items/${item.key}/transitions`, async route => {
    writes.set(item.key, (writes.get(item.key) ?? 0) + 1);
    if (item.key === items[1].key && fail) await route.fulfill({ status: 503, contentType: "application/json", body: '{}' });
    else await route.continue();
  });
  await page.goto(`/?product=${fixture.productId}&status=in_progress`);
  for (const item of items) await page.locator(".item-row").filter({ hasText: item.key }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "还原为待处理（2）", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("Wrong machine, retry elsewhere");
  await dialog.locator('input[type="file"]').setInputFiles(file("batch.txt"));
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.locator(".transition-results")).toContainText("已退回");
  await expect(dialog.locator("textarea")).toBeDisabled();
  await expect(dialog.locator(".transition-results")).toContainText(items[1].key);
  fail = false;
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
  expect(writes.get(items[0].key)).toBe(1);
  expect(writes.get(items[1].key)).toBe(2);
  for (const item of items) {
    const stored = await (await request.get(`/api/v1/items/${item.key}`)).json();
    expect(stored.status).toBe("ready");
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0].transitionEventId).toBeTruthy();
  }
});

test("paste and drop stage evidence, reject unsupported files, and explicit cancel discards local files", async ({ page, request }) => {
  const item = await create(request);
  const dialog = await openReason(page, item.key);
  await dialog.locator('input[type="file"]').setInputFiles(file("unsupported.exe"));
  await expect(dialog.locator(".inline-error")).toBeVisible();
  await expect(dialog.locator(".agent-chat-draft-files")).toHaveCount(0);
  await dialog.locator("textarea").evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), value => value.charCodeAt(0))], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(dialog.locator(".agent-chat-draft-files img")).toBeVisible();
  const preview = page.getByRole("button", { name: "预览 pasted.png", exact: true });
  await preview.click();
  await expect(page.locator(".selected-media-lightbox .zoomable-image")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".selected-media-lightbox")).toHaveCount(0);
  await expect(preview).toBeFocused();
  await expect(dialog.locator("textarea")).toBeVisible();
  await dialog.locator("form").evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["Dropped text"], "dropped.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
  });
  await expect(dialog.locator(".agent-chat-draft-files")).toContainText("dropped.txt");
  await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).attachments).toHaveLength(0);
});

for (const theme of ["light", "dark"] as const) test.describe(`reason layout ${theme}`, () => {
  test.use({ colorScheme: theme, hasTouch: true, isMobile: true });
  test("reason layout retains controls with three font sizes, long filenames and many files", async ({ page, request }) => {
    const item = await create(request);
    const dialog = await openReason(page, item.key);
    await dialog.locator("textarea").fill("Long reason / 较长的原因说明\n".repeat(20));
    await dialog.locator('input[type="file"]').setInputFiles(Array.from({ length: 10 }, (_, index) => file(`${index}-很长的附件名称-with-a-long-English-description-that-must-not-hide-the-remove-button.txt`)));
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 900 });
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        await expect(dialog.getByRole("button", { name: "添加附件", exact: true })).toBeDisabled();
        for (const button of [dialog.locator('button[type="submit"]'), dialog.getByRole("button", { name: /^移除 / }).last()]) {
          await button.scrollIntoViewIfNeeded(); await expectUsableControl(button);
        }
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        for (const element of await dialog.locator("label, p, button").all()) {
          if (await element.isVisible()) expect(await element.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(11);
        }
      }
    }
  });
});
