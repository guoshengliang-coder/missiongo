import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "and-310-plan-approval";
const stamp = "2026-10-30T01:00:00.000Z";
const offer = { plan: "计划：添加快捷批准并测试。\n以上计划等待批准。", revision: "observed-context", evidence: "以上计划等待批准。", reason: "方案明确且没有待答问题。" };
const summary = {
  id, agentSessionId: id, dispatchId: "fixture-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp, nodeId: "fixture-node", settings: {}, unread: false,
  items: [{ key: "AND-310", title: "快捷批准", productId: fixture.productId }],
  activities: [], turnState: { turnActive: false }, canReply: true, canRetry: false, canStop: false, canArchive: true,
  attention: { state: "needed", kind: "approval", reason: "方案待批准", revision: "attention-revision" }, needsAttention: true, waitingForReply: true,
};

for(const width of [320,1440]) for(const theme of ["light","dark"] as const) test.describe(`registered dispatch offline ${width}px ${theme}`,()=>{
  test.use({viewport:{width,height:900},colorScheme:theme,hasTouch:width===320,isMobile:width===320});
  test("saves approval separately from the unavailable native channel and shows recovery instructions",async({page},info)=>{
    const offline={...summary,id:"offline-dispatch",agentSessionId:"offline-dispatch",source:"dispatch",status:"unavailable",canReply:false,
      nodeConnectionState:"offline",lastError:"Codex rejected thread/read: thread not loaded: exact-original-thread"};
    let approved=false,posts=0;
    await page.route("**/api/v1/agent-sessions**",async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.endsWith("/plan-approval") && route.request().method()==="POST") {
        posts++;approved=true;return route.fulfill({status:201,json:{approved:true,revision:"explicit-offline",continuationQueued:false,continuationPending:true}});
      }
      if(route.request().method()!=="GET") return route.fulfill({status:204});
      const plan={revision:"explicit-offline",plan:"明确登记的派单实施方案",validation:"核实接手授权和实施模式",itemKeys:["AND-310"]};
      const detail={...offline,messages:[],canApprovePlan:!approved,implementationPlan:{...plan,approved,valid:true},
        planApprovalStatus:{code:approved?"approved":"ready"},...(approved?{planApprovalState:{approved:true,revision:plan.revision,continuationQueued:false,continuationPending:true}}:{planApproval:plan})};
      return route.fulfill({json:path==="/api/v1/agent-sessions"?{sessions:[offline]}:detail});
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${offline.id}`);
    const banner=page.locator(".agent-plan-inline-approval");
    await expect(page.getByText(/该会话尚未加载到已连接的 Codex 运行时/)).toBeVisible();
    const button=banner.getByRole("button",{name:"批准",exact:true});await expect(button).toBeEnabled();
    await button.click();await expect(banner).toContainText("批准已保存，等待原连接恢复后续办一次");
    expect(posts).toBe(1);await expect(page.locator(".agent-console-message-outgoing")).toHaveCount(0);
    await expect(page.getByText("明确登记的派单实施方案",{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("offline-plan-approval.png")});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  });
});

for (const viewport of [{ width: 353, height: 757 }, { width: 1440, height: 900 }]) {
  test(`approval sends the fixed reply once and retains the draft and attachments at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let current: Record<string, unknown> = { ...summary, messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "计划：添加快捷批准并测试。\n以上计划等待批准。", occurredAt: stamp }], planApproval: offer, planApprovalStatus: { code: "ready" }, canAttach: true };
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
        current = { ...current, planApproval: offer, planApprovalStatus: { code: "reply_pending" }, canApprovePlan: false, command };
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
    const button = page.getByRole("button", { name: /^(批准|Approve)$/ });
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
    await expect(button).toBeDisabled();
  });
}

test("an unavailable connection keeps approval visible but disabled; stale rejection is shown without clearing the draft", async ({ page }) => {
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
    const detail = { ...summary, messages: [{ id: "plan", sourceId: "plan", role: "agent", text: "当前方案待批准", occurredAt: stamp }], planApprovalStatus: { code: allowed ? "ready" : "connection_unavailable" }, planApproval: offer };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail) });
  });
  const open = () => page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
  await open();
  const button = page.getByRole("button", { name: /^(批准|Approve)$/ });
  await expect(page.locator(".agent-plan-inline-approval")).toBeVisible();
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  allowed = true;
  await page.reload();
  await expect(button).toBeVisible();
  const textarea = page.locator(".agent-console-reply textarea");
  await textarea.fill("保留草稿");
  await button.click();
  await expect(page.locator(".agent-plan-inline-approval [role=alert]")).toContainText(/待批内容已变化|approval request changed/);
  await expect(textarea).toHaveValue("保留草稿");
  await expect(button).toBeDisabled();
  expect(posts).toBe(1);
});

