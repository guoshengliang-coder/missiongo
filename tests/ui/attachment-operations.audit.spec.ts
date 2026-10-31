import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const file = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from("operation evidence") });

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`creation, comments and reply files stay with their operation at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/?product=${fixture.productId}&status=all`);
    await page.locator(width < 1024 ? ".mobile-fab" : ".capture-button").click();
    const form = page.locator(".quick-capture-form");
    await form.locator(".ai-title-field input").fill("A creation with files");
    await form.locator(".report-input-block textarea").first().fill("Keep each upload with its operation.");
    await form.locator('input[type="file"][accept*=".txt"]').setInputFiles(file("created.txt"));
    await form.locator('input[type="file"][accept*=".log"]').setInputFiles(file("created.log"));
    await expect(form.locator(".selected-files")).toContainText(["created.txt", "created.log"]);
    const response = page.waitForResponse(response => response.url().endsWith("/api/v1/items") && response.request().method() === "POST");
    await form.getByRole("button", { name: "保存到草稿", exact: true }).click();
    const item = await (await response).json();
    await expect(form).toHaveCount(0);
    await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
    const added = page.locator(".timeline-event").filter({ hasText: "已添加附件" });
    const created = page.locator(".timeline-event").filter({ hasText: "已创建条目" });
    await expect(created.locator(".timeline-files")).toContainText("created.txt");
    await expect(created.locator(".timeline-files")).toContainText("created.log");
    await expect(added).toHaveCount(0);

    const composer = page.locator(".detail-composer");
    await composer.locator("textarea").fill("A comment with files");
    await composer.locator('input[type="file"]').first().setInputFiles([file("comment.txt"), file("comment.log")]);
    await composer.getByRole("button", { name: "发送", exact: true }).click();
    await expect(composer.locator("textarea")).toHaveValue("");
    const root = page.locator(".comment-discussion").filter({ hasText: "A comment with files" });
    await expect(root.locator(".attachment-card")).toHaveCount(2);
    await expect(added).toHaveCount(0);
    await root.getByRole("button", { name: "回复", exact: true }).click();
    await composer.locator("textarea").fill("A reply with a file");
    await composer.locator('input[type="file"]').first().setInputFiles(file("reply.txt"));
    await composer.getByRole("button", { name: "发送", exact: true }).click();
    await expect(root.locator(".comment-thread-reply .attachment-card")).toHaveCount(1);
    await expect(added).toHaveCount(0);
    await page.reload();
    await expect(root.locator(".attachment-card")).toHaveCount(3);
    await expect(added).toHaveCount(0);

    // An upload outside creation/comment remains an independent operation.
    const uploaded = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: {
      "content-type": "application/octet-stream", "x-missiongo-content-type": "text/plain", "x-missiongo-filename": "standalone.txt",
    }, data: "standalone" });
    expect(uploaded.ok()).toBe(true);
    await page.reload();
    await expect(added).toHaveCount(1);
    await expect(added).toContainText("standalone.txt");
    const comments = await (await page.request.get(`/api/v1/items/${item.key}/comments`)).json();
    expect((await page.request.post(`/api/v1/items/${item.key}/comments/${comments.comments[1].id}/withdraw`)).ok()).toBe(true);
    await page.reload();
    await expect(root.locator(".comment-withdrawn")).toBeVisible();
    await expect(added).toHaveCount(1); // The withdrawn reply must not leak a new upload row.
    await created.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`operation-timeline-${width}-${theme}.png`) });
  });
}
