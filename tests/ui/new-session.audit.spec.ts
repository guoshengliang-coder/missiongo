import { expect, test } from "@playwright/test";
import { solidPng } from "../../scripts/seed-ui-fixture.mjs";
import { openConsoleSearch } from "./console-helpers";

for (const width of [375, 768, 1440]) {
  test(`project conversation retains a local draft and retries first send once at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const product = await (await request.post("/api/v1/products", { data: { name: `Project conversation ${width}`, keyPrefix: `PC${width}` } })).json();
    const now = "2026-11-09T06:00:00.000Z";
    await page.clock.setFixedTime(new Date(now));
    const node = { id: "fixture-node", name: "Fixture Mac", online: true, supportsFreeSessions: true, supportsChatAttachments: true,
      agents: [{ kind: "codex", planApprovalProtocol: 1, ready: true, models: [{ id: "draft-beta", label: "Draft Beta", efforts: ["low", "high"] }] }], repos: [{ productId: product.id, repoPath: "fixture-repository" }], repoCandidates: [], createdAt: now };
    await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node] } }));
    await page.route("**/api/v1/dispatch-defaults", route => route.fulfill({ json: { nodeId: node.id, agentKind: "codex", agents: { codex: { mode: "auto" } } } }));
    let prepareCount = 0, uploadCount = 0, startCount = 0;
    let started = false;
    const dispatch = { id: "free-dispatch", agentSessionId: "free-session", productId: product.id, nodeId: node.id, nodeName: node.name,
      agentKind: "codex", mode: "auto", status: "queued", itemKeys: [], createdAt: now };
    const summary = { ...dispatch, id: "free-session", dispatchId: dispatch.id, status: "active", dispatchStatus: "queued",
      items: [], activities: [], updatedAt: now, activityAt: now, canReply: false, canArchive: true, canStop: true, canRetry: false,
      sessionName: "先讨论这个方案", unread: false, attention: { state: "not_needed" }, nodeConnectionState: "online", nodeRevoked: false,
      settings: {}, command: { id: "first", kind: "message", text: "先讨论这个方案", status: "queued", createdAt: now } };
    await page.route("**/api/v1/agent-sessions**", async route => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST" && url.pathname.endsWith("/attachments")) {
        uploadCount++;
        return route.fulfill({ status: 201, json: { id: "first-file", filename: "notes.txt", kind: "document", contentType: "text/plain", sizeBytes: 5, sha256: "synthetic", createdAt: now } });
      }
      const detail = { ...summary, messages: [], canResolveDelivery: true };
      return route.fulfill({ json: url.pathname === "/api/v1/agent-sessions" ? { sessions: started ? [summary] : [] } : detail });
    });
    await page.route("**/api/v1/project-conversations**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/start")) {
        startCount++;
        if (startCount === 1) return route.fulfill({ status: 503, json: { title: "Synthetic unavailable" } });
        expect(route.request().postDataJSON().attachmentIds).toEqual(["first-file"]);
        started = true;
        return route.fulfill({ json: { ...dispatch, startReady: true } });
      }
      prepareCount++;
      if (width === 1440 && prepareCount === 1) return route.fulfill({ status: 409, json: { code: "node_offline", title: "This node is offline" } });
      expect(route.request().postDataJSON()).toMatchObject({ productId: product.id, nodeId: node.id, agentKind: "codex", mode: "auto", model: "draft-beta", effort: "high", text: "先讨论这个方案" });
      return route.fulfill({ status: 201, json: dispatch });
    });
    const openNew = async (name = "新会话") => {
      const direct = page.locator(".agent-console-topbar-new");
      await expect(direct).toHaveCount(1);
      if (await direct.isVisible()) await direct.click();
      else { await page.locator(".agent-console-topbar-more > summary").click(); await page.locator(".agent-console-topbar-more-menu").getByRole("button", { name, exact: true }).click(); }
    };
    await page.goto(`/?product=${product.id}&console=agent`);
    await openNew();
    const form = page.locator(".dispatch-form");
    await expect(form.getByRole("combobox", { name: "Agent", exact: true })).toHaveAttribute("data-value", "codex");
    await expect(form).not.toContainText("讨论模式");
    await page.screenshot({ path: testInfo.outputPath(`new-session-config-${width}.png`) });
    await form.getByRole("button", { name: "进入会话", exact: true }).click();
    const draft = page.locator(".agent-console-reply textarea");
    await expect(draft).toBeVisible();
    await draft.fill("先讨论这个方案");
    if (width === 768) {
      await openConsoleSearch(page);
      const search = page.locator(".agent-console-search input");
      await search.fill("过滤");
      await search.press("Escape");
      await expect(page.locator(".agent-console-topbar-more > summary")).toBeFocused();
      await expect(draft).toHaveValue("先讨论这个方案");
      await openConsoleSearch(page);
      await expect(search).toHaveValue("过滤");
      await search.fill("");
      await search.press("Escape");
    }
    const replyBar = page.locator(".agent-console-reply");
    await replyBar.getByRole("combobox", { name: "模型", exact: true }).click();
    await page.getByRole("option", { name: "Draft Beta", exact: true }).click();
    const effort = replyBar.locator(".agent-settings-effort");
    if (await effort.isVisible()) await effort.click();
    else {
      await replyBar.getByRole("button", { name: "更多操作", exact: true }).click();
      await replyBar.locator(".agent-settings-more-panel").getByRole("combobox", { name: "强度", exact: true }).click();
    }
    await page.getByRole("option", { name: "高", exact: true }).click();
    await page.locator(".new-session-head").getByRole("button", { name: "配置", exact: true }).click();
    await expect(form.getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("data-value", "draft-beta");
    await expect(form.getByRole("combobox", { name: "强度", exact: true })).toHaveAttribute("data-value", "high");
    await form.getByRole("button", { name: "进入会话", exact: true }).click();
    await page.locator(".agent-console-reply input[type=file]").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: solidPng(160, 90, [214, 226, 240]) });
    const preview = page.getByRole("button", { name: "预览 draft.png", exact: true });
    await preview.click();
    await expect(page.locator(".selected-media-lightbox .zoomable-image")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeFocused();
    await expect(draft).toHaveValue("先讨论这个方案");
    await page.getByRole("button", { name: "移除 draft.png", exact: true }).click();
    await page.locator(".agent-console-reply input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
    await page.screenshot({ path: testInfo.outputPath(`new-session-draft-${width}.png`) });
    expect(prepareCount).toBe(0);
    expect(await page.locator(".agent-console-conversation").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // Both browser back and the in-pane return retain the local draft, without creating history.
    await page.goBack();
    await expect(page.locator(".new-session-head")).toHaveCount(0);
    await openNew("继续新会话");
    await expect(draft).toHaveValue("先讨论这个方案");
    await expect(page.locator(".agent-chat-draft-files")).toContainText("notes.txt");
    if (width === 1440) await draft.press("Enter");
    else await page.locator(".agent-console-reply button[type=submit]").click();
    await expect(page.locator(".agent-console-reply [role=alert]")).toBeVisible();
    await expect(draft).toHaveValue("先讨论这个方案");
    if (width === 1440) {
      await expect(draft).toBeEnabled();
      await page.locator(".agent-console-reply button[type=submit]").click();
      await expect(draft).toBeDisabled();
      await expect(page.locator(".agent-console-reply [role=alert]")).toBeVisible();
    }
    await page.locator(".agent-console-reply button[type=submit]").click();
    await expect(page.locator(".new-session-head")).toHaveCount(0);
    await expect(page.locator(".agent-console-conversation")).toContainText("先讨论这个方案");
    expect(prepareCount).toBe(width === 1440 ? 2 : 1);
    expect(uploadCount).toBe(1);
    expect(startCount).toBe(2);
    // A queued first message must not disable recovery after native launch fails.
    summary.status = "failed";
    summary.dispatchStatus = "failed";
    summary.canRetry = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "重试启动", exact: true })).toBeEnabled();
    if (width === 375) {
      await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
      await expect(page.locator(".agent-console-list")).toBeVisible();
    }
    await page.locator(".agent-console-topbar-back").click();
    await expect(page).not.toHaveURL(/console=agent/);
    await page.goForward();
    await expect(page).toHaveURL(/console=agent/);
  });
}
