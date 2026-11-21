import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [353, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} password reset`, () => {
    test.use({ viewport: { width, height: 757 }, isMobile: width === 353, hasTouch: width === 353, colorScheme: theme });
    test("resets only the selected account and guards drafts, failures and in-flight requests", async ({ page, request, browser }) => {
      const password = randomBytes(18).toString("base64url");
      const next = randomBytes(18).toString("base64url");
      const email = `reset-${randomBytes(6).toString("hex")}@example.test`;
      const created = await request.post("/api/v1/accounts", { data: { email, password, role: "member" } });
      expect(created.status()).toBe(201);
      const account = await created.json();
      await request.put(`/api/v1/accounts/${account.id}/products`, { data: { permissions: [{ productId: fixture.productId, canView: true, canOperate: false, canUseAi: false }] } });
      const target = await browser.newContext({ baseURL: WEB_ORIGIN });
      try {
        expect((await target.request.post("/api/v1/auth/login", { data: { username: email, password } })).status()).toBe(200);
        await page.goto(`/settings/admin/accounts?settingsProduct=${fixture.productId}`);
        await page.getByRole("searchbox", { name: "搜索账号", exact: true }).fill(email);
        const row = page.locator(".account-row").filter({ hasText: email });
        const more = row.locator(".account-more > summary");
        const open = async () => {
          await more.click();
          await row.getByRole("button", { name: "重置密码", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "重置密码", exact: true })).toBeVisible();
        };
        await open();
        const dialog = page.getByRole("dialog");
        const first = dialog.getByLabel("新密码", { exact: true });
        const confirmation = dialog.getByLabel("确认新密码", { exact: true });
        const submit = dialog.getByRole("button", { name: "重置密码", exact: true });
        await expect(dialog).toContainText(email);
        await expect(dialog).toContainText("整个工作空间");
        await expect(first).toHaveAttribute("type", "password");
        await first.fill("short");
        await confirmation.fill("short");
        await expect(submit).toBeDisabled();
        await first.fill(next);
        await expect(dialog).toContainText("两次输入的密码不一致");
        await expect(submit).toBeDisabled();
        await confirmation.fill(next);
        await page.keyboard.press("Escape");
        await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
        await expect(first).toHaveValue(next);
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(more).toBeFocused();
        await open();
        await expect(first).toHaveValue("");
        await first.fill(next);
        await confirmation.fill(next);
        await page.route(`**/api/v1/accounts/${account.id}`, route => route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify({ code: "test_failure", title: "Internal failure" }) }));
        await submit.click();
        await expect(dialog.getByRole("alert")).toContainText("密码重置失败");
        await expect(first).toHaveValue(next);
        await page.unroute(`**/api/v1/accounts/${account.id}`);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        await page.route(`**/api/v1/accounts/${account.id}`, async route => {
          calls++;
          expect(route.request().postDataJSON()).toEqual({ password: next });
          await gate;
          await route.continue();
        });
        await submit.click();
        await expect(first).toBeDisabled();
        await expect(submit).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: test.info().outputPath("password-reset.png") });
        release();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(".account-management").getByRole("status")).toContainText(`已重置 ${email}`);
        expect(calls).toBe(1);
        expect((await target.request.get("/api/v1/auth/session")).status()).toBe(401);
        expect((await target.request.post("/api/v1/auth/login", { data: { username: email, password } })).status()).toBe(401);
        expect((await target.request.post("/api/v1/auth/login", { data: { username: email, password: next } })).status()).toBe(200);
        expect((await request.get("/api/v1/auth/session")).status()).toBe(200);
        const accounts = (await (await request.get("/api/v1/accounts")).json()).accounts;
        const updated = accounts.find((value: { id: string }) => value.id === account.id);
        expect(updated.email).toBe(email);
        expect(updated.role).toBe("member");
        expect(updated.permissions).toEqual([{ productId: fixture.productId, canView: true, canOperate: false, canUseAi: false }]);
      } finally { await target.close(); }
    });
  });
}

test("keeps self-service password changes separate from administrator reset", async ({ page, request, browser }) => {
  const self = (await (await request.get("/api/v1/auth/session")).json()).user;
  await page.goto("/settings/admin/accounts");
  await page.getByRole("searchbox", { name: "搜索账号", exact: true }).fill(self.username);
  const row = page.locator(".account-row").filter({ hasText: self.username });
  await row.locator(".account-more > summary").click();
  await expect(row.getByRole("button", { name: "重置密码", exact: true })).toHaveCount(0);
  const password = randomBytes(18).toString("base64url");
  const next = randomBytes(18).toString("base64url");
  const email = `self-${randomBytes(6).toString("hex")}@example.test`;
  await request.post("/api/v1/accounts", { data: { email, password, role: "member" } });
  const member = await browser.newContext({ baseURL: WEB_ORIGIN });
  try {
    await member.request.post("/api/v1/auth/login", { data: { username: email, password } });
    const own = await member.newPage();
    await own.goto("/settings/profile");
    await own.getByRole("button", { name: "修改密码", exact: true }).click();
    const dialog = own.getByRole("dialog");
    await dialog.getByLabel("当前密码", { exact: true }).fill(password);
    await dialog.getByLabel("新密码", { exact: true }).fill(next);
    await dialog.getByLabel("确认新密码", { exact: true }).fill(next);
    const changed = own.waitForResponse(response => response.url().endsWith("/api/v1/auth/password") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "修改密码", exact: true }).click();
    expect((await changed).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(own.getByRole("button", { name: "修改密码", exact: true })).toBeVisible();
    expect((await member.request.get("/api/v1/auth/session")).status()).toBe(200);
    expect((await member.request.post("/api/v1/auth/login", { data: { username: email, password: next } })).status()).toBe(200);
  } finally { await member.close(); }
});

test("opens reset from account details without silently discarding profile edits", async ({ page, request }) => {
  await page.setViewportSize({ width: 353, height: 757 });
  const email = `detail-reset-${randomBytes(6).toString("hex")}@example.test`;
  const account = await (await request.post("/api/v1/accounts", { data: { email, password: randomBytes(18).toString("base64url"), role: "member" } })).json();
  await page.goto(`/settings/admin/accounts/${account.id}`);
  const editor = page.getByRole("dialog", { name: "修改", exact: true });
  await editor.getByLabel("昵称", { exact: true }).fill("Unsaved nickname");
  await editor.getByRole("button", { name: "重置密码", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认操作", exact: true });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor.getByLabel("昵称", { exact: true })).toHaveValue("Unsaved nickname");
  await editor.getByRole("button", { name: "重置密码", exact: true }).click();
  await confirmation.getByRole("button", { name: "确认", exact: true }).click();
  const reset = page.getByRole("dialog", { name: "重置密码", exact: true });
  await expect(reset).toBeVisible();
  await expect(reset.getByLabel("新密码", { exact: true })).toBeEmpty();
  const next = randomBytes(18).toString("base64url");
  await reset.getByLabel("新密码", { exact: true }).fill(next);
  await reset.getByLabel("确认新密码", { exact: true }).fill(next);
  await reset.getByRole("button", { name: "重置密码", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".account-management").getByRole("status")).toContainText(`已重置 ${email}`);
  const stored = (await (await request.get("/api/v1/accounts")).json()).accounts.find((value: { id: string }) => value.id === account.id);
  expect(stored.nickname).toBeUndefined();
});
