import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { chooseOption } from "./select-helpers";
import type { AgentSessionSettings, AgentSessionSummary } from "../../apps/web/src/types";

for (const width of [320, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  for (const kind of ["codex", "opencode", "claude_code"] as const) {
    test(`external settings ${kind} ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ colorScheme: theme });
      const { productId } = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
      const stamp = new Date().toISOString();
      const settings: AgentSessionSettings = {
        mode: kind === "claude_code" ? "external" : "default", model: "source-model", effort: "low",
        adjustable: kind !== "claude_code", supportedFields: kind === "claude_code" ? [] : kind === "codex" ? ["model", "effort"] : ["mode", "model", "effort"],
        ...(kind === "claude_code" ? { unavailableReason: "source" } : {}),
        applyOn: kind === "codex" ? "next_reply" : "idle",
      };
      const summary = (): AgentSessionSummary => ({
        id: "external-settings", agentSessionId: "external-settings", source: "external", agentKind: kind,
        status: "idle", progressStatus: "working", refKind: "native", updatedAt: stamp, createdAt: stamp, activityAt: stamp,
        nodeName: "Source", nodeRevoked: false, mode: "external", dispatchStatus: "external",
        nativeConnection: { state: "connected", nodeId: "source-node", nodeName: "Source", lastSyncedAt: stamp },
        items: [{ key: "AND-373", title: "外部会话设置", productId }], activities: [], settings,
        canReply: true, canRetry: false, canStop: false, canArchive: true,
        attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, unread: false,
      });
      const changes: object[] = [];
      await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [{ id: "source-node", name: "Source", online: true,
        agents: [{ kind, models: [{ id: "source-model", label: "来源模型", efforts: ["low", "high"] },
          { id: "other-model", label: "另一个来源模型", efforts: ["low", "high"] }] }] }] } }));
      await page.route("**/api/v1/agent-sessions**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "PATCH" && path.endsWith("/settings")) {
          const change = route.request().postDataJSON(); changes.push(change);
          Object.assign(settings, { error: undefined, pending: { ...settings.pending, ...change, revision: changes.length } });
          await route.fulfill({ json: settings });
        } else await route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [summary()] }
          : { ...summary(), messages: [], canAttach: false } });
      });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      const open = () => page.goto(`/?product=${productId}&console=agent&session=external-settings`);
      await open();
      const root = page.locator(".agent-session-quick-settings");
      const model = root.getByRole("combobox", { name: "模型", exact: true });
      await expect(model).toContainText("来源模型");
      if (kind === "claude_code") {
        await expect(model).toBeDisabled();
        await expect(root.getByText(/请在原客户端修改/)).toBeVisible();
        expect(changes).toEqual([]);
      } else {
        await expect(model).toBeEnabled();
        await chooseOption(model, "other-model");
        await expect.poll(() => changes).toEqual([{ model: "other-model" }]);
        await expect(root.getByRole("status")).toContainText(kind === "codex" ? "下次从控制台回复" : "等待 Mac 应用");
        // A rejection keeps the confirmed model, and the same choice remains retryable.
        Object.assign(settings, { pending: undefined, error: "来源拒绝该设置" });
        await page.reload();
        await expect(model).toContainText("来源模型");
        await expect(root.getByText(/来源拒绝/)).toBeVisible();
        await chooseOption(model, "other-model");
        await expect.poll(() => changes.length).toBe(2);
        if (kind === "opencode" && width === 1440) {
          await chooseOption(root.getByRole("combobox", { name: "权限模式", exact: true }), "plan");
          await expect.poll(() => changes.at(-1)).toEqual({ mode: "plan" });
          await chooseOption(root.getByRole("combobox", { name: "强度", exact: true }), "high");
          await expect.poll(() => changes.at(-1)).toEqual({ effort: "high" });
        }
      }
      await page.locator("html").evaluate(node => node.setAttribute("data-font-scale", "large"));
      const box = (await model.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (kind === "codex" && width !== 768) await page.screenshot({ path: test.info().outputPath(`external-settings-${width}-${theme}.png`) });
      expect(errors).toEqual([]);
      // Old nodes and disconnected sources keep the controls visible and explain why.
      Object.assign(settings, { pending: undefined, error: undefined, adjustable: false, supportedFields: [], unavailableReason: "upgrade" });
      await page.reload();
      await expect(model).toBeDisabled();
      await expect(root.getByText(/请更新节点/)).toBeVisible();
    });
  }
}
