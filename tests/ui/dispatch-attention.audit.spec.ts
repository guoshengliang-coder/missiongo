import { expect, test } from "@playwright/test";

const inactive = ["inbox", "development_complete", "pending_verification", "done", "cancelled", "on_hold"] as const;

for (const width of [375, 1440]) {
  for (const status of [...inactive, "ready", "in_progress"] as const) {
    test(`${width}px ${status}: current attention and historical failure stay separate`, async ({ page, request }, testInfo) => {
      await page.setViewportSize({ width, height: 950 });
      const productResponse = await request.post("/api/v1/products", { data: { name: `Attention ${status} ${width}`, keyPrefix: `DA${width}${[...inactive, "ready", "in_progress"].indexOf(status)}` } });
      expect(productResponse.ok()).toBeTruthy();
      const product = await productResponse.json();
      const item = await (await request.post("/api/v1/items", { data: { productId: product.id, status: "ready", environment: { platform: "web" }, type: "task", priority: "normal", title: "按工作阶段展示异常", description: "独立的派单与执行记录" } })).json();
      const isCurrent = status === "ready" || status === "in_progress";
      const error = "对应派单的失败原因";
      const stamp = new Date().toISOString();
      const summary = { dispatchId: "attention-dispatch", itemKey: item.key, nodeName: "Test Mac", agentKind: "codex", status: status === "in_progress" ? "launched" : "failed", createdAt: stamp };
      // An intentionally stale ready-stage issue must not leak into inactive phases.
      const current = { ...summary, itemStatus: status === "in_progress" ? status : "ready", issue: { kind: status === "in_progress" ? "execution" : "dispatch", reason: error } };
      const dispatch = { id: summary.dispatchId, nodeId: "test-node", ...summary, mode: "plan", itemKeys: [item.key], agentSessionId: "attention-session", error };
      await page.route(/\/api\/v1\/(?:items|bootstrap)\?/, async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.items = data.items.map((row: { key: string }) => row.key === item.key ? { ...row, status } : row);
        await route.fulfill({ response, json: data });
      });
      await page.route(`**/api/v1/items/${item.key}`, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), status } });
      });
      await page.route("**/api/v1/dispatches/active", route => route.fulfill({ json: { active: [], latest: [summary], current: [current], handlers: [] } }));
      await page.route(`**/api/v1/items/${item.key}/dispatches`, route => route.fulfill({ json: { dispatches: [dispatch], current } }));
      await page.goto(`/?product=${product.id}&status=ready`);
      const row = page.locator(".item-row").filter({ hasText: item.key });
      if (isCurrent) {
        const badge = row.locator(".item-dispatch-badge");
        await expect(badge).toHaveText(status === "ready" ? "派单失败" : "执行异常");
        await expect(badge).toHaveAttribute("title", new RegExp(error));
      } else {
        await expect(row.locator(".item-dispatch-badge")).toHaveCount(0);
        await expect(row.locator(".item-handler-badge")).toHaveText("历史 · Codex · Test Mac");
        await expect(row.locator(".item-handler-badge")).not.toHaveAttribute("title", /失败/);
      }
      await row.locator(".item-row-main").click();
      const header = page.locator(".detail-dispatch-line");
      await expect(header).toContainText("Codex · Test Mac");
      await expect(header.getByRole("button", { name: "在控制台查看", exact: true })).toHaveCount(1);
      if (isCurrent) {
        await expect(header).toHaveClass(/failed/);
        await expect(header).toContainText(status === "ready" ? "派单失败" : "执行异常");
        await expect(header).toContainText(error);
      } else {
        await expect(header).not.toHaveClass(/failed/);
        await expect(header).not.toContainText(/失败|执行异常/);
        await expect(header).not.toContainText(error);
      }
      const history = page.locator(".execution-history");
      await history.locator("summary").click();
      await expect(history).toContainText(error);
      expect(await page.locator(".detail-scroll").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      if (status === "pending_verification" || isCurrent) await page.screenshot({ path: testInfo.outputPath(`${status}.png`) });
    });
  }
}
