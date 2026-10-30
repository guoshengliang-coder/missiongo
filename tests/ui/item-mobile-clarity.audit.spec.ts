import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [320, 353, 375, 390, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} item information`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : width === 1440 ? 900 : width === 353 ? 757 : 950 }, hasTouch: width < 800, isMobile: width < 800, colorScheme: theme });
    test("groups Builder, keeps the console beside the summary, and preserves collapsed work history", async ({ page, request }, testInfo) => {
      const product = await (await request.post("/api/v1/products", { data: { name: `Mobile ${width} ${theme}`, keyPrefix: `MC${width}${theme[0]!.toUpperCase()}` } })).json();
      const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "bug", priority: "normal", title: "移动端长标题排版与图标完整性检查LongUnbrokenIdentifierForWrapping", description: "正文应保持可读" } })).json();
      const name = "梁国盛与很长的交付负责人姓名LongBuilderAccountName";
      await page.route(/\/api\/v1\/(?:items|bootstrap)\?/, async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.items = data.items.map((row: { key: string }) => row.key === item.key ? { ...row, builderName: name, builderNeedsReassignment: true } : row);
        await route.fulfill({ response, json: data });
      });
      const stamp = new Date(Date.now() - 10 * 60_000).toISOString();
      const started = new Date(Date.now() - 3 * 60_000).toISOString();
      const session = "mobile-current-session";
      const execution = { id: "current", kind: "agent", accountId: "fixture", accountName: "测试账号", name: "codex", scope: "Agent 会话执行（具体工作范围见对应会话）", previousId: null, sessionId: session, status: "active", result: "", createdAt: started, startedAt: started, endedAt: null };
      await page.route(`**/api/v1/items/${item.key}/delivery`, route => route.fulfill({ json: {
        builderAccountId: "fixture", builderName: name, builderNeedsReassignment: true, currentAccountId: "fixture", canManage: false, canManageBuilder: false, candidates: [], performers: [], executions: [
          execution,
          { ...execution, id: "older", sessionId: "older-session", name: "claude_code", status: "completed", result: "历史会话结果", endedAt: stamp },
          { ...execution, id: "human", kind: "human", recorded: true, sessionId: undefined, name: "人工执行人", scope: "人工回归验收", status: "handed_over", result: "已交接给下一轮" },
          { ...execution, id: "recorded", recorded: true, scope: "本轮具体实现范围", status: "working", previousId: "human", result: "本轮阶段结果" },
        ],
      } }));
      await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [{ id: "mobile-dispatch", nodeId: "node", nodeName: "M5", agentKind: "codex", mode: "plan", status: "launched", agentSessionId: session, createdAt: stamp, itemKeys: [item.key] }] } }));
      const sessionSummary = {
        id: session, agentSessionId: session, dispatchId: "mobile-dispatch", nodeId: "node", nodeName: "M5",
        nodeConnectionState: "online", nodeRevoked: false, agentKind: "codex", mode: "plan", status: "active",
        dispatchStatus: "launched", createdAt: started, updatedAt: started, activityAt: started,
        items: [{ key: item.key, title: item.title, productId: product.id }], activities: [], settings: {},
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false,
        canReply: true, canRetry: false, canStop: true, canArchive: true, unread: false,
      };
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json:
        new URL(route.request().url()).pathname === "/api/v1/agent-sessions"
          ? { sessions: [sessionSummary] }
          : { ...sessionSummary, messages: [], canResolveDelivery: false },
      }));
      await page.goto(`/?product=${product.id}&status=inbox`);
      const row = page.locator(".item-row").filter({ hasText: item.key });
      await expect(row.locator(".item-builder strong")).toHaveText(name);
      const listBadge = row.locator(".item-builder");
      expect(await listBadge.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await row.screenshot({ path: testInfo.outputPath("builder-list.png") });
      await row.locator(".item-row-main").click();
      const summary = page.locator(".detail-dispatch-line");
      await expect(summary).toContainText("Codex · M5");
      await expect(summary).toContainText("会话运行中");
      await expect(summary).toContainText("启动于");
      const target = await summary.locator(".detail-dispatch-target").boundingBox();
      const jump = summary.getByRole("button", { name: "在控制台查看", exact: true });
      const button = await jump.boundingBox();
      expect(target).not.toBeNull(); expect(button).not.toBeNull();
      expect(button!.x).toBeGreaterThan(target!.x + target!.width - 1);
      expect(button!.y).toBeLessThan(target!.y + target!.height);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      const icon = await page.locator(".detail-title-block > .type-icon").boundingBox();
      expect(icon!.width).toBe(40); expect(icon!.height).toBe(40);
      await expect(page.locator(".detail-title-block .item-builder strong")).toHaveText(name);
      const history = page.locator(".execution-history");
      await expect(history).not.toHaveAttribute("open", "");
      await expect(history.locator(".execution-list")).toBeHidden();
      await page.locator(".detail-pane").screenshot({ path: testInfo.outputPath("detail-collapsed.png") });
      await page.screenshot({ path: testInfo.outputPath("viewport.png") });
      const audit = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ sample: string; fontSize: number; fontWeight: number; contrast: number }> };
      for (const text of audit.text) {
        expect(text.fontSize, text.sample).toBeGreaterThanOrEqual(11);
        const large = text.fontSize >= 24 || text.fontSize >= 18.66 && text.fontWeight >= 700;
        expect(text.contrast, text.sample).toBeGreaterThanOrEqual(large ? 3 : 4.5);
      }
      await history.locator("summary").click();
      const rows = history.locator(".execution-row");
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toContainText("当前会话详情");
      await expect(rows.nth(0)).not.toContainText("Agent 会话执行");
      await expect(rows.nth(1)).toContainText("历史会话结果");
      await expect(rows.nth(2)).toContainText("人工回归验收");
      await expect(rows.nth(3)).toContainText("本轮具体实现范围");
      await expect(rows.nth(3)).toContainText("接续执行：人工执行人");
      await expect(rows.nth(3)).toContainText("本轮阶段结果");
      expect(await page.locator(".detail-scroll").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.locator(".detail-scroll").evaluate(el => el.scrollTop = 0);
      await jump.click();
      await expect(page).toHaveURL(new RegExp(`session=${session}`));
    });
  });
}

for (const hasSession of [false, true]) {
  test(`353px failure and unknown launch time, session=${hasSession}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 353, height: 757 });
    const product = await (await request.post("/api/v1/products", { data: { name: `Failure ${hasSession}`, keyPrefix: hasSession ? "MFS" : "MFN" } })).json();
    const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "bug", priority: "normal", title: "失败状态与未分配负责人", description: "保留失败原因" } })).json();
    await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [{ id: "failure", nodeName: "VeryLongNodeNameWithoutAnyBreaksForMobileWrapping", agentKind: "codex", mode: "plan", status: "failed", error: "会话启动失败：很长的可读失败原因用于验证换行", ...(hasSession ? { agentSessionId: "failed-session" } : {}), createdAt: new Date().toISOString(), itemKeys: [item.key] }] } }));
    await page.goto(`/?product=${product.id}&item=${item.key}`);
    const summary = page.locator(".detail-dispatch-line");
    await expect(summary).toHaveClass(/failed/);
    await expect(summary).toContainText("派单于");
    await expect(summary).not.toContainText("启动于");
    await expect(summary).toContainText("会话启动失败");
    await expect(summary.getByRole("button")).toHaveCount(hasSession ? 1 : 0);
    await expect(page.locator(".detail-title-block .item-builder")).toContainText("待分配");
    await expect(page.locator(".execution-history")).toHaveCount(0);
    expect(await summary.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.locator(".detail-pane").screenshot({ path: testInfo.outputPath("failure.png") });
  });
}
