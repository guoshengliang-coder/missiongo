import { expect, test, type Page } from "@playwright/test";
import { chooseOption } from "./select-helpers";

const agents = [
  { kind: "claude_code", mode: "bypassPermissions" },
  { kind: "codex", mode: "auto" },
  { kind: "opencode", mode: "build" },
] as const;

async function openNew(page: Page) {
  const direct = page.locator(".agent-console-topbar-new");
  await expect(direct).toHaveCount(1);
  if (await direct.isVisible()) await direct.click();
  else {
    await page.locator(".agent-console-topbar-more > summary").click();
    await page.locator(".agent-console-topbar-more-menu").getByRole("button", { name: /新会话/, exact: true }).click();
  }
}

for (const viewport of [
  { width: 1440, theme: "light" as const, touch: false },
  { width: 320, theme: "dark" as const, touch: true },
]) for (const agent of agents) {
  test.describe(`${agent.kind} ${viewport.width}px ${viewport.theme} model effort`, () => {
    test.use({ viewport: { width: viewport.width, height: 950 }, colorScheme: viewport.theme, hasTouch: viewport.touch });
    test("drops stale defaults and keeps visible, saved and submitted choices identical", async ({ page, request }, testInfo) => {
      const product = await (await request.post("/api/v1/products", { data: { name: `Effort ${agent.kind} ${viewport.width}`, keyPrefix: `E${viewport.width}${agent.kind.slice(0, 2).toUpperCase()}` } })).json();
      const item = await (await request.post("/api/v1/items", { data: { productId: product.id, status: "ready", type: "task", priority: "normal", title: "模型强度联动", description: "Synthetic regression", environment: { platform: "web" } } })).json();
      const models = [
        { id: "flexible", label: "Flexible model", efforts: ["low", "high"] },
        { id: "limited", label: "Limited model", efforts: [] as string[] },
      ];
      const node = { id: "effort-node", name: "Fixture Mac", deviceName: "Fixture Mac", online: true, supportsFreeSessions: true,
        agents: [{ kind: agent.kind, planApprovalProtocol: 1, ready: true, models }],
        repos: [{ productId: product.id, repoPath: "fixture-repository" }], repoCandidates: [], createdAt: new Date().toISOString() };
      const otherNode = { ...node, id: "limited-device", name: "Limited device", agents: [{ ...node.agents[0]!, models: [{ ...models[0]!, efforts: ["low"] }, models[1]!] }] };
      let defaults = { nodeId: node.id, agentKind: agent.kind, agents: { [agent.kind]: { mode: agent.mode, model: "limited", effort: "high" } } };
      const submissions: Record<string, unknown>[] = [];
      await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node, otherNode] } }));
      await page.route("**/api/v1/dispatches/active", route => route.fulfill({ json: { active: [], latest: [], current: [], handlers: [] } }));
      await page.route("**/api/v1/dispatch-defaults", async route => {
        if (route.request().method() === "PUT") defaults = route.request().postDataJSON();
        await route.fulfill({ json: defaults });
      });
      await page.route("**/api/v1/dispatches", async route => {
        const input = route.request().postDataJSON();
        submissions.push(input);
        await route.fulfill({ status: 201, json: { ...input, id: "effort-dispatch", status: "queued", nodeName: node.name, createdAt: node.createdAt } });
      });
      await page.goto(`/?product=${product.id}&status=ready`);
      await page.locator(".item-row").filter({ hasText: item.key }).getByRole("checkbox").check();
      await page.getByRole("button", { name: "派单", exact: true }).click();
      const form = page.locator(".dispatch-form");
      const model = form.getByRole("combobox", { name: "模型", exact: true });
      const effort = form.getByRole("combobox", { name: "强度", exact: true });
      await expect(model).toHaveAttribute("data-value", "limited");
      await expect(effort).toHaveAttribute("data-value", "");
      await form.getByRole("checkbox", { name: "设为默认值", exact: true }).check();
      expect(defaults.agents[agent.kind].effort).toBe("high");
      await chooseOption(model, "flexible");
      await chooseOption(effort, "high");
      await expect(form.getByRole("checkbox", { name: "设为默认值", exact: true })).not.toBeChecked();
      await chooseOption(form.getByRole("combobox", { name: "设备", exact: true }), otherNode.id);
      await expect(effort).toHaveAttribute("data-value", "");
      await chooseOption(effort, "low");
      await chooseOption(form.getByRole("combobox", { name: "设备", exact: true }), node.id);
      await expect(effort).toHaveAttribute("data-value", "low");
      await chooseOption(effort, "high");
      await chooseOption(model, "limited");
      await expect(effort).toHaveAttribute("data-value", "");
      await expect(form).toContainText("已恢复为跟随本机配置");
      await page.screenshot({ path: testInfo.outputPath("compatible-effort.png") });
      expect(await form.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await form.getByRole("button", { name: "派单", exact: true }).click();
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toMatchObject({ model: "limited", mode: agent.mode, agentKind: agent.kind });
      expect(submissions[0]).not.toHaveProperty("effort");
    });

    test("new conversation draft reconciles a capability refresh before first send", async ({ page, request }) => {
      const product = await (await request.post("/api/v1/products", { data: { name: `Draft effort ${agent.kind} ${viewport.width}`, keyPrefix: `D${viewport.width}${agent.kind.slice(0, 2).toUpperCase()}` } })).json();
      const models = [{ id: "mutable", label: "Mutable model", efforts: ["low", "high"] }];
      const node = { id: "draft-effort-node", name: "Fixture Mac", online: true, supportsFreeSessions: true,
        agents: [{ kind: agent.kind, planApprovalProtocol: 1, ready: true, models }],
        repos: [{ productId: product.id, repoPath: "fixture-repository" }], repoCandidates: [], createdAt: new Date().toISOString() };
      await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node] } }));
      await page.route("**/api/v1/dispatch-defaults", route => route.fulfill({ json: { nodeId: node.id, agentKind: agent.kind,
        agents: { [agent.kind]: { mode: agent.mode, model: "mutable", effort: "high" } } } }));
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: [] } }));
      let prepared: Record<string, unknown> | undefined;
      await page.route("**/api/v1/project-conversations", async route => {
        prepared = route.request().postDataJSON();
        await route.fulfill({ status: 503, json: { title: "Synthetic failure preserves draft" } });
      });
      await page.clock.install();
      await page.goto(`/?product=${product.id}&console=agent`);
      await openNew(page);
      await page.locator(".dispatch-form").getByRole("button", { name: "进入会话", exact: true }).click();
      const reply = page.locator(".agent-console-reply");
      await reply.locator("textarea").fill("能力刷新后保留这段草稿");
      models[0]!.efforts = ["low"];
      // Advance the normal node heartbeat interval instead of sleeping or
      // reaching into React state. The draft remains mounted throughout.
      await page.clock.fastForward(31_000);
      const effort = reply.locator("button.agent-settings-effort");
      await expect(effort).toHaveAttribute("data-value", "");
      await expect(reply.locator("textarea")).toHaveValue("能力刷新后保留这段草稿");
      await reply.locator("button[type=submit]").click();
      await expect.poll(() => prepared).toBeDefined();
      expect(prepared).toMatchObject({ model: "mutable", mode: agent.mode, text: "能力刷新后保留这段草稿" });
      expect(prepared).not.toHaveProperty("effort");
      const reservation = prepared;
      prepared = undefined;
      models[0]!.id = "retired-replacement";
      await page.clock.fastForward(31_000);
      // An uncertain reservation remains retryable with its original key and
      // immutable parameters even if the catalog changes before the retry.
      await expect(reply.locator("button[type=submit]")).toBeEnabled();
      await reply.locator("button[type=submit]").click();
      await expect.poll(() => prepared).toBeDefined();
      expect(prepared).toEqual(reservation);
    });
  });
}