test("other yellow attention types do not offer the approval shortcut", async ({ page }) => {
  for (const kind of ["answer", "action", "instruction", "uncertain"]) {
    await page.route("**/api/v1/agent-sessions**", async route => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const current = { ...summary, attention: { ...summary.attention, kind }, messages: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [current] } : current) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    await expect(page.locator(".agent-console-attention-banner")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(批准|Approve)$/ })).toHaveCount(0);
    await page.unroute("**/api/v1/agent-sessions**");
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`approval keeps a visible disabled action and connection reason on a narrow ${theme} screen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 353, height: 757 });
    await page.emulateMedia({ colorScheme: theme });
    await page.route("**/api/v1/agent-sessions**", async route => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      const current = { ...summary, canReply: false, planApproval: offer, planApprovalStatus: { code: "connection_unavailable" }, messages: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [current] } : current) });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const banner = page.locator(".agent-plan-inline-approval");
    await expect(banner.getByRole("button", { name: /^(批准|Approve)$/ })).toBeDisabled();



    await expect(banner).toContainText(/会话连接当前不可用|connection is unavailable/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await banner.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`approval-reason-${theme}.png`) });
  });
}

// A submitted proposal remains available even when the conversation
// still has uncertainties. Show the review boundary rather than certify quality.
for (const theme of ["light", "dark"] as const) {
  test.describe(`research review ${theme}`, () => {
    test.use({ hasTouch: true });
    test("keeps evidence and unresolved assumptions reviewable without approving automatically", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.emulateMedia({ colorScheme: theme });
      let approvals = 0;
      await page.route("**/api/v1/agent-sessions**", async route => {
        if (route.request().method() === "POST" && route.request().url().endsWith("/plan-approval")) approvals++;
        if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
        const current = { ...summary, planApproval: offer, planApprovalStatus: { code: "ready" }, messages: [
          { id: "evidence", sourceId: "evidence", role: "agent", occurredAt: stamp,
            text: "事实依据：已核对协议和历史测试。推荐：复用原会话关联。取舍：新增字段需要迁移。剩余不确定性：旧环境需在隔离实验中复现。" },
        ] };
        return route.fulfill({ status: 200, json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [current] } : current });
      });
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const banner = page.locator(".agent-plan-inline-approval");
      await expect(banner).toBeVisible();
      await expect(banner.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
      await expect(page.locator(".agent-console-message-agent").filter({ hasText: "剩余不确定性" })).toBeVisible();
      expect(approvals).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test("the public Skill download matches the versioned source without adding a new distribution format", async ({ request }) => {
  const response = await request.get("/downloads/missiongo-skill/SKILL.md");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/markdown");
  const source = readFileSync(fileURLToPath(new URL("../../skills/missiongo/SKILL.md", import.meta.url)), "utf8");
  const published = await response.text();
  expect(published).not.toContain("__MISSIONGO_PUBLIC_ORIGIN__");
  // Vite substitutes the configured public origin; production uses the same
  // single-file substitution in Docker. All workflow content must survive.
  expect(published.replaceAll(/https?:\/\/[^/\s`]+/g, "__MISSIONGO_PUBLIC_ORIGIN__")).toBe(source);
});

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`AND-405 offline approval ${width} ${theme}`, () => {
    test.use({ hasTouch: true });
    test("saves the decision without a native reply and never invents delivery or asks twice", async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const external = { ...summary, id: "external-preclaim", agentSessionId: "external-preclaim", dispatchId: undefined,
        source: "external", approvalOnly: true, progressStatus: "waiting_for_input", status: "stalled", mode: "external", dispatchStatus: "external", canReply: false,
        replyBlockedReason: "external_progress_only", nodeConnectionState: undefined };
      let approved = false, attempts = 0;
      let finish!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      await page.route("**/api/v1/agent-sessions**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === "POST" && path.endsWith("/plan-approval")) {
          attempts++;
          expect(request.postDataJSON()).toEqual({ revision: offer.revision });
          await held;
          approved = true;
          return route.fulfill({ status: 201, json: { approved: true, revision: offer.revision, continuationQueued: false, continuationPending: true } });
        }
        if (request.method() !== "GET") return route.fulfill({ status: 204 });
        const detail = { ...external, messages: [], canApprovePlan: !approved,
          implementationPlan: { revision: offer.revision, plan: "领取前审阅的明确实施方案", validation: "验证同一会话领取", itemKeys: ["AND-405"], approved, valid: true },
          planApprovalStatus: { code: approved ? "approved" : "ready" },
          ...(approved ? { planApprovalState: { approved: true, revision: offer.revision, continuationQueued: false, continuationPending: true } }
            : { planApproval: { ...offer, plan: "领取前审阅的明确实施方案", validation: "验证同一会话领取", itemKeys: ["AND-405"] } }) };
        return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [external] } : detail });
      });
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${external.id}`);
      const banner = page.locator(".agent-plan-inline-approval");
      const button = banner.getByRole("button", { name: "批准", exact: true });
      await expect(button).toBeEnabled();
      await expect(page.locator(".agent-console-connection-banner")).toContainText("领取前方案审批");

      await expect(page.locator("article[data-agent-message-id]").filter({ has: page.locator(".agent-plan-inline-approval") })).toContainText("领取前审阅的明确实施方案");
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
        await expect(button).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await button.dblclick();
      await expect.poll(() => attempts).toBe(1);
      finish();
      await expect(banner).toContainText("方案已批准");
      await expect(banner).toContainText("批准已保存，等待原连接恢复后续办一次");
      await expect(banner).not.toContainText("方案待批准");
      await expect(button).toHaveCount(0);
      await expect(page.locator(".agent-console-message-outgoing")).toHaveCount(0);
      await page.reload();
      await expect(page.locator(".agent-plan-inline-approval")).toContainText("方案已批准");
      expect(attempts).toBe(1);
      await expect(page.locator(".agent-console-attention-banner").getByRole("button",{name:"无需处理"})).toHaveCount(0);

      await page.screenshot({ path: testInfo.outputPath(`and405-offline-${width}-${theme}.png`) });
    });
  });
}

for (const viewport of [{ width: 320, height: 900, theme: "dark" }, { width: 1440, height: 900, theme: "light" }] as const) {
  test(`approval acknowledgement ends on native continuation at ${viewport.width}px`, async ({ page }) => {
    const { advanceSessionDetailPoll } = await import("./polling");
    await page.clock.install();
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport.theme });
    for (const agentKind of ["codex", "claude_code", "opencode", "hermes"]) {
      let phase: "queued" | "active" | "idle" | "action" | "new-plan" = "queued";
      const approvedAt = "2026-10-30T01:01:00.500Z", resumedAt = "2026-10-30T01:02:00Z";
      const detail = () => ({ ...summary, agentKind, status: phase === "active" ? "active" : "idle",
        attention: phase === "action" ? { state: "needed", kind: "action", reason: "请处理新的独立事项" } : summary.attention,
        messages: [{ id: "original-plan", sourceId: "original-plan", role: "plan", text: "保留这份方案正文", occurredAt: stamp }],
        implementationPlan: { revision: phase === "new-plan" ? "new-revision" : "reviewed", plan: "保留这份方案正文", validation: "确认正文保留", itemKeys: [], approved: phase !== "new-plan", valid: true,
          submittedAt: stamp, ...(phase !== "new-plan" ? { approvedAt } : {}) },
        ...(phase !== "new-plan" ? { planApprovalState: { approved: true, revision: "reviewed", continuationQueued: true } }
          : { planApproval: { revision: "new-revision", plan: "保留这份方案正文", reason: "新方案等待批准" } }),
        planApprovalStatus: { code: phase === "new-plan" ? "ready" : "approved" },
        command: { id: "continue", kind: "message", text: "批准", status: phase === "queued" ? "queued" : "delivered", createdAt: approvedAt },
        turnState: { turnActive: phase === "active", turnStartedAt: phase === "queued" ? stamp : resumedAt,
          ...(phase === "idle" || phase === "action" ? { lastOutputAt: resumedAt } : {}) },
      });
      await page.route("**/api/v1/agent-sessions**", route => route.request().method() !== "GET" ? route.fulfill({ status: 204 })
        : route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [detail()] } : detail() }));
      await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
      const banner = page.locator(".agent-console-attention-banner--approval");
      const plan = page.locator("article[data-agent-message-id]").filter({ has: page.locator(".agent-plan-inline-approval") });
      await expect(plan).toContainText("方案已批准");
      phase = "active";
      await advanceSessionDetailPoll(page);
      await expect(banner).toHaveCount(0);
      await expect(plan).toContainText("方案已批准");
      phase = "idle";
      await advanceSessionDetailPoll(page);
      await expect(banner).toHaveCount(0);
      await page.reload();
      await expect(plan).toContainText("方案已批准");
      await expect(banner).toHaveCount(0);
      phase = "action";
      await page.reload();
      const attention = page.locator(".agent-console-attention-banner");
      await expect(attention).toBeVisible();
      await attention.locator("summary").click();
      await expect(attention).toContainText("请处理新的独立事项");
      await expect(attention.locator("summary")).not.toHaveText("方案已批准");
      phase = "new-plan";
      await page.reload();
      await expect(plan.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
      await page.unroute("**/api/v1/agent-sessions**");
    }
  });
}
