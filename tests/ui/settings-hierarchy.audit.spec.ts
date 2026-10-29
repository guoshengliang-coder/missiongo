import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import { AUDIT_SOURCE } from "./audit-page.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} settings hierarchy`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("groups primary navigation, drills into Agent and product modules and keeps their scopes clear", async ({ page }) => {
      await page.goto(`/settings?product=${fixture.productId}`);
      const nav = page.getByRole("navigation", { name: "设置", exact: true });
      await expect(nav.getByRole("button")).toHaveText(["资料与安全", "显示", "Agent 配置", "产品配置", "账号与权限", "产品管理员", "模型"]);
      await nav.getByRole("button", { name: "Agent 配置", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agent 配置");
      await expect(page.locator(".settings-hub-row strong")).toHaveText(["连接与授权", "执行设备", "派单默认值"]);
      await page.screenshot({ path: test.info().outputPath("agent-overview.png") });
      await page.locator(".settings-hub-row").filter({ hasText: "派单默认值" }).click();
      await expect(page).toHaveURL(/\/settings\/agent\/dispatch/);
      await expect(page.locator(".settings-page-title")).toContainText("仅影响当前账号");
      await page.getByRole("navigation", { name: "设置位置" }).getByRole("button", { name: "Agent 配置", exact: true }).click();
      if (width === 375) await page.getByRole("button", { name: "设置目录", exact: true }).click();
      await nav.getByRole("button", { name: "产品配置", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "当前产品", exact: true })).toHaveCount(0);
      await page.locator(`.settings-product-card[data-product-id="${fixture.productId}"]`).click();
      await expect(page.locator(".settings-hub-row strong")).toHaveText(["基本资料", "模块管理", "产品管理员", "Builder 分配", "发布配置", "SDK 接入"]);
      await expect(page.locator(".settings-page-title")).toContainText("作用于产品：");
      await expect(page.getByRole("button", { name: "添加产品", exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("product-overview.png") });
      await page.waitForLoadState("networkidle");
      const audit = await page.evaluate(AUDIT_SOURCE) as { horizontalOverflow: number; text: Array<{ fontSize: number; fontWeight: number; contrast: number }>; targets: Array<{ width: number; height: number }> };
      expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(audit.text.filter(x => x.fontSize > 0 && x.fontSize < 11)).toEqual([]);
      expect(audit.text.filter(x => x.contrast < (x.fontSize >= 24 || (x.fontWeight >= 700 && x.fontSize >= 18.66) ? 3 : 4.5))).toEqual([]);
      if (width === 375) expect(audit.targets.filter(x => x.width > 0 && x.height > 0 && (x.width < 43.99 || x.height < 43.99))).toEqual([]);
      await page.locator(".settings-hub-row").filter({ hasText: "SDK 接入" }).click();
      await expect(page.getByText("SDK 令牌归属当前产品。需要区分模块或独立撤销时，可以创建多枚令牌。", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("SDK 接入");
    });
  });
}

