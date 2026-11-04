import { expect, test } from "@playwright/test";

for (const width of [320, 768, 1023, 1024, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
  test.use({ hasTouch: width <= 768, isMobile: width <= 768 });
  test(`AND-369 search, association and itemless reply lifecycle at ${width}px ${theme}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const product = (await request.post("/api/v1/products", { data: { name: "Rework project", keyPrefix: `RW${width}${theme[0]}` } })).json();
    const { id: productId } = await product;
    const stamp = new Date().toISOString();
    const base = {
      agentKind: "codex", status: "active", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
      nodeName: "Fixture Mac", nodeId: "fixture-node", nodeConnectionState: "online", nodeRevoked: false,
      mode: "plan", dispatchStatus: "launched", activities: [], canReply: true, canArchive: true,
      attention: { state: "not_needed" }, needsAttention: false, unread: false,
      settings: { mode: "plan", adjustable: true },
    };
    let stage = "starting";
    let posts = 0;
    const itemless = () => ({ ...base, id: "unlinked", agentSessionId: "unlinked", dispatchId: "free-dispatch",
      productId, sessionName: "项目讨论", items: [], canReply: stage !== "starting",
      dispatchStatus: stage === "starting" ? "delivered" : "launched",
      ...(stage === "starting" ? { replyBlockedReason: "starting" } : {}),
      settings: { ...base.settings, adjustable: stage !== "starting" } });
    const linked = { ...base, id: "linked", agentSessionId: "linked", dispatchId: "item-dispatch",
      sessionName: "条目任务", items: [{ key: "RW-1", title: "关联条目", productId }] };
    await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: base.nodeId,
      agents: [{ kind: "codex", models: [{ id: "fixture", label: "Fixture Model", efforts: ["high"] }] }] }] } }));
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/commands")) {
        posts++;
        stage = "queued";
        return route.fulfill({ status: 201, json: { id: "followup", kind: "message", text: "继续", status: "queued", createdAt: stamp } });
      }
      const session = path.endsWith("/linked") ? linked : itemless();
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [itemless(), linked] } : {
        ...session, canAttach: true, messages: [],
        ...(stage === "queued" ? { command: { id: "followup", kind: "message", text: "继续", status: "queued", createdAt: stamp } } : {}),
      } });
    });
    await page.goto(`/?product=${productId}&console=agent`);
    const rows = page.locator(".agent-console-session");
    const association = page.getByRole("combobox", { name: "关联条目筛选", exact: true });
    await expect(association).toHaveAttribute("data-value", "all");
    await expect(rows).toHaveCount(2);
    await association.click();
    await page.getByRole("option", { name: "无关联会话", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("项目讨论");
    await association.click();
    await page.getByRole("option", { name: "关联会话", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("RW-1");
    await association.click();
    await page.getByRole("option", { name: "全部", exact: true }).click();
    const search = page.locator(".agent-console-search input");
    if (width <= 1023) await page.locator(".agent-console-search-trigger").click();
    await expect(search).toBeVisible();
    await search.fill("项目讨论");
    await expect(rows).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`and369-search-${width}-${theme}.png`) });
    if (width <= 1023) {
      await page.locator(".agent-console-search-close").click();
      await expect(page.locator(".agent-console-search-trigger")).toBeFocused();
      await expect(rows).toHaveCount(1);
      await page.locator(".agent-console-search-trigger").click();
      await expect(search).toHaveValue("项目讨论");
    }
    await search.fill("");
    if (width <= 1023) await search.press("Escape");
    await rows.filter({ hasText: "项目讨论" }).click();
    const reply = page.locator(".agent-console-reply textarea");
    await expect(reply).toBeVisible();
    await expect(reply).toBeDisabled();
    await expect(page.locator(".agent-console-reply")).toContainText("正在启动 Agent");
    await expect(page.locator(".agent-console-dispatch-head")).toHaveCount(0);
    stage = "running";
    await page.reload();
    await expect(reply).toBeEnabled();
    await expect(page.locator(".agent-console-reply .agent-settings-model")).toBeVisible();
    await reply.fill("继续");
    await page.locator(".agent-console-reply button[type=submit]").click();
    await expect(reply).toBeDisabled();
    expect(posts).toBe(1);
    await expect(page.locator(".agent-console-reply")).not.toContainText("关联工作已全部完成");
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const topbar = page.locator(".agent-console-topbar");
      expect(await topbar.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`and369-${width}-${theme}.png`) });
    await page.goto(`/?product=${productId}&console=agent&session=linked`);
    await expect(page.locator(".agent-console-dispatch-head")).toContainText("RW-1");
  });
  });
}
