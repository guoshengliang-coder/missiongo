import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };

for (const width of [375, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} temporary edits`, () => {
    test.use({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });

    test("cancel discards; Escape, outside click and Back protect input and restore focus", async ({ page }) => {
      await page.goto("/settings/profile");
      const trigger = page.getByRole("button", { name: "修改昵称", exact: true });
      const dialog = page.getByRole("dialog");
      await trigger.click();
      const input = dialog.getByRole("textbox", { name: "昵称", exact: true });
      const initial = await input.inputValue();
      await expect(input).toBeFocused();
      await input.fill("未保存的昵称");
      await page.screenshot({ path: test.info().outputPath("profile-dialog.png") });
      await page.keyboard.press("Escape");
      await expect(dialog.getByRole("heading", { name: "放弃修改？", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(input).toHaveValue("未保存的昵称");
      await expect(input).toBeFocused();
      await page.mouse.click(2, 2);
      await expect(dialog.getByRole("button", { name: "放弃修改", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      // The same-site history entry models Android's native Back callback.
      await page.evaluate(() => history.back());
      await expect(dialog.getByRole("heading", { name: "放弃修改？", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(input).toHaveValue(initial);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/profile/);
    });

    test("failed saves keep input; a pending save blocks every close path; success closes", async ({ page }) => {
      await page.goto("/settings/profile");
      await page.getByRole("button", { name: "修改昵称", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const input = dialog.getByRole("textbox", { name: "昵称", exact: true });
      await input.fill(`保存测试 ${width} ${theme}`);
      const path = "**/api/v1/auth/nickname";
      await page.route(path, route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ title: "保存失败，请重试", code: "test_save_failed" }) }));
      await dialog.getByRole("button", { name: "保存昵称", exact: true }).click();
      await expect(dialog.getByText("保存失败，请重试", { exact: true })).toBeVisible();
      await expect(input).toHaveValue(`保存测试 ${width} ${theme}`);
      await page.unroute(path);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route(path, async route => { await gate; await route.continue(); });
      await dialog.getByRole("button", { name: "保存昵称", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(input).toBeVisible();
      await page.evaluate(() => history.back());
      await expect(input).toBeVisible();
      release();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "昵称已保存" })).toBeVisible();
    });

    test("temporary forms fit the viewport and token results stay in the dialog", async ({ page }) => {
      await page.goto(`/settings/products/${fixture.productId}/components`);
      await page.getByRole("button", { name: "新增模块", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "模块名称", exact: true }).fill("取消的模块");
      await expect(dialog.getByRole("button", { name: "创建模块", exact: true })).toBeInViewport();
      expect(await dialog.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
      await page.screenshot({ path: test.info().outputPath("module-dialog.png") });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await page.goto("/settings/connections");
      await page.getByRole("button", { name: "新建个人令牌", exact: true }).click();
      await dialog.getByRole("textbox", { name: "名称", exact: true }).fill(`临时令牌 ${width} ${theme}`);
      await dialog.getByRole("button", { name: "生成令牌", exact: true }).click();
      await expect(dialog.getByRole("textbox", { name: "个人访问令牌", exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("token-result-dialog.png") });
      await dialog.getByRole("button", { name: "我已保存令牌", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "个人访问令牌", exact: true })).toHaveCount(0);
    });

    test("deleting an existing attachment is staged and cancellation sends no deletion", async ({ page, request }) => {
      await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const before = await (await request.get(`/api/v1/items/${fixture.detailKey}`)).json();
      let deletions = 0;
      page.on("request", req => { if (req.method() === "DELETE" && req.url().includes("/attachments/")) deletions++; });
      await dialog.locator(".attachment-card").first().getByRole("button", { name: /^删除 / }).click();
      const confirmation = page.getByRole("dialog", { name: "确认操作", exact: true });
      await confirmation.getByRole("button", { name: "确认", exact: true }).click();
      await expect(dialog.getByText(/已标记删除 1 个附件/)).toBeVisible();
      expect(deletions).toBe(0);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const after = await (await request.get(`/api/v1/items/${fixture.detailKey}`)).json();
      expect(after.attachments.map((file: { id: string }) => file.id)).toEqual(before.attachments.map((file: { id: string }) => file.id));
      expect(deletions).toBe(0);
    });
  });
}

test("staged attachment saves retry only operations that did not complete", async ({ page, request }) => {
  const item = await (await request.post("/api/v1/items", { data: { productId: fixture.productId, type: "task", priority: "normal", title: "Attachment retry", description: "Check partial save behavior", environment: { platform: "web" } } })).json();
  for (const name of ["first.log", "second.log"]) {
    const response = await request.post(`/api/v1/items/${item.key}/attachments`, { headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": "text/plain", "x-missiongo-filename": encodeURIComponent(name) }, data: Buffer.from("fixture log") });
    expect(response.ok()).toBe(true);
  }
  const original = await (await request.get(`/api/v1/items/${item.key}`)).json();
  const [first, second] = original.attachments as Array<{ id: string }>;
  let firstDeletes = 0;
  let secondDeletes = 0;
  await page.route(`**/api/v1/items/${item.key}/attachments/*`, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    if (route.request().url().endsWith(first!.id)) firstDeletes++;
    if (route.request().url().endsWith(second!.id) && ++secondDeletes === 1) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ title: "模拟附件处理失败" }) });
    }
    await route.continue();
  });
  await page.goto(`/?product=${fixture.productId}&item=${item.key}`);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: `编辑 ${item.key}`, exact: true });
  for (let index = 0; index < 2; index++) {
    await edit.locator(".attachment-card").first().getByRole("button", { name: /^删除 / }).click();
    await page.getByRole("dialog", { name: "确认操作", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
  }
  await edit.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(edit.getByText(/部分修改已保存/)).toBeVisible();
  await expect(edit.getByRole("button", { name: "保存修改", exact: true })).toBeEnabled();
  await edit.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = await (await request.get(`/api/v1/items/${item.key}`)).json();
  expect(saved.attachments).toHaveLength(0);
  expect(firstDeletes).toBe(1);
  expect(secondDeletes).toBe(2);
});

test.describe("short dialog viewport", () => {
  test.use({ viewport: { width: 375, height: 480 }, hasTouch: true, isMobile: true, colorScheme: "dark" });
  test("keeps a short form's commit controls visible", async ({ page }) => {
    await page.goto("/settings/profile");
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("当前密码", { exact: true }).fill("not-a-real-password");
    await expect(dialog.getByRole("button", { name: "修改密码", exact: true })).toBeInViewport();
    expect(await dialog.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
    await page.screenshot({ path: test.info().outputPath("short-password-dialog.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  });
});

test("an icon upload stays local until its own Save is confirmed", async ({ page, request }) => {
  const before = await (await request.get("/api/v1/products")).json();
  let writes = 0;
  page.on("request", req => { if (["PUT", "POST", "DELETE"].includes(req.method()) && req.url().includes(`/products/${fixture.productId}/icon`)) writes++; });
  await page.goto(`/settings/products/${fixture.productId}/product`);
  await page.locator(".product-icon-actions").getByRole("button").first().click();
  const dialog = page.getByRole("dialog");
  await page.locator(".product-icon-field input[type=file]").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=", "base64") });
  await expect(dialog.locator(".product-icon-draft")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(0);
  expect(await (await request.get("/api/v1/products")).json()).toEqual(before);
});

test("SDK credentials stay in one creation flow and protect their one-time result", async ({ page }) => {
  await page.goto(`/settings/products/${fixture.productId}/tokens`);
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "用途", exact: true }).fill("临时 SDK 凭证");
  await dialog.getByRole("button", { name: "创建令牌", exact: true }).click();
  await expect(dialog.locator(".sdk-token-reveal")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "我已保存令牌", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("令牌明文只展示这一次。请确认已经复制保存后再关闭。", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "返回查看", exact: true }).click();
  await expect(dialog.locator(".sdk-token-reveal")).toBeVisible();
  await dialog.getByRole("button", { name: "我已保存令牌", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("nested image editing owns Back and stages annotations until the item is saved", async ({ page }) => {
  let replacements = 0;
  page.on("request", req => { if (req.method() === "PUT" && req.url().includes("/attachments/")) replacements++; });
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: `编辑 ${fixture.detailKey}`, exact: true });
  const image = edit.locator(".attachment-image").first();
  const annotator = page.getByRole("dialog", { name: "标注图片", exact: true });
  await image.getByRole("button", { name: "标注图片", exact: true }).click();
  await expect(annotator.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await page.evaluate(() => history.back());
  await expect(annotator).toHaveCount(0);
  await expect(edit).toBeVisible();
  await image.getByRole("button", { name: "标注图片", exact: true }).click();
  await expect(annotator.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  const box = (await annotator.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.evaluate(() => history.back());
  const confirm = page.getByRole("dialog", { name: "放弃修改？", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(annotator).toBeVisible();
  await annotator.getByRole("button", { name: "保存", exact: true }).click();
  await expect(annotator).toHaveCount(0);
  await expect(edit.getByText("标注将在保存修改后生效。", { exact: true })).toBeVisible();
  expect(replacements).toBe(0);
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(replacements).toBe(0);
});