test("unifies account permissions, filters products, opens account details and guards permission drafts", async ({ page, request }) => {
  const created = await request.post("/api/v1/accounts", { data: { email: "hierarchy-member@example.test", password: randomBytes(18).toString("base64url"), role: "member" } });
  const account = await created.json();
  const other = await (await request.post("/api/v1/products", { data: { name: "Separate access", keyPrefix: "SAC" } })).json();
  await request.put(`/api/v1/accounts/${account.id}/products`, { data: { permissions: [{ productId: other.id, canView: true, canOperate: false, canUseAi: false }] } });
  await page.goto(`/settings/admin/accounts?settingsProduct=${fixture.productId}&product=${fixture.productId}`);
  await expect(page.locator(".account-row").filter({ hasText: account.email })).toHaveCount(0);
  await page.getByRole("combobox", { name: "按产品筛选", exact: true }).selectOption(other.id);
  await page.getByRole("searchbox", { name: "搜索账号", exact: true }).fill(account.email);
  const row = page.locator(".account-row").filter({ hasText: account.email });
  await row.getByRole("button", { name: "修改权限", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/admin/accounts/${account.id}`));
  await expect(page.locator(".account-row")).toHaveCount(1);
  const permission = page.getByRole("checkbox", { name: "Separate access · 操作", exact: true });
  await permission.check();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("navigation", { name: "设置位置" }).getByRole("button", { name: "账号与权限", exact: true }).click();
  await expect(permission).toBeChecked();
  await page.locator(".account-permissions-footer").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存。", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "设置位置" }).getByRole("button", { name: "账号与权限", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "按产品筛选", exact: true })).toHaveValue(other.id);
  const stored = await (await request.get("/api/v1/accounts")).json();
  expect(stored.accounts.find((value: { id: string }) => value.id === account.id).permissions.find((value: { productId: string }) => value.productId === other.id).canOperate).toBe(true);
});

test("keeps a product owner's scoped permissions in the common account entry without exposing account administration", async ({ page, request }) => {
  const password = randomBytes(18).toString("base64url");
  const member = await (await request.post("/api/v1/accounts", { data: { email: "hierarchy-owner@example.test", password, role: "member" } })).json();
  await request.post("/api/v1/auth/login", { data: { username: member.email, password } });
  const owned = await (await request.post("/api/v1/products", { data: { name: "Owned product", keyPrefix: "OWN" } })).json();
  expect(owned.createdByAccountId).toBe(member.id);
  // Use the actual temporary account's cookie; no production credentials are involved.
  const state = await request.storageState();
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies.map(value => ({ name: value.name, value: value.value, url: WEB_ORIGIN })));
  await page.goto(`/settings/permissions/${owned.id}`);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建账号", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "添加", exact: true })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "设置", exact: true }).getByRole("button", { name: "模型", exact: true })).toHaveCount(0);
  await page.goto(`/settings/permissions/${fixture.productId}`);
  await expect(page.getByRole("alert")).toHaveText("此设置不可用，或你没有访问权限。");
});

test("module details are restorable and refuse to silently discard a module edit", async ({ page, request }) => {
  const component = await (await request.post(`/api/v1/products/${fixture.productId}/components`, { data: { name: "Hierarchy module", kind: "android" } })).json();
  await page.goto(`/settings/products/${fixture.productId}/components`);
  await expect(page.getByRole("textbox", { name: "模块名称", exact: true })).toHaveCount(0);
  await page.locator(".settings-hub-row").filter({ hasText: "Hierarchy module" }).click();
  await expect(page).toHaveURL(new RegExp(`/components/${component.id}`));
  await page.reload();
  const input = page.getByRole("textbox", { name: "模块名称", exact: true });
  await input.fill("Unsaved module");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("navigation", { name: "设置位置" }).getByRole("button", { name: "模块管理", exact: true }).click();
  await expect(input).toHaveValue("Unsaved module");
});

test("models retain existing service configuration and explain their independent scope", async ({ page }) => {
  await page.goto("/settings/admin/models");
  await expect(page.getByRole("heading", { name: "模型配置", level: 1, exact: true })).toBeVisible();
  await expect(page.getByText("配置 MissionGo 自身 AI 功能使用的模型服务。派单时的可选模型由执行设备上的 Agent 提供。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "DeepSeek", exact: false })).toBeVisible();
});

test("dispatch defaults remain account-wide after a product switch", async ({ page, request }) => {
  const before = await (await request.get("/api/v1/dispatch-defaults")).json();
  const product = await (await request.post("/api/v1/products", { data: { name: "Dispatch context", keyPrefix: "DCT" } })).json();
  await page.route("**/api/v1/nodes", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ nodes: [{ id: "defaults-node", name: "Default Mac", deviceName: "Default Mac", online: true, agents: [{ kind: "claude_code", version: "1" }, { kind: "codex", version: "1" }], repos: [], repoCandidates: [], createdAt: new Date().toISOString() }] }) }));
  try {
    await page.goto(`/settings/agent/dispatch?product=${fixture.productId}`);
    await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
    const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/dispatch-defaults") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await page.getByRole("navigation", { name: "设置", exact: true }).getByRole("button", { name: "产品配置", exact: true }).click();
    await page.locator(`.settings-product-card[data-product-id="${fixture.productId}"]`).click();
    await page.getByRole("combobox", { name: "当前产品", exact: true }).selectOption(product.id);
    await page.getByRole("navigation", { name: "设置", exact: true }).getByRole("button", { name: "Agent 配置", exact: true }).click();
    await page.locator(".settings-hub-row").filter({ hasText: "派单默认值" }).click();
    await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("codex");
    await expect(page.locator(".settings-page-title")).toContainText("仅影响当前账号");
    const current = await (await request.get("/api/v1/dispatch-defaults")).json();
    expect(current.agentKind).toBe("codex");
    expect(current.productId).toBeUndefined();
  } finally { await request.put("/api/v1/dispatch-defaults", { data: before }); }
});

test("SDK token lists stay separate for each product", async ({ page, request }) => {
  const other = await (await request.post("/api/v1/products", { data: { name: "SDK other product", keyPrefix: "SOP" } })).json();
  const a = await (await request.post("/api/v1/sdk-tokens", { data: { name: "SDK product A", productId: fixture.productId } })).json();
  const b = await (await request.post("/api/v1/sdk-tokens", { data: { name: "SDK product B", productId: other.id } })).json();
  expect(a.token).not.toBe(b.token);
  await page.goto(`/settings/products/${fixture.productId}/tokens`);
  await expect(page.locator(".sdk-token-row").filter({ hasText: "SDK product A" })).toHaveCount(1);
  await expect(page.locator(".sdk-token-row").filter({ hasText: "SDK product B" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "当前产品", exact: true }).selectOption(other.id);
  await expect(page.locator(".sdk-token-row").filter({ hasText: "SDK product A" })).toHaveCount(0);
  await expect(page.locator(".sdk-token-row").filter({ hasText: "SDK product B" })).toHaveCount(1);
});

test("an account with no products can create its first product inside product configuration", async ({ page, request }) => {
  const password = randomBytes(18).toString("base64url");
  await request.post("/api/v1/accounts", { data: { email: "hierarchy-empty@example.test", password, role: "member" } });
  await request.post("/api/v1/auth/login", { data: { username: "hierarchy-empty@example.test", password } });
  const state = await request.storageState();
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies.map(value => ({ name: value.name, value: value.value, url: WEB_ORIGIN })));
  await page.goto("/settings/products");
  await expect(page.getByRole("heading", { name: "创建第一个产品", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "设置", exact: true }).getByRole("button", { name: "添加产品", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "添加产品", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/products\/new/);
  await expect(page.getByRole("textbox", { name: "产品名称", exact: true })).toBeVisible();
});

test("declining to leave an account editor preserves the email draft even when Cancel was clicked", async ({ page, request }) => {
  const account = await (await request.post("/api/v1/accounts", { data: { email: "hierarchy-cancel@example.test", password: randomBytes(18).toString("base64url"), role: "member" } })).json();
  await page.goto(`/settings/admin/accounts/${account.id}`);
  const email = page.getByRole("textbox", { name: "邮箱", exact: true });
  await email.fill("unfinished-address@example.test");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(email).toHaveValue("unfinished-address@example.test");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/admin\/accounts(?:\?|$)/);
  await page.locator(".account-row").filter({ hasText: account.email }).getByRole("button", { name: "修改", exact: true }).click();
  await expect(email).toHaveValue(account.email);
});
