import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";
import { WEB_ORIGIN } from "./fixture.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const productPath = (id: string) => `/settings/products/${id}/product`;
const nav = (page: Page) => page.getByRole("navigation", { name: "设置", exact: true });
const hub = (page: Page, label: string) => page.locator(".settings-hub-row").filter({ has: page.getByText(label, { exact: true }) });
async function openProduct(page: Page) {
  await nav(page).getByRole("button", { name: "产品配置", exact: true }).click();
  await hub(page, "基本资料").click();
}

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} settings`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("keeps a stable frame, readable scope and restorable product URL", async ({ page }) => {
      await page.goto(`/?product=${fixture.productId}`);
      if (width === 375) await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      if (width === 375) await expect(page).toHaveURL(/\/settings\?/);
      else await expect(page.getByRole("heading", { name: "资料与安全", exact: true })).toBeVisible();
      const top = (await nav(page).boundingBox())!.y;
      await openProduct(page);
      await expect(page.getByRole("heading", { name: "基本资料", level: 1, exact: true })).toBeVisible();
      await expect(page.locator(".settings-page-title")).toContainText("作用于产品：");
      await expect(page).toHaveURL(new RegExp(`/settings/products/${fixture.productId}/product`));
      if (width === 1440) expect((await nav(page).boundingBox())!.y).toBe(top);
      await page.waitForLoadState("networkidle");
      const audit = await page.evaluate(AUDIT_SOURCE) as { horizontalOverflow: number; text: Array<{ fontSize: number; fontWeight: number; contrast: number }>; targets: Array<{ width: number; height: number; where: string }> };
      expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(audit.text.filter(x => x.fontSize > 0 && x.fontSize < 11)).toEqual([]);
      expect(audit.text.filter(x => x.contrast < (x.fontSize >= 24 || (x.fontWeight >= 700 && x.fontSize >= 18.66) ? 3 : 4.5))).toEqual([]);
      if (width === 375) expect(audit.targets.filter(x => x.width > 0 && x.height > 0 && (x.width < 43.99 || x.height < 43.99))).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("settings-product.png") });
      await page.reload();
      await expect(page.getByRole("heading", { name: "基本资料", level: 1, exact: true })).toBeVisible();
      if (width === 375) {
        await page.getByRole("button", { name: "设置目录", exact: true }).click();
        await expect(nav(page)).toBeVisible();
      }
      await nav(page).getByRole("button", { name: "显示", exact: true }).click();
      await expect(page.getByText("修改后自动保存。保存失败时会恢复之前的设置。", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "返回工作区", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`^https?://[^/]+/\\?product=${fixture.productId}$`));
      await expect(page.locator(".app-shell")).toBeVisible();
    });
  });
}

