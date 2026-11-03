import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * AND-370: the item detail screen traded too much height for identity rows.
 * A one-line comment carried a 36px author row, a 16px metadata row, a 36px
 * notification row and a 44px discussion footer, so a handful of comments
 * filled the screen and the scrollbar did the rest.
 *
 * These are the values the spacing audit settled on. They are computed styles,
 * so they hold wherever the CSS runs; the height budgets below are coarse
 * ceilings because font metrics differ between Linux CI and a Mac.
 */

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

const DESKTOP_BUDGET = { root: 148, reply: 104 };

async function openThread(page: import("@playwright/test").Page) {
  const created = await page.request.post("/api/v1/items", { data: {
    productId: fixture.productId, type: "requirement", priority: "normal",
    title: "评论间距审计", description: "描述正文。".repeat(20), environment: { platform: "web" },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const item = await created.json();
  // mentionTargets renders the notification row the report points at.
  const rootResponse = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text: "一行根评论。", mentionTargets: ["all"] } });
  expect(rootResponse.ok(), await rootResponse.text()).toBe(true);
  const root = await rootResponse.json();
  const replies: { id: string }[] = [];
  // Four replies keep the expand control in the footer, so its target is measured too.
  for (const text of ["一行回复。", "第二行回复。", "第三行回复。", "第四行回复。"]) {
    const replyResponse = await page.request.post(`/api/v1/items/${item.key}/comments`, { data: { text, replyToCommentId: root.id } });
    expect(replyResponse.ok(), await replyResponse.text()).toBe(true);
    replies.push(await replyResponse.json());
  }
  await page.goto(`/?product=${fixture.productId}&status=all&item=${item.key}`);
  const rootCard = page.locator(`#comment-${root.id}`);
  const replyCard = page.locator(`#comment-${replies.at(-1)!.id}`);
  await expect(rootCard).toBeVisible();
  await expect(replyCard).toBeVisible();
  return { rootCard, replyCard };
}

const spacing = (locator: import("@playwright/test").Locator, selector: string) =>
  locator.locator(selector).first().evaluate(node => {
    const style = getComputedStyle(node);
    return { minHeight: style.minHeight, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, rowGap: style.rowGap, marginTop: style.marginTop };
  });

test.describe("AND-370 comment density", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

    test("keeps comment rows on the tightened vertical rhythm", async ({ page }) => {
      const { rootCard, replyCard } = await openThread(page);
      expect(await spacing(rootCard, ".comment-message")).toMatchObject({ paddingTop: "2px", paddingBottom: "8px" });
      expect(await spacing(rootCard, ".comment-heading")).toMatchObject({ rowGap: "2px" });
      expect(await spacing(rootCard, ".comment-notification-details > summary")).toMatchObject({ minHeight: "28px" });
      expect(await spacing(replyCard, ".comment-reply-author")).toMatchObject({ minHeight: "20px" });
      const replyGap = await replyCard.evaluate(node => getComputedStyle(node).marginBlockStart);
      expect(replyGap).toBe("8px");
      const footer = await page.locator(".comment-discussion").first().locator(".comment-discussion-footer > small").evaluate(node => getComputedStyle(node.closest<HTMLElement>(".comment-discussion-footer")!).marginTop);
      expect(footer).toBe("2px");

      const boxes = await page.locator(".comment-thread-root, .comment-thread-reply").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      expect(boxes[0]).toBeLessThanOrEqual(DESKTOP_BUDGET.root);
      for (const height of boxes.slice(1)) expect(height).toBeLessThanOrEqual(DESKTOP_BUDGET.reply);
    });

    test("holds the detail sections together", async ({ page }) => {
      await openThread(page);
      const sections = await page.locator(".description-block, .environment-block, .attachment-block, .timeline-block").evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { paddingBottom: style.paddingBottom, marginBottom: style.marginBottom };
      }));
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) expect(section).toEqual({ paddingBottom: "16px", marginBottom: "16px" });
      const scroll = await page.locator(".detail-scroll").evaluate(node => {
        const style = getComputedStyle(node);
        return { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
      });
      expect(scroll).toEqual({ paddingTop: "24px", paddingBottom: "32px" });
    });
  });

  test.describe("touch", () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

    test("keeps every touch target at 44px after the tightening", async ({ page }) => {
      const { rootCard } = await openThread(page);
      expect(await spacing(rootCard, ".comment-notification-details > summary")).toMatchObject({ minHeight: "44px" });
      const reply = page.locator(".comment-thread-reply .comment-reply-author").first();
      expect(await reply.evaluate(node => getComputedStyle(node).minHeight)).toBe("44px");
      const footerButton = page.locator(".comment-discussion-footer > button").first();
      await expect(footerButton).toBeVisible();
      expect(await footerButton.evaluate(node => getComputedStyle(node).minHeight)).toBe("44px");
    });
  });
});
