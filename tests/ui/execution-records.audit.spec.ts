import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} unified execution records`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : 900 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("counts mixed records once, folds each row and preserves notification retry confirmation", async ({ page, request }, info) => {
      const product = await (await request.post("/api/v1/products", { data: { name: `Records ${width} ${theme}`, keyPrefix: `ER${width}${theme[0]!.toUpperCase()}` } })).json();
      const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "task", priority: "normal", title: "统一执行记录", description: "独立展开记录" } })).json();
      const stamp = (hour: number) => `2026-10-31T${String(hour).padStart(2, "0")}:00:00.000Z`;
      const notice = (id: string, status: string, hour: number) => ({ id, kind: "verification", status, accountName: "测试接收人", reason: `结果详情 ${id}`, attempts: 1, createdAt: stamp(hour), updatedAt: stamp(hour), canRetry: true });
      let notices = [notice("uncertain", "uncertain", 5), notice("sent", "sent", 1), notice("failed", "failed", 4), { ...notice("comment", "sent", 6), kind: "comment", commentId: "fixture-comment" }];
      const notifications = `**/api/v1/items/${item.key}/dingtalk-notifications`;
      await page.route(notifications, route => route.fulfill({ json: { notifications: notices, canRetry: true } }));
      const dispatch = { id: "matched", nodeId: "fixture", nodeName: "Test Mac", agentKind: "codex", mode: "plan", status: "queued", createdAt: stamp(2), itemKeys: [item.key], agentSessionId: "fixture-session" };
      await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [{ ...dispatch, id: "orphan", agentSessionId: undefined, createdAt: stamp(3) }, dispatch] } }));
      await page.route(`**/api/v1/items/${item.key}/delivery`, route => route.fulfill({ json: {
        builderAccountId: null, builderName: null, builderNeedsReassignment: false, currentAccountId: "fixture", canManage: false, candidates: [], performers: [],
        executions: [{ id: "execution", kind: "agent", recorded: true, name: "执行会话", accountName: "测试执行人", accountId: "fixture", sessionId: "fixture-session", status: "working", scope: "完整执行范围", result: "阶段成果", createdAt: stamp(2) }],
      } }));
      await page.route("**/api/v1/agent-sessions/fixture-session", route => route.fulfill({ status: 404, json: { error: "Synthetic session" } }));
      let retries = 0;
      await page.route(`${notifications}/uncertain/retry`, route => {
        retries++;
        notices = notices.map(row => row.id === "uncertain" ? { ...row, status: "sent", reason: "补发已确认", attempts: 2 } : row);
        return route.fulfill({ json: { notifications: notices, canRetry: true } });
      });
      await page.goto(`/?product=${product.id}&item=${item.key}`);
      const panel = page.getByRole("region", { name: "执行记录", exact: true });
      const history = panel.locator(".execution-history");
      const header = history.locator(":scope > summary");
      await expect(header.locator(".record-summary")).toHaveText("执行记录（5）");
      await expect(header.locator(".when-closed")).toBeVisible();
      await expect(panel.locator(".execution-list")).toBeHidden();
      await expect(page.locator(".dingtalk-item-notices")).toHaveCount(0);
      await header.focus();
      await page.keyboard.press("Enter");
      await expect(header.locator(".record-summary")).toHaveText("执行记录（5）");
      await expect(header.locator(".when-open")).toBeVisible();
      const records = history.locator(".execution-record");
      await expect(records).toHaveCount(5);
      const headers = records.locator(":scope > summary");
      await expect(headers.nth(0)).toContainText("钉钉通知 · 发送成功");
      await expect(headers.nth(1)).toContainText("执行会话");
      await expect(headers.nth(2)).toContainText("派单 · Test Mac");
      await expect(headers.nth(3)).toContainText("发送失败");
      await expect(headers.nth(4)).toContainText("发送结果不明");
      for (const body of await records.locator(".execution-record-body").all()) await expect(body).toBeHidden();
      await headers.nth(1).click();
      await expect(records.nth(1).getByText("完整执行范围", { exact: true })).toBeVisible();
      await expect(records.nth(1).getByText("阶段成果", { exact: true })).toBeVisible();
      // Title and status share the first line; the toggle occupies the next
      // right-hand line, without stretching the date-to-body spacing.
      for(const viewport of (width===375 ? [320,375,724,768,844,1180,1440] : [1440])) for(const scale of ["small","medium","large"]) {
        await page.setViewportSize({width:viewport,height:viewport===844?390:900});
        await page.evaluate(value=>document.documentElement.dataset.fontScale=value,scale);
        const geometry=await records.nth(1).evaluate(el=>{
          const rect=(selector:string)=>el.querySelector(selector)!.getBoundingClientRect();
          const title=rect("summary strong"),status=rect(".record-status"),toggle=rect(".record-toggle"),date=rect(".record-summary small"),body=rect(".execution-record-body > :first-child");
          return {titleY:title.top,statusY:status.top,statusRight:status.right,toggleRight:toggle.right,statusBottom:status.bottom,toggleTop:toggle.top,bodyGap:body.top-date.bottom,overflow:el.scrollWidth-el.clientWidth};
        });
        expect(Math.abs(geometry.titleY-geometry.statusY)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.statusRight-geometry.toggleRight)).toBeLessThanOrEqual(1);
        expect(geometry.toggleTop).toBeGreaterThanOrEqual(geometry.statusBottom);
        expect(geometry.bodyGap).toBeLessThanOrEqual(16);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
      }
      await page.evaluate(()=>delete document.documentElement.dataset.fontScale);
      await page.setViewportSize({width,height:width===375?812:900});
      await records.nth(1).screenshot({path:info.outputPath("expanded-session-layout.png")});

      await expect(records.nth(0)).not.toHaveAttribute("open", "");
      await headers.nth(4).click();
      await records.nth(4).getByRole("button", { name: "补发通知", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "确认补发通知" });
      await expect(dialog).toContainText("补发可能产生重复通知");
      expect(retries).toBe(0);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect(retries).toBe(0);
      await records.nth(4).getByRole("button", { name: "补发通知", exact: true }).click();
      await dialog.getByRole("button", { name: "已核实，补发通知", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(retries).toBe(1);
      await expect(records.nth(4)).toHaveAttribute("open", "");
      await expect(records.nth(1)).toHaveAttribute("open", "");
      await expect(records.nth(4)).toContainText("补发已确认");
      await expect(header.locator(".record-summary")).toHaveText("执行记录（5）");
      await expect(header.locator(".when-open")).toBeVisible();
      await headers.nth(4).click();
      await expect(records.nth(1)).toHaveAttribute("open", "");
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const audit = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ sample: string; fontSize: number; fontWeight: number; contrast: number }> };
      for (const text of audit.text) {
        expect(text.fontSize, text.sample).toBeGreaterThanOrEqual(11);
        const large = text.fontSize >= 24 || text.fontSize >= 18.66 && text.fontWeight >= 700;
        expect(text.contrast, text.sample).toBeGreaterThanOrEqual(large ? 3 : 4.5);
      }
      for (const target of await panel.locator("summary").all()) {
        if (!await target.isVisible()) continue;
        const box = await target.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      // Keep all five summaries in view for review evidence; a tall open
      // session would otherwise be occluded by the sticky detail toolbar.
      await headers.nth(1).click();
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: info.outputPath("expanded-records.png") });
      await page.screenshot({ path: info.outputPath("viewport-records.png") });
      await headers.nth(1).click();
      await header.focus();
      await page.keyboard.press("Space");
      await expect(panel.locator(".execution-list")).toBeHidden();
      await panel.screenshot({ path: info.outputPath("collapsed-records.png") });
      await header.click();
      await expect(records.nth(1)).toHaveAttribute("open", "");
    });
  });
}

for (const failDelivery of [false, true]) {
  test(`notification-only records survive other feed errors, delivery failure=${failDelivery}`, async ({ page, request }) => {
    const product = await (await request.post("/api/v1/products", { data: { name: `Partial records ${failDelivery}`, keyPrefix: failDelivery ? "ERF" : "ERN" } })).json();
    const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "task", priority: "normal", title: "仅通知记录", description: "保留独立数据源" } })).json();
    await page.route(`**/api/v1/items/${item.key}/delivery`, route => route.fulfill(failDelivery ? { status: 500, json: { error: "Synthetic failure" } } : { json: { executions: [] } }));
    await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [] } }));
    await page.route(`**/api/v1/items/${item.key}/dingtalk-notifications`, route => route.fulfill({ json: { notifications: [{ id: "only", kind: "verification", status: "sent", reason: "唯一通知", attempts: 1, createdAt: "2026-10-31T00:00:00Z" }], canRetry: false } }));
    await page.goto(`/?product=${product.id}&item=${item.key}`);
    const panel = page.getByRole("region", { name: "执行记录", exact: true });
    await expect(panel.locator(".execution-history > summary .record-summary")).toHaveText("执行记录（1）");
    if (failDelivery) await expect(panel.getByRole("alert")).toContainText("执行记录加载失败", { timeout: 15000 });
    await panel.locator(".execution-history > summary").click();
    await panel.locator(".execution-record > summary").click();
    await expect(panel.getByText("唯一通知", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "补发通知", exact: true })).toHaveCount(0);
  });
}