test("protects unsaved input across categories, product changes and browser Back, then allows a successful save", async ({ page, request }) => {
  const created = await request.post("/api/v1/products", { data: { name: "Settings draft", keyPrefix: "SDR" } });
  const product = await created.json();
  await page.goto(`/settings/profile?product=${fixture.productId}`);
  await openProduct(page);
  await page.getByRole("combobox", { name: "当前产品", exact: true }).selectOption(product.id);
  const input = page.getByRole("textbox", { name: "产品名称", exact: true });
  await input.fill("Unsaved settings name");
  page.once("dialog", dialog => dialog.dismiss());
  await nav(page).getByRole("button", { name: "显示", exact: true }).click();
  await expect(input).toHaveValue("Unsaved settings name");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("combobox", { name: "当前产品", exact: true }).selectOption(fixture.productId);
  await expect(page).toHaveURL(new RegExp(productPath(product.id)));
  await expect(page.getByRole("combobox", { name: "当前产品", exact: true })).toHaveValue(product.id);
  page.once("dialog", dialog => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(productPath(product.id)));
  await expect(input).toHaveValue("Unsaved settings name");

  await page.route(`**/api/v1/products/${product.id}`, route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify({ code: "test_save_failed", title: "保存失败，请重试" }) }) : route.continue());
  await page.getByRole("button", { name: "保存产品", exact: true }).click();
  await expect(page.getByText("保存失败，请重试", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Unsaved settings name");
  await page.unroute(`**/api/v1/products/${product.id}`);
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/products/${product.id}`));
  await page.getByRole("button", { name: "保存产品", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("button", { name: "保存产品", exact: true })).toBeDisabled();
  await nav(page).getByRole("button", { name: "显示", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/display/);
  await openProduct(page);
  await expect(page).toHaveURL(new RegExp(productPath(product.id)));
  await expect(input).toHaveValue("Unsaved settings name");
});

test("requires deliberate token creation and does not show dispatch fields before a device is available", async ({ page }) => {
  await page.goto("/settings/connections");
  await expect(page.getByRole("textbox", { name: "名称", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "新建个人令牌", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("Unsubmitted token");
  page.once("dialog", dialog => dialog.dismiss());
  await nav(page).getByRole("button", { name: "资料与安全", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("Unsubmitted token");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await nav(page).getByRole("button", { name: "Agent 配置", exact: true }).click();
  await hub(page, "派单默认值").click();
  await expect(page.getByRole("heading", { name: "先接入执行设备", exact: true })).toBeVisible();
  await expect(page.locator(".dispatch-defaults-agent")).toHaveCount(0);
  await page.getByRole("button", { name: "执行设备", exact: true }).last().click();
  await expect(page).toHaveURL(/\/settings\/agent\/devices/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "先接入执行设备", exact: true })).toBeVisible();
});

test("shows one Agent at a time, keeps advanced choices optional and protects dispatch drafts", async ({ page }) => {
  await page.route("**/api/v1/nodes", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ nodes: [{ id: "review-node", name: "Review Mac", deviceName: "Review Mac", agents: [{ kind: "claude_code", version: "1" }, { kind: "codex", version: "1" }], repos: [], repoCandidates: [], online: true, createdAt: new Date().toISOString() }] }) }));
  await page.goto("/settings/dispatch");
  await expect(page.locator(".dispatch-defaults-agent")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await expect(page.locator(".dispatch-defaults-agent legend")).toHaveText("Codex");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeHidden();
  await page.getByText("模型与推理设置", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.dismiss());
  await nav(page).getByRole("button", { name: "Agent 配置", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/dispatch/);
});

test("members cannot access administrator settings and view-only products cannot be edited", async ({ page, request }) => {
  const password = randomBytes(18).toString("base64url");
  const created = await request.post("/api/v1/accounts", { data: { email: "settings-member@example.test", password, role: "member" } });
  const member = await created.json();
  await request.put(`/api/v1/accounts/${member.id}/products`, { data: { permissions: [{ productId: fixture.productId, canView: true, canOperate: false, canUseAi: true }] } });
  const login = await request.post("/api/v1/auth/login", { data: { username: "settings-member@example.test", password } });
  expect(login.status()).toBe(200);
  const cookie = login.headers()["set-cookie"]!.split(";")[0]!;
  await page.context().addCookies([{ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: WEB_ORIGIN }]);
  await page.goto("/settings/admin/ai");
  await expect(page.getByRole("alert")).toHaveText("此设置不可用，或你没有访问权限。");
  await expect(nav(page).getByRole("button", { name: "账号与权限", exact: true })).toHaveCount(0);
  await page.goto(productPath(fixture.productId));
  await expect(page.getByRole("textbox", { name: "产品名称", exact: true })).toBeDisabled();
  await expect(page.getByText("你可以查看此产品的设置。如需修改，请联系产品所有者授予操作权限。", { exact: true })).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "成员与权限", exact: true })).toHaveCount(0);
  const refused = await request.patch(`/api/v1/products/${fixture.productId}`, { data: { name: "Should not change" } });
  expect(refused.status()).toBe(404);
});

test("creates a product in its own scope and opens the newly saved product without a draft warning", async ({ page }) => {
  await page.goto("/settings/products/new");
  await expect(page.locator(".settings-page-title")).toContainText("创建独立产品，不修改当前产品");
  await page.getByRole("textbox", { name: "产品名称", exact: true }).fill("Settings new product");
  await page.getByRole("textbox", { name: "条目前缀", exact: false }).fill("SNEW");
  await page.getByRole("button", { name: "创建工作区", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/products\/[a-f0-9-]+(?:\?|$)/);
  await hub(page, "基本资料").click();
  await expect(page.getByRole("textbox", { name: "产品名称", exact: true })).toHaveValue("Settings new product");
});

test("keeps multiple devices compact and protects a device nickname draft", async ({ page }) => {
  await page.route("**/api/v1/nodes", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ nodes: ["A", "B"].map(id => ({ id, name: `Review Mac ${id}`, deviceName: `Review Mac ${id}`, agents: [{ kind: "codex", version: "1" }], repos: [], repoCandidates: [], online: true, createdAt: new Date().toISOString() })) }) }));
  await page.goto("/settings/devices");
  await expect(page.locator(".settings-device-row")).toHaveCount(2);
  await expect(page.locator(".node-card")).toHaveCount(0);
  await page.locator(".settings-device-row").first().click();
  const card = page.locator(".node-card").first();
  const nickname = card.getByRole("textbox").first();
  await nickname.fill("Unsubmitted device name");
  page.once("dialog", dialog => dialog.dismiss());
  await nav(page).getByRole("button", { name: "资料与安全", exact: true }).click();
  await expect(nickname).toHaveValue("Unsubmitted device name");
});

test.describe("short mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 480 }, hasTouch: true, isMobile: true });
  test("keeps the save action within the visible content viewport", async ({ page }) => {
    await page.goto(productPath(fixture.productId));
    const input = page.getByRole("textbox", { name: "产品名称", exact: true });
    await input.fill("Short viewport draft");
    const save = page.getByRole("button", { name: "保存产品", exact: true });
    await expect(save).toBeInViewport();
    await expect.poll(async () => {
      const inputBox = (await input.boundingBox())!;
      const footerBox = (await page.locator(".settings-form-footer").boundingBox())!;
      return inputBox.y + inputBox.height <= footerBox.y;
    }).toBe(true);
    const box = (await save.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(480);
    await page.screenshot({ path: test.info().outputPath("settings-short-height.png") });
  });
});
