import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWOQS1lAU8QwakHKaBAtGE1FcqMZbcFoUSE3WpqmjFY4cqNVZsrgblUAADLVZi7SZ5y7AAAAAElFTkSuQmCC", "base64");
const longName = "Codex · 一台名字很长的开发设备-".repeat(5);

for (const viewport of [{ width: 353, height: 850 }, { width: 812, height: 375 }, { width: 1440, height: 900 }]) {
  for (const theme of ["light", "dark"] as const) {
    test(`comment axes, long names and overflow evidence at ${viewport.width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      const created = await page.request.post("/api/v1/items", { data: {
        productId: fixture.productId, type: "note", priority: "normal", title: "评论时间轴与附件收纳", description: "", environment: { platform: "web" },
      } });
      expect(created.ok()).toBe(true);
      const item = await created.json();
      const attachmentIds: string[] = [];
      // Exercise rendering and downloads for all supported kinds, without playing synthetic video.
      const files = [
        ["first.png", "image/png", png], ["second.png", "image/png", png],
        ["evidence.txt", "text/plain", Buffer.from("readable evidence")],
        ["diagnostics.log", "text/plain", Buffer.from("test diagnostic log")],
        ["report.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF")],
        ["bundle.zip", "application/zip", Buffer.from("504b0506000000000000000000000000000000000000", "hex")],
        ["clip.mp4", "video/mp4", Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex")],
        ["last.txt", "text/plain", Buffer.from("last evidence")],
      ] as const;
      for (const [filename, type, data] of files) {
        const uploaded = await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: {
          "content-type": "application/octet-stream", "x-missiongo-content-type": type, "x-missiongo-filename": filename,
        }, data });
        expect(uploaded.ok(), await uploaded.text()).toBe(true);
        attachmentIds.push((await uploaded.json()).id);
      }
      const posted = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "这是含有多种附件的评论。", attachmentIds } });
      expect(posted.ok()).toBe(true);
      const rootComment = await posted.json();
      const replyUpload=await page.request.post(`/api/v1/items/${item.key}/attachments`, { headers: {
        "content-type":"application/octet-stream", "x-missiongo-content-type":"text/plain", "x-missiongo-filename":"reply.txt",
      },data:"reply evidence"});
      expect(replyUpload.ok()).toBe(true);
      const replyAttachment=await replyUpload.json();
      const replied=await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "这是一条回复。", replyToCommentId: rootComment.id, attachmentIds: [replyAttachment.id] } });
      expect(replied.ok(),await replied.text()).toBe(true);
      await page.route(`**/api/v1/items/${item.key}/timeline`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.events = body.events.map((event: { eventType: string; payload: object }) => event.eventType === "comment_added"
          ? { ...event, actorKind: "agent", payload: { ...event.payload, agentName: longName } } : event);
        await route.fulfill({ response, json: body });
      });
      await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
      const root = page.locator(`#comment-${rootComment.id}`);
      const strip = root.locator(".comment-attachment-strip");
      await strip.scrollIntoViewIfNeeded();
      await expect(root.locator(".comment-attachment-thumb img").first()).toBeVisible();
      const tiles = strip.locator(".comment-attachment-tile");
      const boxes = await tiles.evaluateAll(elements => elements.map(el => { const b = el.getBoundingClientRect(); return { y: b.y, right: b.right }; }));
      expect(boxes.length).toBeGreaterThan(1);
      expect(boxes.length).toBeLessThan(files.length);
      expect(new Set(boxes.map(box => box.y)).size).toBe(1);
      const stripBox = (await strip.boundingBox())!;
      expect(Math.max(...boxes.map(box => box.right))).toBeLessThanOrEqual(stripBox.x + stripBox.width + 1);
      expect(stripBox.height).toBeLessThan(100);
      const header = root.locator(".comment-byline");
      // AND-346: identity now has an author row and a metadata row; reply and
      // secondary actions stay together at the top right of that identity.
      const authorBox = (await header.locator(":scope > strong").boundingBox())!;
      const timeBox = (await header.locator("time").boundingBox())!;
      const headerBox = (await header.boundingBox())!;
      const actionsBox = (await root.locator(".comment-header-actions").boundingBox())!;
      expect(timeBox.y).toBeGreaterThanOrEqual(authorBox.y + authorBox.height - 1);
      expect(Math.abs(actionsBox.y - headerBox.y)).toBeLessThan(2);
      expect(actionsBox.x).toBeGreaterThanOrEqual(headerBox.x + headerBox.width);
      const rights = await header.locator(":scope > *").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().right));
      expect(Math.max(...rights)).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
      const name = root.locator(".comment-author-name");
      expect(await name.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await name.click();await expect(page.getByRole("dialog")).toContainText(longName);await page.keyboard.press("Escape");await expect(name).toBeFocused();
      const axis = await root.locator(".comment-avatar").evaluate(el => {
        const event=el.closest(".timeline-event")!,dot=document.querySelector(".timeline-event:not(.timeline-event--comment) .timeline-dot")!;
        const a=el.getBoundingClientRect(),b=dot.getBoundingClientRect(),e=event.getBoundingClientRect(),style=getComputedStyle(event,"::before");
        return { avatar:a.x+a.width/2,dot:b.x+b.width/2,line:e.x+parseFloat(style.left)+0.5,display:style.display };
      });
      expect(Math.abs(axis.avatar-axis.dot)).toBeLessThanOrEqual(1);expect(Math.abs(axis.avatar-axis.line)).toBeLessThanOrEqual(1);expect(axis.display).not.toBe("none");
      await root.getByRole("button",{name:"预览 first.png",exact:true}).click();await expect(page.locator(".selected-media-lightbox img")).toBeVisible();await page.keyboard.press("Escape");
      const more=root.locator(".comment-attachments-more");await more.click();
      const dialog=page.getByRole("dialog");await expect(dialog.locator(".attachment-card")).toHaveCount(files.length);
      await dialog.getByRole("button",{name:"预览 first.png",exact:true}).click();
      await expect(page.locator(".selected-media-lightbox img")).toBeVisible();await page.keyboard.press("Escape");await expect(dialog).toBeVisible();
      await dialog.locator(".attachment-document").filter({hasText:"evidence.txt"}).getByRole("button",{name:/加载预览|Load preview/}).click();
      await expect(dialog.locator(".attachment-document pre")).toHaveText("readable evidence");
      const downloaded=page.waitForEvent("download");await dialog.getByRole("button",{name:"下载 bundle.zip",exact:true}).click();expect((await downloaded).suggestedFilename()).toBe("bundle.zip");
      await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(more).toBeFocused();
      const reply=page.locator(".comment-thread-reply");await expect(reply.locator(".comment-attachment-tile")).toHaveCount(1);
      const replyAuthor=reply.locator(".comment-reply-author");expect((await replyAuthor.boundingBox())!.height).toBeLessThanOrEqual(44);
      await replyAuthor.click();await expect(page.getByRole("dialog")).toContainText(longName);await page.keyboard.press("Escape");

      await strip.scrollIntoViewIfNeeded();await page.screenshot({path:test.info().outputPath(`comment-layout-${viewport.width}-${theme}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.getByRole("button",{name:"讨论",exact:true}).click();await expect(root).toBeVisible();await expect(root.locator(".comment-attachments-more")).toBeVisible();
    });
  }
}
