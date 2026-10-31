import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { chooseOption } from "./select-helpers";
import type { DispatchDefaults } from "../../apps/web/src/types";

for (const width of [375, 1440]) {
  test(`creation keeps an optional Builder in the draft and submits it at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const product = await (await request.post("/api/v1/products", { data: { name: `Capture Builder ${width}`, keyPrefix: `CB${width}` } })).json();
    const builder = await (await request.post("/api/v1/accounts", { data: { email: `capture-builder-${width}@example.test`, password: randomBytes(18).toString("base64url"), role: "member" } })).json();
    await request.put(`/api/v1/accounts/${builder.id}/products`, { data: { permissions: [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }] } });
    await page.goto(`/?product=${product.id}`);
    const capture = page.locator(width === 375 ? ".mobile-fab" : ".capture-button");
    await capture.click();
    const form = page.locator(".quick-capture-form");
    const control = form.getByRole("combobox", { name: "Builder（可选）", exact: true });
    await expect(control).toHaveAttribute("data-value", "");
    await chooseOption(control, builder.id);
    await form.locator(".ai-title-field input").fill("创建时指定 Builder");
    await form.locator(".report-input-block textarea").first().fill("无需进入详情再指定责任人。");
    await page.reload();
    await capture.click();
    await expect(control).toHaveAttribute("data-value", builder.id);
    await expect(form.locator(".ai-title-field input")).toHaveValue("创建时指定 Builder");
    await control.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`capture-builder-${width}.png`) });
    expect(await control.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/v1/items") && response.request().method() === "POST");
    await form.getByRole("button", { name: "保存到草稿", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const item = await response.json();
    expect(item.builderAccountId).toBe(builder.id);
    expect(item.status).toBe("inbox");
    await expect(form).toHaveCount(0);
  });

  test(`dispatch explicitly saves current defaults, preserves other agents and reports errors at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const product = await (await request.post("/api/v1/products", { data: { name: `Dispatch defaults ${width}`, keyPrefix: `DD${width}` } })).json();
    const item = await (await request.post("/api/v1/items", { data: { productId: product.id, status: "ready", type: "task", priority: "normal", title: "派单默认配置", description: "Save a choice", environment: { platform: "web" } } })).json();
    let defaults: DispatchDefaults = { agentKind: "codex", agents: { codex: { mode: "plan" }, claude_code: { mode: "default" } } };
    let failSave = true;
    let dispatchCount = 0;
    const node = { id: "fixture-node", name: "Fixture Mac", deviceName: "Fixture Mac", online: true,
      agents: [{ kind: "codex", ready: true, models: [{ id: "fixture-model", label: "Fixture model", efforts: ["high"] }] }, { kind: "claude_code", ready: true, models: [] }],
      repos: [{ productId: product.id, repoPath: "fixture-repository" }], repoCandidates: [], createdAt: new Date().toISOString() };
    await page.route("**/api/v1/nodes", route => route.fulfill({ json: { nodes: [node] } }));
    await page.route("**/api/v1/dispatches/active", route => route.fulfill({ json: { active: [], latest: [], current: [], handlers: [] } }));
    await page.route("**/api/v1/dispatch-defaults", async route => {
      if (route.request().method() === "PUT") {
        if (failSave) return route.fulfill({ status: 500, json: { title: "Synthetic save failure" } });
        defaults = route.request().postDataJSON();
      }
      await route.fulfill({ json: defaults });
    });
    await page.route("**/api/v1/dispatches", async route => {
      dispatchCount++;
      const input = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { ...input, id: "fixture-dispatch", status: "queued", nodeName: node.name, createdAt: new Date().toISOString() } });
    });
    const openDispatch = async () => {
      await page.locator(".item-row").filter({ hasText: item.key }).getByRole("checkbox").check();
      await page.getByRole("button", { name: "派单", exact: true }).click();
    };
    await page.goto(`/?product=${product.id}&status=ready`);
    await openDispatch();
    const form = page.locator(".dispatch-form");
    await expect(form.getByRole("combobox", { name: "Agent", exact: true })).toHaveAttribute("data-value", "codex");
    await chooseOption(form.getByRole("combobox", { name: "模型", exact: true }), "fixture-model");
    await chooseOption(form.getByRole("combobox", { name: "强度", exact: true }), "high");
    const save = form.getByRole("button", { name: "设为默认值", exact: true });
    await save.click();
    await expect(form.getByRole("alert")).toContainText("服务端暂时无法完成，请稍后再试。");
    await expect(form.getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("data-value", "fixture-model");
    failSave = false;
    await save.click();
    await expect(form.getByRole("status")).toHaveText("已保存");
    expect(dispatchCount).toBe(0);
    expect(defaults).toEqual({ nodeId: node.id, agentKind: "codex", agents: { codex: { mode: "plan", model: "fixture-model", effort: "high" }, claude_code: { mode: "default" } } });
    await page.screenshot({ path: testInfo.outputPath(`dispatch-defaults-${width}.png`) });
    expect(await form.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // Reloading closes the dialog without invoking its unsaved-choice guard.
    await page.reload();
    await openDispatch();
    await expect(form.getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("data-value", "fixture-model");
    await expect(form.getByRole("combobox", { name: "强度", exact: true })).toHaveAttribute("data-value", "high");
    await form.getByRole("button", { name: "派单", exact: true }).click();
    await expect(page.locator(".dispatch-result")).toBeVisible();
    expect(dispatchCount).toBe(1);
  });
}
