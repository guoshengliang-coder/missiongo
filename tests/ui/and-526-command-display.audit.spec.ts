import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const { productId } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
const longContent = Array.from({ length: 8 }, (_, i) => `核对第${i + 1}项入口，保留已有修改，检查布局、交互和验证结果。`).join("\n");
const unnamedContent = "无短名称的完整指令\n" + "连续长文本".repeat(150);

for (const width of [320, 1440]) for (const appearance of ["light", "dark"]) for (const scale of ["small", "medium", "large"]) {
 test.describe(`${width}px ${appearance} ${scale} instructions`, () => {
  test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, isMobile: width === 320 });
  test("keeps focus out of search and discloses long instructions without inserting", async ({ page }, testInfo) => {
   await page.clock.setFixedTime(new Date("2026-11-15T02:00:00Z"));
   const id = "command-display", stamp = "2026-11-15T01:00:00Z";
   const session = { id, agentSessionId: id, dispatchId: id, productId, agentKind: "codex", status: "idle", dispatchStatus: "launched", sessionName: "指令展示验证", nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "auto", createdAt: stamp, updatedAt: stamp, activityAt: stamp, items: [], canReply: true, canAttach: false, canRetry: false, canStop: false, canArchive: true, unread: false, settings: { adjustable: false }, attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, activities: [], turnState: { turnActive: false } };
   let sends = 0;
   await page.route("**/api/v1/agent-sessions**", route => {
    if (route.request().method() !== "GET") { sends++; return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [session] } : { ...session, messages: [] } });
   });
   await page.route("**/api/v1/common-commands", route => route.fulfill({ json: { revision: 1, commands: [
    { id: "short", name: "简短名称", content: "简短正文", favorite: true },
    { id: "long", name: "长指令检查", content: longContent, favorite: false },
    { id: "unnamed", name: "", content: unnamedContent, favorite: false },
    { id: "title", name: "第一行\n第二行\n第三行\n第四行", content: "名称也能展开", favorite: false },
    { id: "adaptive", name: "适配检查", content: "根据现有设计检查常用指令列表，确保短名称与完整正文都能清楚识别，保留草稿并核对范围。", favorite: false },
   ] } }));
   await page.goto(`/?product=${productId}&console=agent&session=${id}`);
   await page.evaluate(({ appearance, scale }) => { document.documentElement.dataset.appearance = appearance; document.documentElement.dataset.fontScale = scale; }, { appearance, scale });
   const draft = page.locator(".agent-console-reply textarea");
   await draft.fill("保留原草稿");
   const open = async () => { await page.locator(".common-command-add summary").click(); await page.getByRole("button", { name: "常用指令", exact: true }).click(); };
   await open();
   const picker = page.locator(".common-command-picker"), search = picker.getByRole("textbox", { name: "搜索指令内容" });
   await expect(picker.getByRole("button", { name: "管理指令", exact: true })).toBeFocused();
   await expect(search).not.toBeFocused();
   // Keyboard navigation remains available without an automatic input focus.
   await page.keyboard.press("Tab");
   await expect(picker.getByRole("button", { name: "新建指令", exact: true })).toBeFocused();
   const cards = picker.locator(".common-command-card");
   await expect(cards).toHaveCount(5);
   await expect(cards.nth(0).locator(".common-command-title")).toHaveText("简短名称");
   await expect(cards.nth(0).locator(".common-command-preview")).toHaveText("简短正文");
   await expect(cards.nth(0).getByRole("button", { name: "查看全文", exact: true })).toHaveCount(0);
   const sizes = await cards.nth(0).evaluate(el => [".common-command-title", ".common-command-preview"].map(selector => { const style = getComputedStyle(el.querySelector(selector)!); return { size: parseFloat(style.fontSize), weight: style.fontWeight }; }));
   const factor = scale === "small" ? .9 : scale === "large" ? 1.15 : 1;
   expect(sizes[0]!.size).toBeCloseTo(14 * factor, 1); expect(sizes[0]!.weight).toBe("500");
   expect(sizes[1]!.size).toBeCloseTo(13 * factor, 1);
   for (const index of [1, 2, 3]) {
    const card = cards.nth(index), preview = card.locator(index === 3 ? ".common-command-title" : ".common-command-preview");
    await expect(preview).toHaveCSS("-webkit-line-clamp", index === 2 ? "3" : "2");
    await expect(card.getByRole("button", { name: "查看全文", exact: true })).toBeVisible();
    const collapsedHeight = await preview.evaluate(el => el.clientHeight);
    await card.getByRole("button", { name: "查看全文", exact: true }).click();
    const collapse = card.getByRole("button", { name: "收起", exact: true });
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await expect(collapse).toBeFocused();
    expect(await preview.evaluate(el => el.clientHeight)).toBeGreaterThan(collapsedHeight);
    expect(await preview.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await expect(draft).toHaveValue("保留原草稿"); expect(sends).toBe(0);
    if (index === 1) await page.screenshot({ path: testInfo.outputPath("expanded.png") });
    await collapse.click(); await expect(card).toHaveAttribute("data-expanded", "false");
   }
   expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
   if (width === 1440 && appearance === "light" && scale === "medium") {
    const adaptive = cards.nth(4).getByRole("button", { name: "查看全文", exact: true });
    await expect(adaptive).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(adaptive).toBeVisible();
    await adaptive.focus();
    await page.setViewportSize({ width, height: 900 });
    await expect(adaptive).toHaveCount(0);
    await expect(cards.nth(4).locator(".common-command-choice")).toBeFocused();
   }
   await picker.locator(".common-command-list").evaluate(el => { el.scrollTop = 0; });
   await page.screenshot({ path: testInfo.outputPath("collapsed.png") });
   await search.click(); await expect(search).toBeFocused();
   await search.fill("长指令检查"); await expect(cards).toHaveCount(1);
   await search.fill("第8项入口"); await expect(cards).toHaveCount(1);
   await cards.locator(".common-command-choice").click();
   await expect(picker).toHaveCount(0); await expect(draft).toHaveValue(`保留原草稿\n${longContent}`); expect(sends).toBe(0);
   await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect(draft).toHaveValue("保留原草稿");
   await open(); await expect(search).not.toBeFocused();
   await picker.getByRole("button", { name: "管理指令", exact: true }).click();
   await expect(page).toHaveURL(/\/settings\/common-commands/);
   await page.locator(".settings-page-header button").click();
   await expect(picker.getByRole("button", { name: "管理指令", exact: true })).toBeFocused();
   await expect(search).toHaveValue("第8项入口"); await expect(draft).toHaveValue("保留原草稿");
   await picker.getByRole("button", { name: "新建指令", exact: true }).click();
   await expect(page.getByRole("textbox", { name: "指令内容", exact: true })).toBeFocused();
   await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
   await expect(picker.getByRole("button", { name: "管理指令", exact: true })).toBeFocused();
   await search.press("Escape"); await expect(picker).toHaveCount(0);
   await expect(draft).toHaveValue("保留原草稿");
  });
 });
}
