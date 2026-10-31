import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWOQS1lAU8QwakHKaBAtGE1FcqMZbcFoUSE3WpqmjFY4cqNVZsrgblUAADLVZi7SZ5y7AAAAAElFTkSuQmCC", "base64");

for (const width of [353, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`mixed comments keep readable prose above compact files at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const response = await page.request.post("/api/v1/items", { data: {
      productId: fixture.productId, type: "note", priority: "normal", title: "Mixed comment layout", description: "", environment: { platform: "web" },
    } });
    const item = await response.json();
    const prose = "文字应该正常横向阅读，图片与其他文件紧凑展示在下面。";
    for (const text of [prose, "这是折叠评论。".repeat(100), ""]) {
      const attachments: { id: string }[] = [];
      for (const [name, type, data] of [
        ["comment.png", "image/png", png],
        ["很长的附件名称-".repeat(12) + ".txt", "text/plain", Buffer.from("file evidence")],
      ] as const) {
        const uploaded = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: {
          "content-type": "application/octet-stream", "x-missiongo-content-type": type, "x-missiongo-filename": encodeURIComponent(name),
        }, data });
        expect(uploaded.ok()).toBe(true);
        attachments.push(await uploaded.json());
      }
      const posted = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text, attachmentIds: attachments.map(a => a.id) } });
      expect(posted.ok(), await posted.text()).toBe(true);
    }
    await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
    const comment = page.locator(".comment-body").filter({ hasText: prose });
    await comment.scrollIntoViewIfNeeded();
    const textBox = (await comment.locator(".comment-text").boundingBox())!;
    const fileBox = (await comment.locator(".comment-attachments").boundingBox())!;
    expect(fileBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
    expect(textBox.width).toBeGreaterThan(width === 353 ? 220 : 350);
    await expect(comment.locator(".attachment-card")).toHaveCount(2);
    await expect(comment.locator(".attachment-image img")).toBeVisible();
    expect((await comment.locator(".attachment-image img").boundingBox())!.height).toBeLessThanOrEqual(112);
    await expect(comment.locator(".attachment-document .attachment-preview")).toHaveCount(0);
    await comment.getByRole("button", { name: "预览 comment.png", exact: true }).click();
    await expect(page.locator(".selected-media-lightbox img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".selected-media-lightbox")).toHaveCount(0);
    await comment.locator(".attachment-document").getByRole("button", { name: /^预览/ }).click();
    await expect(comment.locator(".attachment-document pre")).toHaveText("file evidence");
    await page.screenshot({ path: testInfo.outputPath(`mixed-${width}-${theme}.png`) });
    const folded = page.locator(".comment-collapsible").filter({ hasText: "这是折叠评论" });
    await folded.locator("summary").click();
    await expect(folded.locator(".comment-attachments .attachment-card")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
