import { readFileSync } from "node:fs";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { postItemCommand } from "./item-command";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWOQS1lAU8QwakHKaBAtGE1FcqMZbcFoUSE3WpqmjFY4cqNVZsrgblUAADLVZi7SZ5y7AAAAAElFTkSuQmCC", "base64");
const note = "已发包状态未变更，需要核对附件。Long state reason with wrapping. ".repeat(8);

async function seed(page: Page) {
  const created = await page.request.post("/api/v1/items", { data: { productId: fixture.productId, title: "状态与评论时间线排版", description: "仅本地回归", type: "bug", priority: "normal", status: "ready", environment: { platform: "web" } } });
  expect(created.ok()).toBe(true);
  const item = await created.json();
  const files: { id: string; filename: string }[] = [];
  for (let index = 0; index < 8; index++) {
    const filename = index === 7 ? "evidence.txt" : `image-${index}.png`;
    const uploaded = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": index === 7 ? "text/plain" : "image/png", "x-missiongo-filename": filename }, data: index === 7 ? Buffer.from("State reason evidence") : png });
    expect(uploaded.ok()).toBe(true);
    files.push(await uploaded.json());
  }
  const commentResponse = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "已发包，但状态没有流转。", attachmentIds: [files[0]!.id] } });
  expect(commentResponse.ok()).toBe(true);
  const comment = await commentResponse.json();
  expect((await postItemCommand(page.request, `/api/v1/items/${item.key}/transitions`, { data: { to: "cancelled", reason: "cancelled", note, attachmentIds: files.slice(1).map(file => file.id) } })).ok()).toBe(true);
  const notices = (await (await page.request.get("/api/v1/notifications")).json()).notifications;
  const decision = notices.find((entry: { itemKey: string; kind: string }) => entry.itemKey === item.key && entry.kind === "decision");
  expect(decision.businessEventId).toBeTruthy();
  return { item, comment, decision };
}

async function verifyLayout(scope: Locator) {
  const status = scope.locator(".timeline-event").filter({ has: scope.page().locator(".timeline-note", { hasText: "已发包状态未变更" }) });
  const comment = scope.locator(".timeline-event--comment").filter({ hasText: "已发包，但状态没有流转。" });
  await expect(status).toHaveCount(1);
  await expect(status.locator(".attachment-block")).toHaveCount(0);
  await expect(status.locator(".comment-attachments")).toHaveCount(1);
  const textStyle = (locator: Locator) => locator.evaluate(node => { const s = getComputedStyle(node); return { size: s.fontSize, color: s.color, height: s.lineHeight }; });
  expect(await textStyle(status.locator(".timeline-note"))).toEqual(await textStyle(comment.locator(".comment-text p")));
  const size = (locator: Locator) => locator.evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  const thumbnailSize = await size(status.locator(".comment-attachment-tile.is-media").first());
  expect(thumbnailSize).toEqual(await size(comment.locator(".comment-attachment-tile.is-media")));
  expect(thumbnailSize.height).toBe(thumbnailSize.width);
  await expect(status.locator(".comment-attachments-more")).toBeVisible();
  expect(await status.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  return { status, comment };
}

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) test.describe(`AND-529 ${width}px ${theme}`, () => {
  test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, colorScheme: theme });
  test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-11-16T03:00:00Z")); });
  test("shares compact attachments, body typography and separated focused bounds in both detail entries", async ({ page }, testInfo) => {
    const { item, comment, decision } = await seed(page);
    await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}&item=${item.key}`);
    const workspace = page.locator(".detail-pane");
    await expect(workspace.locator(`#comment-${comment.id}`)).toBeVisible();
    // Both entries render the same original item, with notification navigation
    // adding focus without mutating the workspace selection.
    await workspace.getByRole("button", { name: "全部动态", exact: true }).click();
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      await verifyLayout(workspace);
    }
    // The phone detail deliberately hides the workspace topbar; return to the
    // list before opening the global attention entry.
    await page.goto(`/?product=${fixture.productId}&status=all&q=${item.key}`);
    await page.getByRole("button", { name: "待处理", exact: true }).click();
    const center = page.locator(".message-center-layer");
    await center.getByRole("button", { name: /^通知/ }).click();
    await center.locator(".message-list-row").filter({ hasText: item.key }).filter({ hasText: "业务决策" }).click();
    const detail = center.locator(".message-detail-pane .detail-pane");
    const target = detail.locator(`[data-event-id="${decision.businessEventId}"]`);
    await expect(target).toBeFocused();
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      const { status, comment: commentEvent } = await verifyLayout(detail);
      const bounds = await status.evaluate(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return { bottom: r.bottom, padding: s.paddingBottom, margin: s.marginBottom, outlineOffset: s.outlineOffset }; });
      expect(bounds.padding).toBe("0px");
      expect(bounds.margin).toBe("12px");
      expect(bounds.outlineOffset).toBe("-2px");
      expect((await commentEvent.boundingBox())!.y - bounds.bottom).toBeGreaterThanOrEqual(11);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // Preview returns to the same attachment, and leaves the reading surface intact.
    const preview = target.locator(".comment-attachment-tile.is-media").first();
    await preview.scrollIntoViewIfNeeded();
    await expect(preview.locator("img")).toBeVisible();
    await expect.poll(() => preview.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("focused-timeline.png") });
    await preview.click();
    await expect(page.locator(".selected-media-lightbox .zoomable-image")).toBeVisible();
    const downloadButton = page.locator(".selected-media-lightbox").getByRole("button", { name: /^下载 image-/ });
    const download = page.waitForEvent("download");
    await downloadButton.click();
    expect((await download).suggestedFilename()).toBe("image-1.png");
    await page.keyboard.press("Escape");
    await expect(preview).toBeFocused();
    await target.locator(".comment-attachments-more").click();
    const gallery = page.getByRole("dialog", { name: "附件", exact: true });
    await expect(gallery).toContainText("evidence.txt");
    await page.keyboard.press("Escape");
    await expect(center).toBeVisible();
    await detail.locator(".detail-composer textarea").fill("保留通知详情草稿");
    await preview.click();
    await page.keyboard.press("Escape");
    await expect(detail.locator(".detail-composer textarea")).toHaveValue("保留通知详情草稿");
  });
});
