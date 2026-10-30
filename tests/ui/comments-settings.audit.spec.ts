import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWOQS1lAU8QwakHKaBAtGE1FcqMZbcFoUSE3WpqmjFY4cqNVZsrgblUAADLVZi7SZ5y7AAAAAElFTkSuQmCC", "base64");

for (const width of [353, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} comments and settings`, () => {
    test.use({ viewport: { width, height: 800 }, colorScheme: theme, hasTouch: width < 1440 });
    test("posts attachment-only comments, preserves association after reload, and centers settings title", async ({ page }) => {
      const response = await page.request.post("/api/v1/items", { data: { productId: fixture.productId,
        type: "requirement", priority: "normal", title: "Comment attachments", description: "", environment: { platform: "web" } } });
      expect(response.ok()).toBe(true);
      const item = await response.json();
      await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
      const composer = page.locator(".comment-form");
      const send = composer.getByRole("button", { name: "发表评论", exact: true });
      await expect(send).toBeDisabled();
      await composer.locator('input[type="file"]').first().setInputFiles([
        { name: "comment.png", mimeType: "image/png", buffer: png },
        { name: "comment.txt", mimeType: "text/plain", buffer: Buffer.from("file evidence") },
      ]);
      await expect(composer.locator(".comment-image-previews img")).toHaveCount(1);
      await expect(send).toBeEnabled();
      await send.click();
      await expect(composer.locator(".selected-files")).toHaveCount(0);
      const comment = page.locator(".comment-body").filter({ hasText: "comment.txt" });
      await expect(comment.locator(".attachment-card")).toHaveCount(2);
      await expect(comment.locator(".attachment-image img")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("comment-attachments.png") });
      await page.reload();
      await expect(comment.locator(".attachment-card")).toHaveCount(2);
      await expect(page.locator(".detail-back-button")).toHaveAccessibleName("返回列表");
      await page.goto("/settings");
      const heading = await page.locator(".settings-page-header > strong").boundingBox();
      const header = await page.locator(".settings-page-header").boundingBox();
      expect(Math.abs(heading!.x + heading!.width / 2 - header!.x - header!.width / 2)).toBeLessThanOrEqual(1);
      const back = page.locator(".settings-page-header .back-button");
      await expect(back).toHaveText("");
      const box = await back.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
      const groups = page.locator(".settings-nav-group");
      expect(await groups.count()).toBeGreaterThanOrEqual(2);
      expect(await groups.first().evaluate(el => Number.parseFloat(getComputedStyle(el).borderRadius))).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("settings-groups.png") });
    });
  });
}

test("retains a failed comment and retries without duplicating uploaded files or a committed comment", async ({ page }) => {
  const response = await page.request.post("/api/v1/items", { data: { productId: fixture.productId,
    type: "note", priority: "normal", title: "Retry a comment", description: "", environment: { platform: "web" } } });
  const item = await response.json();
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  const composer = page.locator(".comment-form");
  const send = composer.getByRole("button", { name: "发表评论", exact: true });
  await composer.getByRole("textbox").fill("Keep my draft");
  await composer.locator('input[type="file"]').first().setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry evidence") });
  let lost = false;
  await page.route(`**/api/v1/items/${item.key}/comments`, async route => {
    if (!lost && route.request().method() === "POST") { lost = true; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await send.click();
  await expect(composer.getByRole("textbox")).toHaveValue("Keep my draft");
  await expect(composer.locator(":scope > .inline-error")).toBeVisible();
  await expect(send).toBeEnabled(); await send.click();
  await expect(composer.getByRole("textbox")).toHaveValue("");
  const comments = await (await page.request.get(`/api/v1/items/${item.key}/comments`)).json();
  const attachments = await (await page.request.get(`/api/v1/items/${item.key}/attachments`)).json();
  expect(comments.comments).toHaveLength(1); expect(attachments.attachments).toHaveLength(1);
});


test("accepts pasted images and dropped files, rejects unsupported files, and survives a lost upload response", async ({ page }) => {
  const response = await page.request.post("/api/v1/items", { data: { productId: fixture.productId,
    type: "note", priority: "normal", title: "Paste and drop", description: "", environment: { platform: "web" } } });
  const item = await response.json();
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  const composer = page.locator(".comment-form");
  await composer.getByRole("textbox").evaluate((el, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  const data = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(["evidence"], "dropped.txt", { type: "text/plain" })); return transfer; });
  await composer.dispatchEvent("drop", { dataTransfer: data });
  await expect(composer.locator(".selected-files")).toContainText("pasted.png");
  await expect(composer.locator(".selected-files")).toContainText("dropped.txt");
  await composer.locator('input[type="file"]').first().setInputFiles({ name: "unsupported.exe", mimeType: "application/octet-stream", buffer: Buffer.from("data") });
  await expect(composer.locator(".inline-error")).toBeVisible();
  await expect(composer.locator(".selected-files")).not.toContainText("unsupported.exe");
  let lost = false;
  await page.route(`**/api/v1/items/${item.key}/attachments`, async route => {
    if (!lost && route.request().method() === "POST") { lost = true; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  const send = composer.getByRole("button", { name: "发表评论", exact: true });
  await send.click();
  await expect(composer.locator(":scope > .inline-error")).toBeVisible();
  await expect(send).toBeEnabled(); await send.click();
  await expect(composer.locator(".selected-files")).toHaveCount(0);
  const comments = await (await page.request.get(`/api/v1/items/${item.key}/comments`)).json();
  const attachments = await (await page.request.get(`/api/v1/items/${item.key}/attachments`)).json();
  expect(comments.comments).toHaveLength(1); expect(attachments.attachments).toHaveLength(2);
});
