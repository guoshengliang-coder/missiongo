import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const sample = "**建议：改善导出与恢复。**\n\n| 问题 | 诊断结论 | 修改建议 |\n|---|---|---|\n| 无进度 | 已核实 | 分阶段显示 |\n| 无取消 | 已核实 | 安全取消 |\n| 完成仍等待 | 尚未复现 | 补充恢复验证 |\n\n范围：仅客户端，不含发布。\n\n[方案 A](https://example.test/plan/a-v1)\n\n**简单问题：保存失败提示。**\n\n- 诊断：原因缺失。\n- 修改：显示原因并保留输入。\n\n[方案 B](https://example.test/plan/b-v1)";
// Optional real CLI output stays outside the repository, including extra native messages.
const outputs: Record<string, string[]> = process.env.STRUCTURED_SUMMARY_MESSAGES
  ? JSON.parse(readFileSync(process.env.STRUCTURED_SUMMARY_MESSAGES, "utf8"))
  : { codex: [sample], claude_code: [sample], opencode: [sample] };

for (const surface of ["console", "panel"] as const) for (const width of [375, 1440]) for (const [agent, texts] of Object.entries(outputs)) {
  test(`${surface} ${width}px preserves ${agent} structured summary`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = "structured-summary", stamp = "2026-11-07T12:00:00Z";
    const summary = { id, agentSessionId: id, dispatchId: "structured-dispatch", agentKind: agent, status: "idle",
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeId: "fixture-node", nodeConnectionState: "online",
      mode: "plan", dispatchStatus: "launched", activities: [], settings: {}, unread: false, canReply: true,
      items: [{ key: fixture.detailKey, title: "Single item with multiple problems", productId: fixture.productId }], attention: { state: "not_needed" } };
    await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
      ? { sessions: [summary] } : { ...summary, messages: texts.map((text, n) => ({ id: `source-${n}`, sourceId: `source-${n}`, role: "agent", phase: "final_answer", text, occurredAt: stamp })) } }));
    await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: summary.dispatchId, agentSessionId: id, agentKind: agent, mode: "plan", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey] }] } }));
    if (surface === "console") await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    else {
      await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
      await page.locator(".execution-history > summary").click();
      await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
      await page.locator(".agent-session-toggle").click();
    }
    const messages = page.locator("article[data-agent-message-id]");
    await expect(messages).toHaveCount(texts.length);
    const first = messages.first();
    await expect(first.locator("table")).toHaveCount(1);
    await expect(first.locator("tbody tr")).toHaveCount(3);
    await expect(first.locator("table")).toContainText("尚未复现");
    await expect(first.locator("ul").first()).toBeVisible();
    await expect(first.locator('a[href="https://example.test/plan/a-v1"]')).toBeVisible();
    await expect(first.locator('a[href="https://example.test/plan/b-v1"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await first.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await first.evaluate(el => el.scrollIntoView({ block: "start" }));
    const path = info.outputPath("structured-summary.png");
    await page.screenshot({ path });
    await info.attach("structured summary", { path, contentType: "image/png" });
  });
}
