import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectUsableControl } from "./visible-control";
import { solidPng } from "../../scripts/seed-ui-fixture.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = solidPng(640, 360, [214, 226, 240]);
const image = { name: "draft-image.png", mimeType: "image/png", buffer: png };

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`AND-376 ${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 320, isMobile: width === 320 });

    test("comment images preview before and after sending without losing the draft", async ({ page, request }) => {
      const response = await request.post("/api/v1/items", { data: {
        productId: fixture.productId, title: "Draft image preview regression", description: "",
        type: "bug", priority: "normal", status: "ready", environment: { platform: "web" },
      } });
      expect(response.ok()).toBeTruthy();
      const item = await response.json() as { key: string };
      await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
      const composer = page.locator(".detail-composer");
      await composer.locator("textarea").fill("Preview keeps my draft");
      await composer.locator('input[type="file"]').setInputFiles(image);
      const preview = composer.getByRole("button", { name: "预览 draft-image.png", exact: true });
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        await expectUsableControl(preview, width === 320);
        if (width === 1440) { await preview.focus(); await page.keyboard.press("Enter"); }
        else await preview.tap();
        const lightbox = page.locator(".selected-media-lightbox");
        await expect(lightbox.locator(".zoomable-image img")).toHaveAttribute("alt", image.name);
        await expect.poll(() => lightbox.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
        await lightbox.getByRole("button", { name: "放大图片", exact: true }).click();
        await expect(lightbox.locator(".zoomable-image")).toHaveAttribute("data-zoomed", "true");
        if (scale === "large") await page.screenshot({ path: test.info().outputPath("draft-image-preview.png") });
        if (scale === "small") await page.keyboard.press("Escape");
        else if (scale === "medium") await page.evaluate(() => history.back());
        else await lightbox.getByRole("button", { name: "关闭预览", exact: true }).click();
        await expect(lightbox).toHaveCount(0);
        await expect(preview).toBeFocused();
        await expect(composer.locator("textarea")).toHaveValue("Preview keeps my draft");
        await expect(composer.locator(".agent-chat-draft-file")).toHaveCount(1);
      }
      await page.reload();
      await expect(composer.locator("textarea")).toHaveValue("Preview keeps my draft");
      await expect(composer.getByRole("status")).toContainText("上次选择的附件未恢复，请重新选择。");
      await composer.locator('input[type="file"]').setInputFiles(image);
      await expect(preview).toBeVisible();
      await composer.getByRole("button", { name: "移除 draft-image.png", exact: true }).click();
      await expect(preview).toHaveCount(0);
      await expect(composer.locator("textarea")).toHaveValue("Preview keeps my draft");
      await composer.locator('input[type="file"]').setInputFiles(image);
      await composer.locator('button[type="submit"]').click();
      await expect(composer.locator(".agent-chat-draft-file")).toHaveCount(0);
      await page.locator(".comment-attachment-tile").click();
      await expect(page.locator(".selected-media-lightbox .zoomable-image")).toBeVisible();
      await expect.poll(() => page.locator(".selected-media-lightbox img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
      await page.keyboard.press("Escape");
      await expect(page.locator(".comment-attachment-tile")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("comment-image.png") });
    });

    test("an undecodable draft image reports failure without discarding the attachment", async ({ page }) => {
      const detail = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { detailKey: string };
      await page.goto(`/?product=${fixture.productId}&status=all&item=${detail.detailKey}`);
      const composer = page.locator(".detail-composer");
      await composer.locator('input[type="file"]').setInputFiles({ ...image, buffer: Buffer.from("invalid image") });
      await expect.poll(() => composer.locator(".agent-chat-draft-file img").count()).toBe(0);
      await composer.getByRole("button", { name: "预览 draft-image.png", exact: true }).click();
      await expect(page.locator(".selected-media-lightbox").getByRole("alert")).toHaveText("附件加载失败。");
      await page.keyboard.press("Escape");
      await expect(composer.getByRole("button", { name: "移除 draft-image.png", exact: true })).toBeEnabled();
    });
  });
}
