import { expect, test } from "@playwright/test";
import { chooseOption } from "./select-helpers";

for (const scenario of ["late", "retry"] as const) {
  test(`dispatch defaults ${scenario} preserves the right source of the mode`, async ({ page, request }) => {
    const product = await (await request.post("/api/v1/products", { data: { name: `Defaults ${scenario}`, keyPrefix: `D490${scenario.toUpperCase()}` } })).json();
    const item = await (await request.post("/api/v1/items", { data: { productId: product.id, status: "ready", type: "task", priority: "normal", title: "默认值加载时序", description: "Isolated fixture", environment: { platform: "web" } } })).json();
    const node = { id: "defaults-loading", name: "Fixture", online: true, repos: [{ productId: product.id, repoPath: "fixture-repo" }], repoCandidates: [],
      agents: [{ kind: "codex", planApprovalProtocol: 1, ready: true, models: [] }, { kind: "claude_code", planApprovalProtocol: 1, ready: true, models: [] }] };
    await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node] } }));
    let fail = scenario === "retry";
    let release = () => {};
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/dispatch-defaults", async route => {
      if (fail) return route.fulfill({ status: 503, json: { title: "Synthetic unavailable defaults" } });
      if (scenario === "late") await delayed;
      return route.fulfill({ json: { nodeId: node.id, agentKind: scenario === "late" ? "claude_code" : "codex",
        agents: { codex: { mode: "read-only" }, claude_code: { mode: "default" } } } });
    });
    await page.goto(`/?product=${product.id}&status=ready`);
    await page.locator(".item-row").filter({ hasText: item.key }).getByRole("checkbox").check();
    await page.getByRole("button", { name: "派单", exact: true }).click();
    const form = page.locator(".dispatch-form");
    if (scenario === "late") {
      await chooseOption(form.getByRole("combobox", { name: "Agent", exact: true }), "codex");
      await chooseOption(form.getByRole("combobox", { name: "权限模式", exact: true }), "read-only");
      const response = page.waitForResponse("**/api/v1/dispatch-defaults");
      release();
      await response;
    } else {
      const error = form.getByRole("alert").filter({ hasText: "默认值读取失败" });
      await expect(error).toBeVisible();
      fail = false;
      await error.getByRole("button", { name: "重试", exact: true }).click();
      await expect(error).toHaveCount(0);
    }
    await expect(form.getByRole("combobox", { name: "Agent", exact: true })).toHaveAttribute("data-value", "codex");
    await expect(form.getByRole("combobox", { name: "权限模式", exact: true })).toHaveAttribute("data-value", "read-only");
  });
}
