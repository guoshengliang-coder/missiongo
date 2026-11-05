import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { chooseOption } from "./select-helpers";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} effort settings`, () => {
    test.use({ viewport: { width, height: 950 }, hasTouch: width === 320, colorScheme: theme });
    test("defaults reconcile against the selected device and preserve unrelated preferences", async ({ page }, testInfo) => {
      const model = { id: "same-model", label: "Shared catalog model", efforts: ["low"] };
      const narrow = { id: "narrow", name: "Narrow device", online: true, repos: [], repoCandidates: [], createdAt: "",
        agents: [{ kind: "codex", planApprovalProtocol: 1, ready: true, models: [model] }] };
      const wide = { ...narrow, id: "wide", name: "Wide device", agents: [{ ...narrow.agents[0]!, models: [{ ...model, efforts: ["low", "high"] }] }] };
      const unrelated = { mode: "bypassPermissions", model: "unavailable-preference", effort: "high" };
      let defaults = { nodeId: narrow.id, agentKind: "codex", agents: { codex: { mode: "auto", model: model.id, effort: "high" }, claude_code: unrelated } };
      await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [narrow, wide] } }));
      await page.route("**/api/v1/dispatch-defaults", async route => {
        if (route.request().method() === "PUT") defaults = route.request().postDataJSON();
        await route.fulfill({ json: defaults });
      });
      await page.goto("/settings/agent/dispatch");
      const section = page.locator(".dispatch-defaults");
      await section.getByText("模型与推理设置", { exact: true }).click();
      const effort = section.getByRole("combobox", { name: "强度", exact: true });
      await expect(effort).toHaveAttribute("data-value", "");
      await expect(section).toContainText("已恢复为跟随本机配置");
      await section.getByRole("button", { name: "保存", exact: true }).click();
      await expect.poll(() => defaults.agents.codex).toEqual({ mode: "auto", model: model.id });
      expect(defaults.agents.claude_code).toEqual(unrelated);
      await chooseOption(section.getByRole("combobox", { name: "设备", exact: true }), wide.id);
      await chooseOption(effort, "high");
      await chooseOption(section.getByRole("combobox", { name: "设备", exact: true }), narrow.id);
      await expect(effort).toHaveAttribute("data-value", "");
      for (const scale of ["small", "medium", "large"]) {
        await page.locator("html").evaluate((el, value) => el.setAttribute("data-font-scale", value), scale);
        expect(await section.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: testInfo.outputPath("default-effort-correction.png") });
    });

    test("a refused live model change names the catalog model and preserves confirmed settings", async ({ page }) => {
      const { productId } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
      const stamp = new Date().toISOString();
      const sessionId = "effort-live-session";
      const settings = { adjustable: true, mode: "auto", model: "flexible", requestedModel: "flexible", effort: "high" };
      const summary = { id: sessionId, agentSessionId: sessionId, dispatchId: "effort-live-dispatch", agentKind: "codex", status: "active",
        nodeId: "live-node", nodeName: "Fixture Mac", nodeConnectionState: "online", nodeRevoked: false,
        createdAt: stamp, updatedAt: stamp, activityAt: stamp, items: [{ key: "AND-412", title: "Live effort", productId }],
        settings, activities: [], unread: false, canReply: true, canStop: false, canArchive: true,
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
      await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: "live-node", online: true,
        agents: [{ kind: "codex", planApprovalProtocol: 1, models: [
          { id: "flexible", label: "Flexible model", efforts: ["low", "high"] },
          { id: "limited", label: "DeepSeek gateway model", efforts: [] },
        ] }] }] } }));
      const changes: unknown[] = [];
      await page.route("**/api/v1/agent-sessions**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "PATCH" && path.endsWith("/settings")) {
          changes.push(route.request().postDataJSON());
          return route.fulfill({ status: 400, json: { code: "agent_effort_unavailable", title: "Effort high is not offered by internal-sonnet-id." } });
        }
        await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary] } : { ...summary, messages: [], canResolveDelivery: false } });
      });
      await page.goto(`/?product=${productId}&console=agent&session=${sessionId}`);
      const settingsBar = page.locator(".agent-session-quick-settings");
      await chooseOption(settingsBar.getByRole("combobox", { name: "模型", exact: true }), "limited");
      const error = settingsBar.locator(".error");
      await expect(error).toContainText("DeepSeek gateway model");
      await expect(error).toContainText("本次变更未保存");
      await expect(error).not.toContainText("internal-sonnet-id");
      await expect(settingsBar.getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("data-value", "flexible");
      expect(changes).toEqual([{ model: "limited" }]);
    });
  });
}
