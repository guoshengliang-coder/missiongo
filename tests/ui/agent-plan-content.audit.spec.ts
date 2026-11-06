import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-05T00:00:00.000Z";
for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) for (const surface of ["console", "panel"] as const) {
  test(`${surface} keeps submitted plan visible before and after approval at ${width}px ${theme}`, async ({ page }, info) => {
    await page.clock.install();
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    // Claude Code delivers its plan as an ordinary agent message; the other
    // adapters use the dedicated plan role (AND-425).
    for (const agentKind of surface === "console" ? ["codex", "claude_code", "opencode", "hermes"] : ["codex", "claude_code"]) {
      let approved = false;
      const id = `plan-${agentKind}`;
      const plan = { revision: "reviewed-revision", plan: "## 当前实施方案\n\n**完整正文始终可见**\n\n- 恢复中间消息\n- 保留方案文件",
        validation: "确认六条过程正文和完整方案均可见。", itemKeys: [fixture.detailKey], valid: true, submittedAt: "2026-11-05T00:00:30.000Z" };
      const summary = { id, agentSessionId: id, dispatchId: "plan-dispatch", agentKind, status: "idle",
        updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
        nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched",
        activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: false, canArchive: true,
        items: [{ key: fixture.detailKey, title: "Plan fixture", productId: fixture.productId }],
        attention: { state: "needed", kind: "approval", reason: "方案待批准" }, needsAttention: true };
      await page.route("**/api/v1/agent-sessions**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/plan-approval")) {
          approved = true;
          return route.fulfill({ status: 201, json: { approved: true, revision: plan.revision, continuationQueued: false } });
        }
        if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
        return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary,
          messages: [...Array.from({ length: 6 }, (_, n) => ({ id: `comment-${n}`, sourceId: `comment-${n}`, role: "agent", text: `过程正文 ${n + 1}`, occurredAt: stamp })),
            { id: "native-plan", sourceId: "native-plan", role: agentKind === "claude_code" ? "agent" : "plan", text: plan.plan, occurredAt: plan.submittedAt },
            ...(approved ? [{ id: "implementation-result", sourceId: "implementation-result", role: "agent", text: "批准后执行完成的最新正文", occurredAt: "2026-11-05T01:00:00.000Z" }] : [])],
          implementationPlan: { ...plan, approved, ...(approved ? { approvedAt: "2026-11-05T00:01:00.000Z" } : {}) },
          planApprovalStatus: { code: approved ? "approved" : "ready" },
          ...(approved ? { planApprovalState: { approved: true, revision: plan.revision, continuationQueued: false } }
            : { planApproval: { ...plan, reason: "等待审批" } }),
        } });
      });
      await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{
        id: summary.dispatchId, agentSessionId: id, agentKind, mode: "plan", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
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
      await expect(card.locator("h2")).toHaveText("当前实施方案");
      await expect(card).toContainText(plan.validation);
      await expect(page.getByText("完整正文始终可见", { exact: true })).toHaveCount(1);
      const area = page.locator(surface === "console" ? ".agent-console-messages" : ".agent-session-messages");
      await expect(area.locator("[data-agent-message-id]")).toHaveCount(6);
      if (agentKind === "claude_code") await expect(area.locator('[data-agent-message-id="agent:native-plan"]')).toHaveCount(0);
      const reply = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
      await reply.fill("保留尚未发送的草稿");
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        await card.scrollIntoViewIfNeeded();
        await expect(card.locator("strong").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
      await area.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
      if (surface === "console") await page.locator(".agent-console-attention-banner").getByRole("button", { name: "批准", exact: true }).click();
      else approved = true;
      await advanceSessionDetailPoll(page);
      await expect(card).toContainText("方案已批准");
      if (surface === "console") await expect(page.locator(".agent-console-attention-banner--approval")).toHaveCount(0);
      const result = area.locator('[data-agent-message-id="agent:implementation-result"]');
      await expect(result).toBeVisible();
      expect(await card.evaluate((node, result) => Boolean(node.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING), await result.elementHandle())).toBe(true);
      const bounds = await area.evaluate(node => ({ bottom: node.scrollHeight - node.clientHeight, top: node.scrollTop }));
      expect(bounds.bottom - bounds.top).toBeLessThanOrEqual(2);
      await expect(card).toContainText(plan.validation);
      await expect(reply).toHaveValue("保留尚未发送的草稿");
      if (agentKind === "codex" || agentKind === "claude_code") {
        const path = info.outputPath(`plan-${surface}-${agentKind}-${width}-${theme}.png`);
        await page.screenshot({ path, animations: "disabled" });
        await info.attach("plan", { path, contentType: "image/png" });
      }
      await page.unroute("**/api/v1/agent-sessions**");
      await page.unroute("**/api/v1/items/*/dispatches");
    }
  });
}
