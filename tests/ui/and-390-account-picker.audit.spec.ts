import { expect, test, type APIRequestContext } from "@playwright/test";

import { SERVER_PORT } from "./fixture.mjs";

/**
 * AND-390: granting a product's access used to mean typing a whole email address
 * because the roster was an administrator's to know. A creator now picks from a
 * searchable list instead.
 *
 * These run as a member who created the product, not as the fixture's
 * administrator: an administrator already sees every account as a row and never
 * gets the picker.
 */

const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const PASSWORD = "a member password";

async function call(request: APIRequestContext, path: string, cookie: string, init: { method?: string; data?: unknown } = {}) {
  const response = await request.fetch(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie },
    ...(init.data === undefined ? {} : { data: init.data }),
  });
  expect(response.ok(), `${path} -> ${response.status()} ${await response.text()}`).toBe(true);
  return response.status() === 204 ? undefined : response.json();
}

async function signIn(request: APIRequestContext, username: string): Promise<string> {
  const response = await request.post(`${ORIGIN}/api/v1/auth/login`, { data: { username, password: PASSWORD } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value.split(";")[0])
    .join("; ");
}

test("AND-390 lets a product's creator pick from the accounts they can grant", async ({ page, request, browser }) => {
  const admin = (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const creatorEmail = "and-390-creator@example.test";
  await call(request, "/api/v1/accounts", admin, {
    method: "POST",
    data: { email: creatorEmail, password: PASSWORD, role: "member" },
  });
  const zhang = await call(request, "/api/v1/accounts", admin, {
    method: "POST",
    data: { email: "and-390-zhang@example.test", password: PASSWORD, role: "member" },
  });
  const li = await call(request, "/api/v1/accounts", admin, {
    method: "POST",
    data: { email: "and-390-li@example.test", password: PASSWORD, role: "member" },
  });
  await call(request, `/api/v1/accounts/${zhang.id}`, admin, { method: "PATCH", data: { nickname: "张三丰" } });
  await call(request, `/api/v1/accounts/${li.id}`, admin, { method: "PATCH", data: { nickname: "李四" } });

  const creatorCookie = await signIn(request, creatorEmail);
  const product = await call(request, "/api/v1/products", creatorCookie, {
    method: "POST",
    data: { name: "AND-390 picker", keyPrefix: "A390" },
  });

  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  await Promise.all(creatorCookie.split("; ").map((pair) => {
    const separator = pair.indexOf("=");
    return context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), domain: "127.0.0.1", path: "/" }]);
  }));
  const creator = await context.newPage();
  await creator.goto(`/settings/permissions/${product.id}`);

  const field = creator.getByRole("combobox", { name: "搜索昵称或邮箱" });
  await expect(field).toBeVisible();
  await field.click();
  const list = creator.getByRole("listbox", { name: "可添加的账号" });
  await expect(list.getByRole("option", { name: /张三丰/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /李四/ })).toBeVisible();

  // An administrator already reaches every product, so they are listed to say
  // they exist but cannot be granted anything here.
  const administrator = list.getByRole("option", { name: /ui-fixture@example\.test/ });
  await expect(administrator).toHaveAttribute("aria-disabled", "true");
  await expect(administrator).toContainText("已有权限");
  await creator.screenshot({ path: "/tmp/and-390-picker-open.png" });

  await field.fill("李");
  await expect(list.getByRole("option", { name: /张三丰/ })).toBeHidden();
  await expect(list.getByRole("option", { name: /李四/ })).toBeVisible();

  await list.getByRole("option", { name: /李四/ }).click();
  const pending = creator.locator(".account-permissions tbody tr", { hasText: "保存后添加" });
  await expect(pending).toContainText("李四");
  await expect(pending).toContainText("and-390-li@example.test");
  await creator.screenshot({ path: "/tmp/and-390-picker-selected.png" });

  await creator.locator(".account-permissions-footer .primary-button").click();
  await expect(creator.locator(".account-permissions tbody tr", { hasText: "and-390-li@example.test" })).toBeVisible();

  await context.close();
});
