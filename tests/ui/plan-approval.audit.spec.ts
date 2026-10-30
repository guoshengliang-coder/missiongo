import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "and-310-plan-approval";
const stamp = "2026-10-30T01:00:00.000Z";
const offer = { revision: "observed-context", evidence: "以上计划等待批准。", reason: "方案明确且没有待答问题。" };
const summary = {
  id, agentSessionId: id, dispatchId: "fixture-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp, nodeId: "fixture-node", settings: {}, unread: false,
  items: [{ key: "AND-310", title: "快捷批准", productId: fixture.productId }],
  activities: [], turnState: { turnActive: false }, canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "needed", kind: "approval", reason: "方案待批准", revision: "attention-revision" }, needsAttention: true, waitingForReply: true,
};

for (const viewport of [{ width: 353, height: 757 }, { width: 1440, height: 900 }]) {
  test(`approval sends the fixed reply once and retains the draft and attachments at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let current: Record<string, unknown> = { ...summary, messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "计划：添加快捷批准并测试。\n以上计划等待批准。", occurredAt: stamp }], planApproval: offer, canAttach: true };
    const posts: { url: string; body: unknown }[] = [];
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/plan-approval")) {
        posts.push({ url: path, body: request.postDataJSON() });
        await held;
        const command = { id: "approved", kind: "message", text: "批准", status: "queued", createdAt: stamp };
        current = { ...current, planApproval: undefined, command };
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(command) });
      }
      if (request.method() === "POST" && !path.endsWith("/read")) posts.push({ url: path, body: request.postData() });
      if (request.method() !== "GET") return route.fulfill({ status: 204 });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [summary] } : current) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const textarea = page.locator(".agent-console-reply textarea");
    await textarea.fill("保留这段尚未发送的补充说明");
    await page.locator('input[type="file"]').last().setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("unsent attachment") });
    const button = page.locator(".agent-console-attention-banner").getByRole("button", { name: /^(批准|Approve)$/ });
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`approval-${viewport.width}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach("approval", { path, contentType: "image/png" });
    await button.dblclick();
    await expect.poll(() => posts.length).toBe(1);
    finish();
    await expect(page.locator(".agent-console-message-outgoing")).toContainText("批准");
    await expect(textarea).toHaveValue("保留这段尚未发送的补充说明");
    await expect(page.locator(".agent-console-reply")).toContainText("draft.txt");
    expect(posts).toEqual([{ url: `/api/v1/agent-sessions/${id}/plan-approval`, body: { revision: offer.revision } }]);
    await expect(button).toHaveCount(0);
  });
}

test("a label without an AI offer never enables approval; stale rejection is shown without clearing the draft", async ({ page }) => {
  let allowed = false;
  let posts = 0;
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.endsWith("/plan-approval")) {
      posts++; allowed = false;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "agent_plan_approval_changed", title: "changed" }) });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 204 });
    const detail = { ...summary, messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "当前方案待批准", occurredAt: stamp }], ...(allowed ? { planApproval: offer } : {}) };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail) });
  });
  const open = () => page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  await open();
  const button = page.locator(".agent-console-attention-banner").getByRole("button", { name: /^(批准|Approve)$/ });
  await expect(page.locator(".agent-console-attention-banner")).toBeVisible();
  await expect(button).toHaveCount(0);
  allowed = true;
  await page.reload();
  await expect(button).toBeVisible();
  const textarea = page.locator(".agent-console-reply textarea");
  await textarea.fill("保留草稿");
  await button.click();
  await expect(page.locator(".agent-console-message-outgoing")).toContainText(/待批内容已变化|approval request changed/);
  await expect(textarea).toHaveValue("保留草稿");
  await expect(button).toHaveCount(0);
  expect(posts).toBe(1);
});

test("text answers to two historical questions allow approval; a new pending question removes it and explains why", async ({ page }) => {
  await page.setViewportSize({ width: 353, height: 757 });
  let newQuestion = false;
  const messages = [
    { id: "q1", sourceId: "q1", role: "agent", text: "范围选局部还是全部？", questions: [{ title: "范围", options: ["局部", "全部"] }], occurredAt: stamp },
    { id: "a1", sourceId: "a1", role: "user", text: "全部", occurredAt: stamp },
    { id: "q2", sourceId: "q2", role: "agent", text: "原生还是统一自定义？", questions: [{ title: "实现", options: ["原生", "统一自定义"] }], occurredAt: stamp },
    { id: "a2", sourceId: "a2", role: "user", text: "统一自定义", occurredAt: stamp },
    { id: "plan", sourceId: "plan", role: "agent", text: "方案：全产品统一自定义控件。两项选择均已明确，无新增问题。以上计划等待批准。", occurredAt: stamp },
  ];
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    const detail = { ...summary, messages: [...messages, ...(newQuestion ? [{ id: "q3", sourceId: "q3", role: "agent", text: "还需选择发布范围", occurredAt: stamp }] : [])],
      planApprovalStatus: { code: newQuestion ? "needs_answer" : "ready" }, ...(newQuestion ? {} : { planApproval: offer }) };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail) });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  const banner = page.locator(".agent-console-attention-banner");
  const button = banner.getByRole("button", { name: /^(批准|Approve)$/ });
  await expect(button).toBeVisible();
  newQuestion = true;
  await expect(button).toHaveCount(0);
  await banner.locator("summary").click();
  await expect(banner).toContainText(/当前仍有待回答的问题|questions or choices to resolve/);
});

for (const theme of ["light", "dark"] as const) {
  test(`unavailable approval has an inspectable reason on a narrow ${theme} screen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 353, height: 757 });
    await page.emulateMedia({ colorScheme: theme });
    let code = "checking";
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const detail = { ...summary, messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "明确方案等待批准。", occurredAt: stamp }], planApprovalStatus: { code } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail) });
    });
    for (const [next, expected] of [
      ["checking", /正在识别方案|Checking whether/],
      ["needs_answer", /当前仍有待回答的问题|questions or choices to resolve/],
      ["uncertain", /尚不能确认一份明确|single, definite plan/],
      ["context_too_large", /超过识别容量|exceed the recognition limit/],
      ["recognition_failed", /方案识别暂时失败|Plan recognition failed/],
      ["connection_unavailable", /会话连接当前不可用|connection is unavailable/],
      ["ai_disabled", /会话 AI 识别未启用|recognition is not enabled/],
    ] as const) {
      code = next;
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const banner = page.locator(".agent-console-attention-banner");
      await expect(banner).toBeVisible();
      await expect(banner.getByRole("button", { name: /^(批准|Approve)$/ })).toHaveCount(0);
      const summary = banner.locator("summary");
      await summary.click();
      await expect(banner.locator("p").last()).toContainText(expected);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (code === "recognition_failed") {
        const path = testInfo.outputPath(`approval-reason-${theme}.png`);
        await banner.scrollIntoViewIfNeeded();
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach("approval-reason", { path, contentType: "image/png" });
      }
    }
  });
}
