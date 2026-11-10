import { expect, test } from "@playwright/test";

for (const surface of ["console", "panel"] as const) for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`local completion offers delivery on ${surface} ${width} ${theme}`, async ({ page, request }, testInfo) => {
    await page.clock.setFixedTime(new Date("2026-11-08T10:45:00.000Z"));
    await page.setViewportSize({ width, height: 950 }); await page.emulateMedia({ colorScheme: theme });
    const product = await (await request.post("/api/v1/products", { data: { name: "Local delivery", keyPrefix: `LP${surface[0]!.toUpperCase()}${width}${theme[0]!.toUpperCase()}` } })).json();
    const item = await (await request.post("/api/v1/items", { data: { productId: product.id, type: "task", priority: "normal", status: "ready", title: "Local completion", description: "Fixture", environment: { platform: "web" } } })).json();
    const id = "prepare-session", stamp = "2026-11-08T10:43:09.626Z";
    const report = { id: "final", sourceId: "final", role: "agent", phase: "final_answer", occurredAt: stamp, text: "已按批准方案完成并本地提交 `06a98a04`：\n\n- 列表隐藏派单标签，详情保留“派单会话”。\n- 统一“派单会话／非派单会话”及筛选名称。\n- 完整检查、42 个相关 UI 场景通过，结果已回写条目。\n\n尚未推送、创建 PR、合并或发布；条目保持处理中。真实设备及线上效果待发布后验证。" };
    let history: typeof report[] = [];
    let latest = report, reject = true, commands = 0, currentCommand: unknown, registered = false;
    const summary = { id, agentSessionId: id, productId: product.id, dispatchId: "prep-dispatch", agentKind: "codex", status: "idle", createdAt: stamp, updatedAt: stamp,
      nodeName: "Fixture", nodeId: "node", nodeConnectionState: "online", mode: "auto", dispatchStatus: "launched", activities: [], settings: {}, unread: false,
      canReply: true, canRetry: false, canStop: false, canArchive: true, needsAttention: true,
      attention: { state: "needed", kind: "instruction", reason: "Waiting for instructions", revision: "attention" }, items: [{ key: item.key, title: item.title, productId: product.id }] };
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST" && path.endsWith("/commands")) {
        commands++; const body = route.request().postDataJSON();
        expect(body.text).toContain("06a98a04"); expect(body.text).toContain("不要执行合并或发布"); expect(body.text).toContain("我授权推送");
        // Definite rejection keeps the guide retryable; 5xx requires result recovery.
        if (reject) return route.fulfill({ status: 400, json: { title: "Synthetic send failure" } });
        currentCommand = { id: "submitted", kind: "message", text: body.text, status: "queued", createdAt: "2026-11-08T10:45:00.000Z" };
        return route.fulfill({ json: currentCommand });
      }
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary, messages: [...history, latest], command: currentCommand } });
    });
    await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: summary.dispatchId, agentSessionId: id, agentKind: "codex", mode: "auto", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [item.key] }] } }));
    await page.route(/\/merge-deliveries(?:\?.*)?$/, route => route.fulfill({ json: { deliveries: [], batches: [], attentionSessionIds: registered ? [id] : [] } }));
    const open = async () => {
      if (surface === "console") await page.goto(`/?product=${product.id}&console=agent&session=${id}`);
      else { await page.goto(`/?product=${product.id}&item=${item.key}`); await page.locator(".execution-history > summary").click(); await page.locator(".execution-record > summary").filter({ hasText: "Fixture" }).click(); await page.locator(".agent-session-toggle").click(); }
    };
    await open();
    const notice = page.getByRole("status", { name: "本地修改已完成，是否提交到待集成？" });
    await expect(notice).toBeVisible(); await expect(notice).toContainText("不会立即合并或发布");
    await expect(page.locator(".agent-console-attention-banner")).toHaveCount(0);
    const draft = page.locator(surface === "console" ? ".agent-console-reply textarea" : ".agent-session-reply textarea");
    await draft.fill("保留我的下一条草稿");
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const button of await notice.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath("local-merge-guide.png"), fullPage: true });
    // A send failure leaves the guide retryable and never consumes the chat draft.
    await notice.getByRole("button", { name: "提交到待集成", exact: true }).click();
    await expect(notice.getByRole("alert")).toBeVisible(); await expect(draft).toHaveValue("保留我的下一条草稿"); expect(commands).toBe(1);
    // Revalidation sees a different message even before the background detail poll catches up.
    latest = { ...report, id: "changed", text: "接下来先调整范围。" };
    await notice.getByRole("button", { name: "提交到待集成", exact: true }).click();
    await expect(notice).toHaveCount(0); expect(commands).toBe(1);
    latest = report; reject = false; await open(); await expect(notice).toBeVisible(); await draft.fill("仍保留草稿");
    await notice.getByRole("button", { name: "提交到待集成", exact: true }).dblclick();
    await expect(notice).toHaveCount(0); await expect(draft).toHaveValue("仍保留草稿"); expect(commands).toBe(2);
    await expect(page.getByText("已加入待集成清单", { exact: true })).toHaveCount(0);
    // A dismissed guide stays dismissed across reload; a changed completion gets a new guide.
    currentCommand = undefined; latest = { ...report, id: "second" }; await open(); await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "暂不提交" }).click(); await open(); await expect(notice).toHaveCount(0);
    latest = { ...report, id: "third" }; registered = true; await open(); await expect(notice).toHaveCount(0);
    expect(commands).toBe(2);
    // A clean read-only review offers a fresh choice after the earlier guide was dismissed.
    registered = false;
    history = [{ ...report, id: "second" }, { ...report, id: "review-request", role: "user", text: "做一次审计检查" }];
    latest = { ...report, id: "review-result", text: "复审完成，未发现新的需补修问题。本轮未修改代码，未推送、合并或发布。" };
    await open(); await expect(notice).toBeVisible();
    // Revalidate the source completion too, even though the latest review did not change.
    history[0] = { ...report, id: "second", text: "审计发现问题，仍需补修。" };
    await notice.getByRole("button", { name: "提交到待集成", exact: true }).click();
    await expect(notice).toHaveCount(0); expect(commands).toBe(2);
  });
}
