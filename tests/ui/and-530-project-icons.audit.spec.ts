import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { solidPng } from "../../scripts/seed-ui-fixture.mjs";

const png = solidPng(96, 96, [20, 120, 70]);
const otherPng = solidPng(96, 96, [120, 20, 70]);
const stamp = new Date("2026-11-16T03:00:00Z");

async function product(request: APIRequestContext) {
  const prefix = `I${randomUUID().slice(0, 6)}`;
  const created = await request.post("/api/v1/products", { data: { name: `项目图标 ${prefix}`, keyPrefix: prefix } });
  expect(created.status()).toBe(201);
  const result = await created.json() as { id: string; name: string; keyPrefix: string };
  expect((await request.put(`/api/v1/products/${result.id}/icon`, { data: png, headers: { "content-type": "application/octet-stream" } })).ok()).toBe(true);
  return result;
}

const trigger = (page: Page) => page.getByRole("combobox", { name: "当前产品", exact: true });
const option = (page: Page, id: string) => page.locator(`[role=option][data-value="${id}"]`);
const path = (id: string, console: boolean) => `/?product=${id}${console ? "&console=agent" : ""}`;

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(stamp); });

for (const console of [false, true]) for (const theme of ["light", "dark"] as const) for (const width of [320, 1440]) {
  test.describe(`${console ? "console" : "items"} ${theme} ${width}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 320 });
    test("shows a stable fallback until image decode, then preserves selection and focus", async ({ page, request }) => {
      const p = await product(request);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route(`**/products/${p.id}/icon?*`, async route => { await gate; await route.fulfill({ contentType: "image/png", body: png }); });
      try {
        await page.goto(path(p.id, console));
        await page.evaluate(() => document.documentElement.setAttribute("data-font-scale", "large"));
        await trigger(page).click();
        const badge = option(page, p.id).locator(".product-badge");
        await expect(badge).toHaveAttribute("data-icon-state", "loading");
        await expect(badge.locator(".product-badge-label")).toBeVisible();
        await expect(option(page, p.id)).toContainText(p.name);
        const before = await badge.boundingBox();
        const rowBefore = await option(page, p.id).boundingBox();
        await page.screenshot({ path: test.info().outputPath("pending.png") });
        release();
        await expect(badge).toHaveAttribute("data-icon-state", "ready");
        await expect(badge.locator(".product-badge-label")).toBeHidden();
        await expect(badge.locator("img")).toHaveCSS("opacity", "1");
        expect(await badge.boundingBox()).toEqual(before);
        expect(await option(page, p.id).boundingBox()).toEqual(rowBefore);
        await page.screenshot({ path: test.info().outputPath("ready.png") });
        await option(page, p.id).click();
        await expect(trigger(page)).toBeFocused();
        await trigger(page).click();
        await expect(badge).toHaveAttribute("data-icon-state", "ready");
        await page.keyboard.press("Escape");
        await expect(trigger(page)).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      } finally { release(); }
    });
  });
}

for (const failure of ["404", "network", "invalid", "decode"] as const) {
  test(`${failure} retains the fallback and reopens successfully without an automatic retry loop`, async ({ page, request }) => {
    const p = await product(request);
    let recovered = false, requests = 0;
    if (failure === "decode") await page.addInitScript(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        return (window as unknown as { failIconDecode?: boolean }).failIconDecode ? Promise.reject(new Error("decode failed")) : decode.call(this);
      };
      (window as unknown as { failIconDecode: boolean }).failIconDecode = true;
    });
    await page.route(`**/products/${p.id}/icon?*`, async route => {
      requests++;
      if (recovered || failure === "decode") await route.fulfill({ contentType: "image/png", body: png });
      else if (failure === "network") await route.abort("failed");
      else await route.fulfill({ status: failure === "404" ? 404 : 200, contentType: "image/png", body: "not an image" });
    });
    await page.goto(path(p.id, true));
    await trigger(page).click();
    const badge = option(page, p.id).locator(".product-badge");
    await expect(badge).toHaveAttribute("data-icon-state", "fallback");
    await expect(badge.locator(".product-badge-label")).toBeVisible();
    await expect(badge.locator("img")).toHaveCSS("opacity", "0");
    // The trigger, menu image and deferred prewarm are three distinct consumers.
    // Wait for the one-off low-priority request, then check it stays settled.
    await page.waitForTimeout(1_200);
    const settled = requests;
    expect(settled).toBeLessThanOrEqual(3);
    await page.waitForTimeout(400);
    expect(requests).toBe(settled);
    await page.keyboard.press("Escape");
    recovered = true;
    await page.evaluate(() => { (window as unknown as { failIconDecode: boolean }).failIconDecode = false; });
    await trigger(page).click();
    await expect(badge).toHaveAttribute("data-icon-state", "ready");
  });
}

test("preloads another project's icon before the menu is opened", async ({ page, request }) => {
  const p = await product(request);
  const current = await (await request.post("/api/v1/products", { data: {
    name: "无上传图标的当前项目", keyPrefix: `C${randomUUID().slice(0, 6)}`,
  } })).json() as { id: string };
  // A controlled product snapshot keeps this icon within the bounded warm set.
  await page.route("**/api/v1/bootstrap?*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.products = data.products.filter((entry: { id: string }) => entry.id === p.id || entry.id === current.id);
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/v1/products", async route => {
    const response = await route.fetch();
    const products = await response.json();
    await route.fulfill({ response, json: products.filter((entry: { id: string }) => entry.id === p.id || entry.id === current.id) });
  });
  let seen = 0;
  await page.route(`**/products/${p.id}/icon?*`, async route => { seen++; await route.fulfill({ contentType: "image/png", body: png }); });
  await page.goto(path(current.id, false));
  await expect(trigger(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("data-value", current.id);
  await expect.poll(() => seen).toBe(1);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("settings badges isolate late old decodes, show replacement versions and handle deletion", async ({ page, request }) => {
  const p = await product(request);
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    const controls = window as unknown as { holdIconDecode: boolean; finishOldDecode: () => void };
    controls.holdIconDecode = true;
    HTMLImageElement.prototype.decode = function () {
      if (!controls.holdIconDecode) return decode.call(this);
      return new Promise<void>(resolve => { controls.finishOldDecode = resolve; });
    };
  });
  await page.goto(`/settings/products/${p.id}/product`);
  const badge = page.locator(".product-icon-field .product-badge");
  await expect(badge).toHaveAttribute("data-icon-state", "loading");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishOldDecode: unknown }).finishOldDecode)).toBe("function");
  await page.evaluate(() => { (window as unknown as { holdIconDecode: boolean }).holdIconDecode = false; });
  // Real UI upload invalidates the product query without reloading the page.
  await page.locator(".product-icon-actions").getByRole("button").first().click();
  await page.locator(".product-icon-field input[type=file]").setInputFiles({ name: "new.png", mimeType: "image/png", buffer: otherPng });
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(badge).toHaveAttribute("data-icon-state", "ready");
  const newSrc = await badge.locator("img").getAttribute("src");
  await page.evaluate(() => (window as unknown as { finishOldDecode: () => void }).finishOldDecode());
  await expect(badge.locator("img")).toHaveAttribute("src", newSrc!);
  await page.locator(".product-icon-actions").getByRole("button").last().click();
  const confirm = page.getByRole("dialog");
  await confirm.getByRole("button", { name: "保存", exact: true }).click();
  await expect(badge).toHaveAttribute("data-icon-state", "fallback");
  await expect(badge.locator("img")).toHaveCount(0);
  await expect(badge.locator(".product-badge-label")).toBeVisible();
  await page.goto("/settings/products");
  const card = page.locator(`.settings-product-card[data-product-id="${p.id}"] .product-badge`);
  await expect(card).toHaveAttribute("data-icon-state", "fallback");
  await expect(card).toHaveCSS("width", "40px");
});

test("real private-cache images remain ready across menu reopening and entry changes", async ({ page, request }) => {
  const p = await product(request);
  // No route interception here: keep the real image response and browser cache.
  await page.goto(path(p.id, false));
  await expect(trigger(page).locator(".product-badge")).toHaveAttribute("data-icon-state", "ready");
  for (let i = 0; i < 3; i++) {
    await trigger(page).click();
    const badge = option(page, p.id).locator(".product-badge");
    await expect(badge).toHaveAttribute("data-icon-state", "ready");
    expect(await badge.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: /Agent 控制台/ }).click();
  await expect(trigger(page).locator(".product-badge")).toHaveAttribute("data-icon-state", "ready");
  await trigger(page).click();
  await expect(option(page, p.id).locator(".product-badge")).toHaveAttribute("data-icon-state", "ready");
});
