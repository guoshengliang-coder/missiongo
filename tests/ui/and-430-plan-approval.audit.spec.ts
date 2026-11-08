import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-06T07:51:00Z";
const answer = "建议 1 acceptEdits：自动接受编辑。建议 2 addDirectories：允许访问目录。批准只批准当前一次。";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`ordinary answers stay visible without approval; missing content fails closed at ${width}px ${theme}`, async ({ page }, info) => {
    await page.clock.install();
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    let state: "answer" | "followup" | "missing" | "formal" = "answer";
    let posts = 0;
    const id = "and430";
    const summary = { id, agentSessionId: id, dispatchId: "fixture-dispatch", agentKind: "codex", status: "idle",
      updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
      nodeConnectionState: "online", nodeRevoked: false, mode: "auto", dispatchStatus: "launched",
      activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: false, canArchive: true,
      items: [{ key: fixture.detailKey, title: "Fixture", productId: fixture.productId }],
      attention: { state: "needed", kind: "approval", reason: "误判的审批分类", revision: "attention" }, needsAttention: true };
    const messages = () => [
      { id: "progress", sourceId: "progress", role: "agent", text: "我先看一下截图。", occurredAt: stamp },
      { id: "answer", sourceId: "answer", role: "agent", text: answer, occurredAt: "2026-11-06T07:51:23Z" },
      ...(state === "followup" ? [{ id: "followup", sourceId: "followup", role: "user", text: "？？", occurredAt: "2026-11-06T07:54:32Z" }] : []),
    ];
    await page.route("**/api/v1/agent-sessions**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/plan-approval")) { posts++; return route.fulfill({ status: 409 }); }
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const proposal = state === "missing" ? { revision: "formal", reason: "正式请求，正文尚未加载" }
        : state === "formal" ? { revision: "formal", plan: "完整正式方案", validation: "验证目标" } : undefined;
      const listed = { ...summary, planApprovalPending: state === "formal" || state === "missing",
        ...(state === "formal" ? { approval: { id:"old-permission",kind:"manual",status:"approved",requestKind:"permission",turnId:"old",action:"Previous tool",startedAtMs:1 } } : {}) };
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [listed] } : {
        ...listed, messages: messages(), canApprovePlan: true,
        planApprovalStatus: { code: proposal ? "ready" : "not_approval" }, ...(proposal ? { planApproval: proposal } : {}),
      } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const area = page.locator(".agent-console-messages");
    const body = area.locator('[data-agent-message-id="agent:answer"]');
    await expect(body).toHaveText(new RegExp("addDirectories"));
    await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
    await expect(page.locator(".agent-console-session .agent-console-attention")).not.toHaveText("待批准");
    await expect(page.locator(".agent-console-attention-banner summary")).not.toHaveText("待批准");
    await expect(page.locator("article[data-agent-message-id]").filter({ has: page.locator(".agent-plan-inline-approval") })).toHaveCount(0);
    state = "followup";
    await advanceSessionDetailPoll(page);
    await expect(area.locator('[data-agent-message-id="user:followup"]')).toBeVisible();
    await expect(body).toContainText(answer);
    expect(await body.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('[data-agent-message-id="user:followup"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.reload();
    await expect(body).toContainText(answer);
    const reply = page.locator(".agent-console-reply textarea");
    await reply.fill("保留草稿");
    state = "missing";
    await advanceSessionDetailPoll(page);
    const approve = page.getByRole("button", { name: "批准", exact: true });
    await expect(approve).toBeDisabled();
    await expect(page.getByText("方案内容暂不可用，请重新加载后再审阅。")).toBeVisible();
    state = "formal";
    await page.locator(".agent-console-attention-banner").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator("article[data-agent-message-id]").filter({ has: page.locator(".agent-plan-inline-approval") })).toHaveCount(0);
    await page.clock.fastForward(5100);
    await page.getByText("查看已登记方案",{exact:true}).click();
    await expect(page.getByRole("region",{name:"方案记录"})).toContainText("验证目标");
    await expect(approve).toBeEnabled();
    await expect(reply).toHaveValue("保留草稿");
    await page.reload();
    await expect(page.locator(".agent-console-session .agent-console-attention")).toHaveText("待批准");
    expect(posts).toBe(0);
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: info.outputPath("and430.png"), animations: "disabled" });
  });
}
