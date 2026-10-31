import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

async function createItem(request: APIRequestContext, title = "Bottom composer") {
  const response = await request.post("/api/v1/items", { data: {
    productId: fixture.productId, type: "requirement", priority: "normal", status: "ready", title,
    description: Array.from({ length: 30 }, (_, index) => `Paragraph ${index}: keep the report readable while composing a reply.`).join("\n\n"),
    environment: { platform: "web" },
  } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { key: string };
}

async function openItem(page: Page, key: string) {
  await page.goto(`/?product=${fixture.productId}&status=all&item=${key}`);
  await expect(page.locator(".detail-composer")).toBeVisible();
}

const attachment = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from("Composer evidence") });

for (const viewport of [
  { name: "phone", width: 353, height: 757, touch: true },
  { name: "landscape", width: 812, height: 375, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${viewport.name} ${theme} detail composer`, () => {
    test.use({ viewport, hasTouch: viewport.touch, isMobile: viewport.touch, colorScheme: theme });
    test("stays in the detail pane, stages files and sends text with attachments", async ({ page, request }) => {
      const item = await createItem(request);
      await openItem(page, item.key);
      const composer = page.locator(".detail-composer");
      const send = composer.getByRole("button", { name: "发送", exact: true });
      await expect(send).toBeDisabled();
      // AND-348: an empty composer is one line tall, level with the buttons
      // beside it, and only grows once there is something to show.
      const emptyField = (await composer.locator("textarea").boundingBox())!;
      expect(Math.abs(emptyField.height - (await send.boundingBox())!.height)).toBeLessThanOrEqual(1);
      await composer.locator("textarea").fill("第一行\n第二行");
      expect((await composer.locator("textarea").boundingBox())!.height).toBeGreaterThan(emptyField.height);
      await composer.locator("textarea").fill("");
      expect(Math.abs((await composer.locator("textarea").boundingBox())!.height - emptyField.height)).toBeLessThanOrEqual(1);
      const initial = (await composer.boundingBox())!;
      expect(initial.x).toBeGreaterThanOrEqual(0);
      expect(initial.y + initial.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.locator(".detail-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
      const afterScroll = (await composer.boundingBox())!;
      expect(afterScroll.y).toBeCloseTo(initial.y, 0);
      const scroller = (await page.locator(".detail-scroll").boundingBox())!;
      expect(scroller.y + scroller.height).toBeLessThanOrEqual(afterScroll.y + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (viewport.touch) {
        expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await composer.getByRole("button", { name: "添加附件", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await composer.locator('input[type="file"]').first().setInputFiles(attachment("remove-me.txt"));
      await composer.getByRole("button", { name: "移除 remove-me.txt", exact: true }).click();
      await expect(send).toBeDisabled();
      await composer.locator("textarea").fill(`Reply from ${viewport.name} ${theme}`);
      await composer.locator('input[type="file"]').first().setInputFiles(attachment("evidence.txt"));
      expect((await (await request.get(`/api/v1/items/${item.key}`)).json()).attachments).toHaveLength(0);
      await page.screenshot({ path: test.info().outputPath("composer.png") });
      await send.click();
      await expect(composer.locator("textarea")).toHaveValue("");
      await expect(composer.locator(".agent-chat-draft-files")).toHaveCount(0);
      await expect(send).toBeDisabled();
      await expect(page.locator(".timeline")).toContainText(`Reply from ${viewport.name} ${theme}`);
      const stored = await (await request.get(`/api/v1/items/${item.key}`)).json();
      expect(stored.attachments.map((file: { filename: string }) => file.filename)).toEqual(["evidence.txt"]);
    });
  });
}

test("retries failed files without re-uploading successful parts", async ({ page, request }) => {
  const item = await createItem(request);
  let comments = 0;
  const uploads: string[] = [];
  let fail = true;
  await page.route(`**/api/v1/items/${item.key}/comments`, async route => {
    if (route.request().method() === "POST") comments++;
    await route.continue();
  });
  await page.route(`**/api/v1/items/${item.key}/attachments`, async route => {
    const filename = decodeURIComponent(route.request().headers()["x-missiongo-filename"]);
    uploads.push(filename);
    if (filename === "retry.txt" && fail) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary upload failure" }) });
    } else await route.continue();
  });
  await openItem(page, item.key);
  const composer = page.locator(".detail-composer");
  await composer.locator("textarea").fill("Only one copy of this reply");
  await composer.locator('input[type="file"]').first().setInputFiles([attachment("success.txt"), attachment("retry.txt")]);
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.locator(".inline-error")).toBeVisible();
  await expect(composer.locator("textarea")).toHaveValue("Only one copy of this reply");
  expect(comments).toBe(0);
  await expect(composer.locator(".agent-chat-draft-files")).toContainText("retry.txt");
  await expect(composer.locator(".detail-composer-hint")).toContainText("重试不会重复上传");
  fail = false;
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.locator(".agent-chat-draft-files")).toHaveCount(0);
  await expect(composer.locator(".inline-error")).toHaveCount(0);
  expect(comments).toBe(1);
  expect(uploads).toEqual(["success.txt", "retry.txt", "retry.txt"]);
});

test("retains failed text while reusing a successfully uploaded attachment", async ({ page, request }) => {
  const item = await createItem(request);
  let fail = true;
  let uploads = 0;
  await page.route(`**/api/v1/items/${item.key}/comments`, async route => {
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary comment failure" }) });
    else await route.continue();
  });
  page.on("request", request => { if (request.url().endsWith(`/items/${item.key}/attachments`) && request.method() === "POST") uploads++; });
  await openItem(page, item.key);
  const composer = page.locator(".detail-composer");
  await composer.locator("textarea").fill("Keep this reply for retry");
  await composer.locator('input[type="file"]').first().setInputFiles(attachment("already-sent.txt"));
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.locator(".inline-error")).toBeVisible();
  await expect(composer.locator("textarea")).toHaveValue("Keep this reply for retry");
  await expect(composer.locator(".agent-chat-draft-files")).toContainText("already-sent.txt");
  fail = false;
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.locator("textarea")).toHaveValue("");
  expect(uploads).toBe(1);
});

test("isolates an in-flight send when switching items and keeps controls disabled", async ({ page, request }) => {
  const first = await createItem(request, "First composer item");
  const second = await createItem(request, "Second composer item");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/items/${first.key}/comments`, async route => { await gate; await route.continue(); });
  await openItem(page, first.key);
  const composer = page.locator(".detail-composer");
  await composer.locator("textarea").fill("Send only to the first item");
  await composer.locator('input[type="file"]').first().setInputFiles(attachment("first-only.txt"));
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.locator("textarea")).toBeDisabled();
  await expect(composer.getByRole("button", { name: "移除 first-only.txt", exact: true })).toBeDisabled();
  await page.locator(".item-row").filter({ hasText: "Second composer item" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${second.key}`));
  await composer.locator("textarea").fill("Second item's independent draft");
  release();
  await expect.poll(async () => (await (await request.get(`/api/v1/items/${first.key}`)).json()).attachments.length).toBe(1);
  await expect(composer.locator("textarea")).toHaveValue("Second item's independent draft");
  expect((await (await request.get(`/api/v1/items/${second.key}`)).json()).attachments).toHaveLength(0);
});

test("fits a keyboard-shrunken visual viewport and rejects unsupported files", async ({ page, request }) => {
  const item = await createItem(request);
  await page.setViewportSize({ width: 353, height: 757 });
  await openItem(page, item.key);
  const composer = page.locator(".detail-composer");
  await composer.locator('input[type="file"]').first().setInputFiles(attachment("unsupported.exe"));
  await expect(composer.locator(".inline-error")).toContainText("unsupported.exe");
  await expect(composer.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await composer.locator("textarea").focus();
  // Browser emulation has no native IME: exercise the visualViewport event
  // path explicitly, then also cover a browser that resizes its layout viewport.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => { const box = (await composer.boundingBox())!; return Math.round(box.y + box.height); }).toBeLessThanOrEqual(420);
  await page.screenshot({ path: test.info().outputPath("keyboard-viewport.png") });
  await page.setViewportSize({ width: 353, height: 420 });
  await expect(composer.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});
