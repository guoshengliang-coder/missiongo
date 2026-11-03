import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectUsableControl } from "./visible-control";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const viewports = [
  { width: 320, height: 812, touch: true },
  { width: 375, height: 812, touch: true },
  { width: 812, height: 375, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 1180, height: 820, touch: true },
  { width: 1280, height: 800, touch: false },
  { width: 1440, height: 900, touch: false },
];

for (const viewport of viewports) for (const theme of ["light", "dark"] as const) {
  test.describe(`comment cards ${viewport.width}px ${theme}`, () => {
    test.use({ viewport, hasTouch: viewport.touch, colorScheme: theme });
    test("keeps each expanded comment inside its own card and reply at the top right", async ({ page }, testInfo) => {
      const item = await (await page.request.post("/api/v1/items", { data: {
        productId: fixture.productId, type: "note", priority: "normal", title: "评论卡片与全文展开", description: "", environment: { platform: "web" },
      } })).json();
      const text = "请确认卡片边界。\n\n" + "每条评论独立展示，长内容展开后仍在原卡片内。Long comment content remains readable inside the same card.\n\n".repeat(6);
      const post = async (body: object) => {
        const response = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: body });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const root = await post({ text });
      const reply = await post({ text: "我已核对原评论，下面补充检查结果。", replyToCommentId: root.id });
      const analysis = await post({ text });
      // Exercise the actual renderer for a structured AI comment without connecting
      // an agent or sending any real notifications from this disposable fixture.
      await page.route(`**/api/v1/items/${item.key}/timeline`, async route => {
        const response = await route.fetch();
        const data = await response.json();
        for (const event of data.events) {
          if (event.id === root.id) event.accountName = "很长的评论作者名称 Long Author Name ".repeat(4);
          if (event.id === analysis.id) {
            event.actorKind = "agent";
            event.payload = { ...event.payload, agentName: "Codex · 界面验证", bodyKind: "structured", summary: "分析结论：全文应保留在当前卡片内。", body: { understanding: "逐条评论卡片", finding: text, evidence: ["仅使用虚构测试数据"], proposal: "核对展开后的内容边界" } };
          }
        }
        await route.fulfill({ response, json: data });
      });
      await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
      await expect(page.locator(".comment-message")).toHaveCount(3);
      const cards = [root, reply, analysis].map(comment => page.locator(`#comment-${comment.id}`));
      await expect(cards[1]!.locator(".comment-collapsible")).toHaveCount(0);
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        for (const card of cards) {
          const button = card.getByRole("button", { name: "回复", exact: true });
          await button.scrollIntoViewIfNeeded();
          await expectUsableControl(button, viewport.touch);
          await expectUsableControl(card.locator(".comment-author-name"), viewport.touch);
          await expectUsableControl(card.locator(".comment-more-actions > summary"), viewport.touch);
          await expect(button.locator("svg")).toHaveCount(1);
          const geometry = await card.evaluate(node => {
            const message = node.querySelector(".comment-message")!;
            const box = message.getBoundingClientRect();
            const replyBox = node.querySelector(".comment-reply-button")!.getBoundingClientRect();
            const bodyBox = node.querySelector(".comment-body")!.getBoundingClientRect();
            const style = getComputedStyle(message);
            const authorBox = node.querySelector(".comment-author-name")!.getBoundingClientRect();
            const moreBox = node.querySelector(".comment-more-actions > summary")!.getBoundingClientRect();
            const timeBox = node.querySelector(".comment-metadata time")!.getBoundingClientRect();
            const controls = [authorBox, replyBox, moreBox];
            return {
              background: style.backgroundColor, radius: parseFloat(style.borderRadius),
              rightGap: box.right - replyBox.right, aboveBody: replyBox.bottom <= bodyBox.top + 1,
              overflow: message.scrollWidth - message.clientWidth,
              topInset: authorBox.top - box.top - parseFloat(style.borderTopWidth),
              controlTops: controls.map(control => control.top),
              controlBottoms: controls.map(control => control.bottom),
              metadataBelow: timeBox.top >= authorBox.bottom - 1,
              replyGap: parseFloat(getComputedStyle(node).marginBlockStart),
            };
          });
          expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(geometry.radius).toBeGreaterThan(0);
          expect(geometry.aboveBody).toBe(true);
          expect(geometry.rightGap).toBeGreaterThanOrEqual(0);
          expect(geometry.overflow).toBeLessThanOrEqual(1);
          // Measure all three controls, not just the wrapper's top edge: the
          // previous 44px reply beside 36px controls passed that weaker check.
          expect(geometry.topInset).toBeGreaterThanOrEqual(0);
          expect(geometry.topInset).toBeLessThanOrEqual(4);
          expect(Math.max(...geometry.controlTops) - Math.min(...geometry.controlTops)).toBeLessThanOrEqual(1);
          expect(Math.max(...geometry.controlBottoms) - Math.min(...geometry.controlBottoms)).toBeLessThanOrEqual(1);
          expect(geometry.metadataBelow).toBe(true);
          if (card === cards[1]) expect(geometry.replyGap).toBe(14);
          if (card !== cards[1]) {
            const folded = card.locator(".comment-collapsible");
            await expect(folded).not.toHaveAttribute("open", "");
            await expect(folded.locator(".when-closed")).toHaveText("展开全文");
            await folded.locator("summary").click();
            await expect(folded.locator(".comment-content")).toBeVisible();
            const contained = await card.locator(".comment-content").evaluate(node => {
              const content = node.getBoundingClientRect(), card = node.closest(".comment-message")!.getBoundingClientRect();
              return content.left >= card.left && content.right <= card.right + 1 && content.bottom <= card.bottom + 1;
            });
            expect(contained).toBe(true);
            await folded.locator("summary").click();
            await expect(folded.locator(".comment-content")).toBeHidden();
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      const firstReply = cards[0]!.getByRole("button", { name: "回复", exact: true });
      const firstMore = cards[0]!.locator(".comment-more-actions > summary");
      await cards[0]!.locator(".comment-author-name").focus();
      await page.keyboard.press("Tab");
      await expect(firstReply).toBeFocused();
      await expect(firstReply).toHaveCSS("outline-style", "solid");
      await expect(firstReply).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Tab");
      await expect(firstMore).toBeFocused();
      await expect(firstMore).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Escape");
      if (!viewport.touch) {
        // Real mouse input exercises the hover media query and pressed state.
        await firstMore.blur();
        for (const control of [firstReply, firstMore]) {
          await page.mouse.move(0, 0);
          const idle = await control.evaluate(node => getComputedStyle(node).backgroundColor);
          await control.hover();
          await expect.poll(() => control.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(idle);
          const hovered = await control.evaluate(node => getComputedStyle(node).backgroundColor);
          await page.mouse.down();
          await expect.poll(() => control.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(hovered);
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
      await cards[1]!.getByRole("button", { name: "回复", exact: true }).click();
      await expect(page.locator(".comment-reply-source span")).toHaveText("我已核对原评论，下面补充检查结果。");
      await cards[0]!.locator(".comment-author-name").click();
      await expect(page.getByRole("dialog").locator(".comment-author-full")).toHaveText("很长的评论作者名称 Long Author Name ".repeat(4).trim());
      await page.keyboard.press("Escape");
      if ([375, 1440].includes(viewport.width)) {
        await page.locator(".comment-cancel-reply").click();
        await page.evaluate(() => { document.documentElement.dataset.fontScale = "medium"; });
        const group = page.locator(".comment-discussion").filter({ has: cards[0]! });
        await group.scrollIntoViewIfNeeded();
        await group.screenshot({ path: testInfo.outputPath(`cards-collapsed-${viewport.width}-${theme}.png`) });
        if (!viewport.touch) {
          await firstReply.hover();
          await group.screenshot({ path: testInfo.outputPath(`cards-hover-${viewport.width}-${theme}.png`) });
          await page.mouse.move(0, 0);
        }
        await cards[0]!.locator(".comment-collapsible > summary").click();
        // The expanded card can exceed the scroll viewport. Capture both ends
        // instead of an element screenshot clipped by the fixed composer.
        await cards[0]!.locator(".comment-heading").scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`cards-expanded-start-${viewport.width}-${theme}.png`) });
        await cards[0]!.locator(".comment-content .markdown-text > :last-child").scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`cards-expanded-end-${viewport.width}-${theme}.png`) });
      }
    });
  });
}
