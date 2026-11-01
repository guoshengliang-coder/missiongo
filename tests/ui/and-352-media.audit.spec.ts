import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWOQS1lAU8QwakHKaBAtGE1FcqMZbcFoUSE3WpqmjFY4cqNVZsrgblUAADLVZi7SZ5y7AAAAAElFTkSuQmCC", "base64");
async function seed(page: Page) {
  const item = await (await page.request.post("/api/v1/items", { data: { productId: fixture.productId, type: "note", priority: "normal", title: "Compact evidence", description: "Media ownership", environment: { platform: "web" } } })).json();
  const files = [];
  for (const name of ["original.png", "another.png", "comment.png", "reply.txt"]) {
    const response = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": name.endsWith("png") ? "image/png" : "text/plain", "x-missiongo-filename": name }, data: name.endsWith("png") ? png : Buffer.from("reply evidence") });
    expect(response.ok(), await response.text()).toBe(true); files.push(await response.json());
  }
  const root = await (await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "Attached to root", attachmentIds: [files[2].id] } })).json();
  const reply = await (await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "Attached to reply", attachmentIds: [files[3].id], replyToCommentId: root.id } })).json();
  return { item, files, root, reply };
}
for (const width of [375, 724, 844, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`compact tiles, owned comments and image navigation at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : width === 375 ? 812 : width === 724 ? 749 : 900 });
    await page.emulateMedia({ colorScheme: theme });
    const { item, root, reply } = await seed(page);
    await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
    const gallery = page.locator(".attachment-block").filter({ has: page.getByRole("heading", { name: "截图与视频", exact: true }) });
    await expect(gallery.locator(".media-tile")).toHaveCount(2);
    await expect(gallery.locator("footer")).toHaveCount(0);
    const first = gallery.locator(".media-tile").first(), second = gallery.locator(".media-tile").nth(1);
    const box = (await first.boundingBox())!, nextBox = (await second.boundingBox())!;
    expect(Math.abs(box.y - nextBox.y)).toBeLessThan(2);
    expect(box.height).toBeLessThan(180);
    await expect(first.locator(".media-number-badge")).toHaveText("图片 1");
    await expect(page.locator(`#comment-${root.id} .media-number-badge`)).toHaveText("图片 3");
    await expect(page.locator(`#comment-${reply.id} .comment-attachment-tile`)).toHaveCount(1);
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator("img")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`tiles-${width}-${theme}.png`) });
    await first.getByRole("button", { name: "预览 original.png", exact: true }).click();
    const dialog = page.locator(".selected-media-lightbox"), zoom = dialog.locator(".zoomable-image");
    await expect(zoom.locator("img")).toBeVisible();
    await expect(dialog.locator("header strong")).toHaveText("图片 1 · 1/2");
    await dialog.getByRole("button", { name: "放大图片", exact: true }).click();
    await expect(zoom).toHaveAttribute("data-zoomed", "true");
    await dialog.getByRole("button", { name: "适应屏幕", exact: true }).click();
    await expect(zoom).toHaveAttribute("data-zoomed", "false");
    await zoom.locator(".zoomable-image-viewport").hover(); await page.mouse.wheel(0, -300);
    await expect(zoom).toHaveAttribute("data-zoomed", "true");
    await dialog.getByRole("button", { name: "适应屏幕", exact: true }).click();
    await zoom.locator("img").dblclick();
    await expect(zoom).toHaveAttribute("data-zoomed", "true");
    const before = await zoom.locator("img").getAttribute("style");
    const viewport = (await zoom.locator(".zoomable-image-viewport").boundingBox())!;
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.down(); await page.mouse.move(viewport.x + viewport.width / 2 + 60, viewport.y + viewport.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    expect(await zoom.locator("img").getAttribute("style")).not.toBe(before);
    await page.keyboard.press("ArrowRight");
    await expect(dialog.locator("header strong")).toHaveText("图片 2 · 2/2");
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "false");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载 another.png", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("another.png");
    await page.screenshot({ path: test.info().outputPath(`preview-${width}-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.reload(); await expect(gallery.locator(".media-tile")).toHaveCount(2);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const edit = page.locator(".quick-capture-form");
    await expect(edit.locator(".attachment-card")).toHaveCount(2);
    await expect(edit).not.toContainText("comment.png"); await expect(edit).not.toContainText("reply.txt");
    await edit.getByRole("button", { name: "取消", exact: true }).click();
    expect((await page.request.post(`/api/v1/items/${item.key}/comments/${root.id}/withdraw`)).ok()).toBe(true);
    await page.reload(); await expect(gallery.locator(".media-tile")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("pinch, zoomed pan and unzoomed swipe have distinct effects", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, storageState: "./tests/ui/.auth/state.json" });
  const page = await context.newPage();
  try {
    const { item } = await seed(page);
    await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
    await page.locator('.media-tile').getByRole("button", { name: "预览 original.png", exact: true }).click();
    const dialog = page.locator(".selected-media-lightbox");
    await expect(dialog.locator("img")).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const touch = async (type: string, points: { x: number; y: number; id: number }[]) => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      // Let Chromium deliver the frame's coalesced touch events before lifting
      // the fingers. A zero-duration move/end can otherwise omit touchmove.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    };
    await touch("touchStart", [{ x: 140, y: 400, id: 1 }, { x: 240, y: 400, id: 2 }]);
    await touch("touchMove", [{ x: 70, y: 400, id: 1 }, { x: 310, y: 400, id: 2 }]);
    await touch("touchEnd", []);
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "true");
    await touch("touchStart", [{ x: 280, y: 400, id: 1 }]);
    await touch("touchMove", [{ x: 80, y: 400, id: 1 }]); await touch("touchEnd", []);
    await expect(dialog.locator("header strong")).toHaveText("图片 1 · 1/2");
    await dialog.getByRole("button", { name: "适应屏幕", exact: true }).tap();
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "false");
    await touch("touchStart", [{ x: 280, y: 400, id: 1 }]);
    await touch("touchMove", [{ x: 80, y: 400, id: 1 }]); await touch("touchEnd", []);
    await expect(dialog.locator("header strong")).toHaveText("图片 2 · 2/2");
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "false");
    await dialog.getByRole("button", { name: "放大图片", exact: true }).tap();
    await expect(dialog.locator(".image-zoom-controls span")).toHaveText("150%");
    await dialog.getByRole("button", { name: "适应屏幕", exact: true }).tap();
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "false");
    await page.touchscreen.tap(190, 400); await page.touchscreen.tap(190, 400);
    await expect(dialog.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "true");
    await cdp.detach();
  } finally { await context.close(); }
});


test("list evidence excludes comment files and video tiles retain preview/download", async ({ page }) => {
  const { item, files } = await seed(page);
  const uploaded = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: {
    "content-type": "application/octet-stream", "x-missiongo-content-type": "video/mp4", "x-missiongo-filename": "clip.mp4",
  }, data: Buffer.from("synthetic unsupported video") });
  expect(uploaded.ok()).toBe(true);
  await page.goto(`/?product=${fixture.productId}&status=all`);
  const row = page.locator(".item-row").filter({ has: page.getByRole("button", { name: `打开 ${item.key}`, exact: true }) });
  await expect(row.locator(".item-media-thumb")).toHaveCount(3);
  await expect(row.getByRole("button", { name: "预览 comment.png", exact: true })).toHaveCount(0);
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  const tile = page.locator(".media-tile.attachment-video");
  await expect(tile.locator(".media-number-badge")).toHaveText("视频 1");
  await tile.getByRole("button", { name: "预览 clip.mp4", exact: true }).click();
  const dialog = page.locator(".selected-media-lightbox");
  await expect(dialog.locator("header strong")).toHaveText("视频 1 · 3/3");
  await expect(dialog.locator(".video-unplayable")).toBeVisible();
  const download = page.waitForEvent("download"); await dialog.getByRole("button", { name: "下载 clip.mp4", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("clip.mp4"); await page.keyboard.press("Escape");
  // A comment-only item must not acquire evidence thumbnails, even after refresh.
  for (const file of files.slice(0, 2)) expect((await page.request.delete(`/api/v1/items/${item.key}/attachments/${file.id}`)).ok()).toBe(true);
  const clip = await uploaded.json(); expect((await page.request.delete(`/api/v1/items/${item.key}/attachments/${clip.id}`)).ok()).toBe(true);
  await page.goto(`/?product=${fixture.productId}&status=all`);
  await expect(row.locator(".item-media-thumb")).toHaveCount(0);
});
