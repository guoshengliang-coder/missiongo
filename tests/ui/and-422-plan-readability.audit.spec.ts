import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { planReadabilitySamples } from "../fixtures/plan-readability";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-05T00:00:00.000Z";
const longValue = "configuration/" + "long-segment/".repeat(18) + "result";
const stress = `\n\n| 长标识 | 链接 | 边界 | 方法 |\n|---|---|---|---|\n| \`${longValue}\` | [${longValue}](https://example.invalid/record) | 不静默扩大权限 | 保留完整内容 |`;
async function openSample(page: Page, sample: typeof planReadabilitySamples[number], surface: "console" | "panel", extra = "") {
  const id = "readable-plan";
  const summary = { id, agentSessionId: id, dispatchId: "readable-dispatch", agentKind: sample.agent, status: "idle",
    updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node", nodeConnectionState: "online",
    nodeRevoked: false, mode: "plan", dispatchStatus: "launched", activities: [], settings: {}, unread: false,
    canReply: true, canRetry: false, canStop: false, canArchive: true,
    items: [{ key: fixture.detailKey, title: "Readability fixture", productId: fixture.productId }],
    attention: { state: "not_needed" }, needsAttention: false };
  await page.unroute("**/api/v1/agent-sessions**");
  await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json:
    new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary,
      messages: [{ id: "progress", sourceId: "progress", role: "plan", text: "正在调查，尚未提交新方案", occurredAt: stamp }],
      implementationPlan: { revision: "sample", plan: sample.after + extra, validation: sample.validation, itemKeys: [fixture.detailKey],
        valid: true, approved: true, submittedAt: "2026-11-05T00:01:00Z" },
      planApprovalStatus: { code: "approved" }, planApprovalState: { approved: true, revision: "sample", continuationQueued: false },
    } }));
  await page.unroute("**/api/v1/items/*/dispatches");
  await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{
    id: summary.dispatchId, agentSessionId: id, agentKind: sample.agent, mode: "plan", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
  }] } }));
  if (surface === "console") await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  else {
    await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
    await page.locator(".execution-history > summary").click();
    await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
    await page.locator(".agent-session-toggle").click();
  }
  const card = page.getByRole("article", { name: "提交审批的方案", exact: true });
  await expect(card).toBeVisible();
  return card;
}

test("nine edited historical examples preserve critical boundaries without promoting progress", async ({ page }) => {
  await page.clock.install();
  for (const sample of planReadabilitySamples) {
    const card = await openSample(page, sample, "console");
    for (const term of sample.terms) await expect(card).toContainText(term);
    await expect(card.locator(".agent-plan-validation")).toBeVisible();
    await expect(page.getByRole("article", { name: "提交审批的方案", exact: true })).toHaveCount(1);
    await expect(page.getByText("正在调查，尚未提交新方案", { exact: true })).toHaveCount(1);
    if (sample.size === "short") await expect(card.locator("table")).toHaveCount(0);
    else await expect(card.locator("table").first()).toBeVisible();
  }
});

for (const width of [320, 375, 1440]) for (const theme of ["light", "dark"] as const) for (const surface of ["console", "panel"] as const) {
  test(`plan tables and prose ${surface} ${width}px ${theme}`, async ({ page }, info) => {
    await page.clock.install();
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    for (const key of ["AND-412", "AND-406", "AND-418/417/416"]) {
      const sample = planReadabilitySamples.find(s => s.key === key)!;
      const card = await openSample(page, sample, surface, sample.size === "long" ? stress : "");
      const reply = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
      await reply.fill("保留本地草稿");
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        await card.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        expect(await card.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        for (const region of await card.locator(".markdown-table-scroll").all()) {
          const sizes = await region.evaluate(el => ({ table: parseFloat(getComputedStyle(el.querySelector("td")!).fontSize), body: parseFloat(getComputedStyle(el.closest(".markdown-text")!).fontSize) }));
          expect(sizes.table).toBeGreaterThanOrEqual(11);
          expect(sizes.table).toEqual(sizes.body);
        }
        await expect(reply).toHaveValue("保留本地草稿");
      }
      if (sample.size === "long") {
        const region = card.locator(".markdown-table-scroll").filter({ hasText: "长标识" });
        await region.scrollIntoViewIfNeeded();
        await region.focus();
        await expect(region).toBeFocused();
        if (width < 400) {
          expect(await region.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
          await page.keyboard.press("ArrowRight");
          // ArrowRight exercises native horizontal scrolling of the focused region.
          await page.clock.runFor(500);
          await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        }
        // Capture the readable example separately from the deliberately huge
        // stress row; a tall element screenshot inside a scroll pane is clipped.
        await openSample(page, sample, surface);
        await page.evaluate(() => { document.documentElement.dataset.fontScale = "medium"; document.documentElement.dataset.consoleFontScale = "medium"; });
        await card.evaluate(el => el.scrollIntoView({ block: "start" }));
        const path = info.outputPath(`plan-${surface}-${width}-${theme}.png`);
        await page.screenshot({ path, animations: "disabled" });
        await info.attach("readable plan", { path, contentType: "image/png" });
      }
    }
  });
}
