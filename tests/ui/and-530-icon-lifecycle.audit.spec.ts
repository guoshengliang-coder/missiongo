import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { solidPng } from "../../scripts/seed-ui-fixture.mjs";

const png = solidPng(96, 96, [30, 90, 160]);
async function create(request: APIRequestContext, icon = true) {
  const prefix = `A${randomUUID().slice(0, 6)}`;
  const response = await request.post("/api/v1/products", { data: { name: `生命周期 ${prefix}`, keyPrefix: prefix } });
  expect(response.ok()).toBe(true);
  const product = await response.json() as { id: string };
  if (icon) expect((await request.put(`/api/v1/products/${product.id}/icon`, {
    data: png, headers: { "content-type": "application/octet-stream" },
  })).ok()).toBe(true);
  return product;
}
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-11-16T04:00:00Z")); });

test("a browser without image.decode still displays the completed image", async ({ page, request }) => {
  const p = await create(request);
  await page.addInitScript(() => { Object.defineProperty(HTMLImageElement.prototype, "decode", { value: undefined }); });
  await page.goto(`/?product=${p.id}`);
  const badge = page.getByRole("combobox", { name: "当前产品", exact: true }).locator(".product-badge");
  await expect(badge).toHaveAttribute("data-icon-state", "ready");
  await expect(badge.locator("img")).toHaveCSS("opacity", "1");
  await expect(badge.locator(".product-badge-label")).toBeHidden();
});

test("transparent uploaded pixels cannot reveal the generated badge underneath", async ({ page, request }) => {
  const p = await create(request, false);
  const transparent = await sharp({ create: { width: 96, height: 96, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  expect((await request.put(`/api/v1/products/${p.id}/icon`, {
    data: transparent, headers: { "content-type": "application/octet-stream" },
  })).ok()).toBe(true);
  await page.goto(`/settings/products/${p.id}/product`);
  const badge = page.locator(".product-icon-field .product-badge");
  await expect(badge).toHaveAttribute("data-icon-state", "ready");
  await expect(badge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(badge.locator(".product-badge-label")).toBeHidden();
  await expect(badge).toHaveCSS("width", "48px");
  await page.screenshot({ path: test.info().outputPath("transparent-icon.png") });
});

test("a late rejection from an old decode cannot hide its successful replacement", async ({ page, request }) => {
  const p = await create(request);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    const control = window as unknown as { holdDecodes: boolean; rejectOld: (() => void)[] };
    control.holdDecodes = true;
    control.rejectOld = [];
    HTMLImageElement.prototype.decode = function () {
      return control.holdDecodes ? new Promise<void>((_, reject) => control.rejectOld.push(() => reject(new Error("old decode")))) : decode.call(this);
    };
  });
  await page.goto(`/settings/products/${p.id}/product`);
  const badge = page.locator(".product-icon-field .product-badge");
  await expect.poll(() => page.evaluate(() => (window as unknown as { rejectOld: unknown[] }).rejectOld.length)).toBeGreaterThan(0);
  await page.evaluate(() => { (window as unknown as { holdDecodes: boolean }).holdDecodes = false; });
  await page.locator(".product-icon-actions").getByRole("button").first().click();
  await page.locator(".product-icon-field input[type=file]").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: png });
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(badge).toHaveAttribute("data-icon-state", "ready");
  const replacement = await badge.locator("img").getAttribute("src");
  await page.evaluate(() => { for (const reject of (window as unknown as { rejectOld: (() => void)[] }).rejectOld) reject(); });
  await expect(badge).toHaveAttribute("data-icon-state", "ready");
  await expect(badge.locator("img")).toHaveAttribute("src", replacement!);
  expect(errors).toEqual([]);
});

test("session revocation cancels queued warming before another icon starts", async ({ page, request }) => {
  const current = await create(request, false);
  const targets = [];
  for (let i = 0; i < 8; i++) targets.push(await create(request));
  const ids = new Set([current.id, ...targets.map(p => p.id)]);
  let refused = false, requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/bootstrap?*", async route => {
    if (refused) { await route.fulfill({ status: 401, json: { code: "unauthenticated", title: "Sign in" } }); return; }
    const response = await route.fetch(), data = await response.json();
    data.products = data.products.filter((p: { id: string }) => ids.has(p.id));
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/v1/products/*/icon?*", async route => {
    requests++;
    await gate;
    await route.fulfill({ contentType: "image/png", body: png }).catch(() => undefined);
  });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith("/api/v1/console/events")) return original(input, init);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        (window as unknown as { revokeIconSession: () => void }).revokeIconSession = () => controller.enqueue(
          new TextEncoder().encode('event: unauthorized\ndata: {}\n\n'));
        init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
  try {
    await page.goto(`/?product=${current.id}`);
    await expect.poll(() => requests).toBe(2);
    refused = true;
    await page.evaluate(() => (window as unknown as { revokeIconSession: () => void }).revokeIconSession());
    await expect(page.locator(".connection-page")).toBeVisible();
    release();
    await page.waitForTimeout(500);
    expect(requests).toBe(2);
    await expect(page.locator(".product-badge")).toHaveCount(0);
  } finally { release(); }
});
