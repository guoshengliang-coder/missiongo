import { test, expect, type Page } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

async function audit(page: Page, touch: boolean) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const measurements = await page.evaluate(AUDIT_SOURCE) as { text: Array<{ fontSize: number; fontWeight: number; contrast: number }>; targets: Array<{ width: number; height: number }> };
  expect(measurements.text.filter(value => value.fontSize > 0 && value.fontSize < 11)).toEqual([]);
  expect(measurements.text.filter(value => value.contrast < (value.fontSize >= 24 || value.fontWeight >= 700 && value.fontSize >= 18.66 ? 3 : 4.5))).toEqual([]);
  if (touch) expect(measurements.targets.filter(value => value.width > 0 && value.height > 0 && (value.width < 43.99 || value.height < 43.99))).toEqual([]);
  for (const dialog of await page.getByRole("dialog").all()) {
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
  }
}

for (const viewport of [{ width: 1366, height: 950 }, { width: 375, height: 812 }]) {
  test.describe(`DingTalk settings ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375, isMobile: viewport.width === 375, colorScheme: viewport.width === 375 ? "dark" : "light" });
    test("shows summaries and uses dialogs for configuration, bindings and CSV imports", async ({ page, request }, info) => {
      const suffix = String(viewport.width);
      const account = await (await request.post("/api/v1/accounts", { data: { email: `dingtalk-${suffix}@example.test`, password: "synthetic-notification-password", role: "member" } })).json();
      const product = await (await request.post("/api/v1/products", { data: { name: `Notification project ${suffix}`, keyPrefix: `NT${suffix}` } })).json();
      await page.goto("/settings/admin/dingtalk");
      await expect(page.locator(".dingtalk-settings details")).toHaveCount(0);
      await expect(page.locator(".dingtalk-settings form")).toHaveCount(0);
      await page.getByRole("button", { name: /^(配置应用|修改配置)$/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("组织 ID（CorpId）", { exact: true }).fill("synthetic-corp");
      await dialog.getByLabel("Client ID（AppKey）", { exact: true }).fill("synthetic-app");
      await dialog.getByLabel("Agent ID", { exact: true }).fill("123");
      await dialog.getByLabel("Client Secret（AppSecret）", { exact: true }).fill("synthetic-client-secret");
      await audit(page, viewport.width === 375);
      await page.screenshot({ path: info.outputPath("dingtalk-application-dialog.png") });
      await dialog.getByRole("button", { name: "保存钉钉配置", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("钉钉配置已保存。", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.locator(".dingtalk-info-grid").getByText("synthetic-corp", { exact: true })).toBeVisible();
      await expect(page.locator("input[type=password]")).toHaveCount(0);
      await page.getByRole("button", { name: "修改配置", exact: true }).click();
      await expect(dialog.getByLabel("Client Secret（AppSecret）", { exact: true })).toHaveValue("");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);

      let credentialChecks = 0;
      await page.route("**/api/v1/dingtalk/check", route => {
        credentialChecks++;
        return route.fulfill({ json: { available: true } });
      });
      await page.getByRole("button", { name: "检查应用凭据", exact: true }).click();
      await expect(dialog).toBeVisible();
      expect(credentialChecks).toBe(0);
      await dialog.getByRole("button", { name: "检查应用凭据", exact: true }).click();
      await expect(dialog.getByRole("status")).toContainText("应用凭据可用");
      expect(credentialChecks).toBe(1);
      await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
      await expect(dialog).toHaveCount(0);

      const binding = page.getByRole("article", { name: account.email, exact: true });
      await binding.getByRole("button", { name: "配置绑定", exact: true }).click();
      await dialog.getByLabel("钉钉企业用户 ID（userId）", { exact: true }).fill(`employee-${suffix}`);
      await dialog.getByLabel("钉钉姓名（选填）", { exact: true }).fill("测试人员");
      await dialog.getByLabel("部门（选填）", { exact: true }).fill("测试部门");
      await audit(page, viewport.width === 375);
      await page.screenshot({ path: info.outputPath("dingtalk-binding-dialog.png") });
      await dialog.getByRole("button", { name: "保存人员绑定", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(binding.getByText("人员绑定已保存。", { exact: true })).toBeVisible();
      await expect(binding.getByText(`employee-${suffix}`, { exact: true })).toBeVisible();
      await expect(binding.getByText("测试部门", { exact: true })).toBeVisible();
      await expect(binding.locator("input, form, summary")).toHaveCount(0);

      await page.getByRole("button", { name: "批量导入", exact: true }).click();
      await dialog.getByLabel("CSV 内容", { exact: true }).fill(`邮箱,钉钉用户 ID,姓名,部门\n${account.email},employee-${suffix},批量姓名,测试部门\nmissing@example.test,unknown-user,,`);
      await dialog.getByRole("button", { name: "预览匹配结果", exact: true }).click();
      await expect(dialog.getByText("MissionGo 账号不存在", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "确认导入 2 条绑定", exact: true })).toBeDisabled();
      await dialog.getByLabel("CSV 内容", { exact: true }).fill(`邮箱,钉钉用户 ID,姓名,部门\n${account.email},employee-${suffix},批量姓名,测试部门`);
      await dialog.getByRole("button", { name: "预览匹配结果", exact: true }).click();
      await audit(page, viewport.width === 375);
      await page.screenshot({ path: info.outputPath("dingtalk-import-dialog.png") });
      await dialog.getByRole("button", { name: "确认导入 1 条绑定", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("人员绑定已导入。", { exact: true })).toBeVisible();
      const saved = await (await request.get("/api/v1/dingtalk/bindings")).json();
      expect(saved.bindings.find((value: { accountId: string }) => value.accountId === account.id)).toMatchObject({ name: "批量姓名", userId: `employee-${suffix}` });
      await expect(binding.getByText("批量姓名", { exact: true })).toBeVisible();
      await page.locator(".settings-page-main").evaluate(element => element.scrollTo({ top: 0 }));
      await audit(page, viewport.width === 375);
      await page.screenshot({ path: info.outputPath("dingtalk-settings.png"), fullPage: true });

      await page.goto(`/settings/products/${product.id}/notifications`);
      await page.getByRole("checkbox", { name: "进入待验证时通知提需者", exact: true }).check();
      await page.getByRole("button", { name: "保存通知设置", exact: true }).click();
      await expect(page.getByText("通知设置已保存。", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("checkbox", { name: "进入待验证时通知提需者", exact: true })).toBeChecked();
      await page.getByRole("checkbox", { name: "进入待验证时通知提需者", exact: true }).uncheck();
      await page.locator(".settings-page-header").getByRole("button").click();
      await expect(dialog).toBeVisible();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "进入待验证时通知提需者", exact: true })).not.toBeChecked();
    });

    test("protects binding drafts, confirms removal and shows test progress without sending on open", async ({ page, request }, info) => {
      const suffix = String(viewport.width);
      const account = await (await request.post("/api/v1/accounts", { data: { email: `dingtalk-dialog-${suffix}@example.test`, password: "synthetic-notification-password", role: "member" } })).json();
      const config = await (await request.get("/api/v1/dingtalk/settings")).json();
      expect((await request.put("/api/v1/dingtalk/settings", { data: { corpId: "synthetic-corp", clientId: "synthetic-app", agentId: "123", clientSecret: "synthetic-client-secret", expectedRevision: config.revision } })).ok()).toBe(true);
      await page.goto("/settings/admin/dingtalk");
      const binding = page.getByRole("article", { name: account.email, exact: true });
      const dialog = page.getByRole("dialog");
      await binding.getByRole("button", { name: "配置绑定", exact: true }).click();
      const userId = dialog.getByLabel("钉钉企业用户 ID（userId）", { exact: true });
      await userId.fill(`dialog-employee-${suffix}`);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "放弃修改？", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(userId).toHaveValue(`dialog-employee-${suffix}`);
      await page.evaluate(() => history.back());
      await expect(dialog.getByRole("heading", { name: "放弃修改？", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();

      const savePath = `**/api/v1/dingtalk/bindings/${account.id}`;
      await page.route(savePath, route => route.fulfill({ status: 500, json: { title: "模拟保存失败", code: "test_failed" } }));
      await dialog.getByRole("button", { name: "保存人员绑定", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("模拟保存失败");
      await expect(userId).toHaveValue(`dialog-employee-${suffix}`);
      await page.unroute(savePath);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      await page.route(savePath, async route => { await pending; await route.continue(); });
      await dialog.getByRole("button", { name: "保存人员绑定", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(userId).toBeVisible();
      release();
      await expect(dialog).toHaveCount(0);
      await page.unroute(savePath);

      // Simulate DingTalk results at the browser/API boundary; never send an
      // external message or require real corporate credentials in UI tests.
      let sends = 0, polls = 0;
      let notice: { id: string; kind: string; status: string; reason: string; attempts: number; createdAt: string; updatedAt: string } | undefined;
      await page.route("**/api/v1/dingtalk/bindings", async route => {
        const response = await route.fetch();
        const data = await response.json();
        if (notice) {
          const status = ++polls >= 3 ? "sent" : polls >= 2 ? "accepted" : "queued";
          data.tests[account.id] = { ...notice, status, reason: status === "sent" ? "钉钉确认发送成功；不代表已读或验收通过。" : "" };
        }
        await route.fulfill({ response, json: data });
      });
      await page.route(`**/api/v1/dingtalk/bindings/${account.id}/test`, route => {
        sends++;
        notice = { id: `synthetic-test-${suffix}`, kind: "test", status: "queued", reason: "", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        return route.fulfill({ json: notice });
      });
      await binding.getByRole("button", { name: "测试通知", exact: true }).click();
      await expect(dialog.getByText(`dialog-employee-${suffix}`, { exact: true })).toBeVisible();
      expect(sends).toBe(0);
      await dialog.getByRole("button", { name: "发送测试通知", exact: true }).click();
      await expect(dialog.getByText("等待发送", { exact: true })).toBeVisible();
      await expect(dialog.getByText("发送成功", { exact: true })).toBeVisible({ timeout: 20_000 });
      expect(sends).toBe(1);
      await expect(dialog.getByRole("button", { name: "发送测试通知", exact: true })).toBeDisabled();
      await audit(page, viewport.width === 375);
      await page.screenshot({ path: info.outputPath("dingtalk-test-dialog.png") });
      await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
      await expect(dialog).toHaveCount(0);
      await expect(binding.getByText(/最近测试：发送成功/)).toBeVisible();
      await binding.getByRole("button", { name: "修改绑定", exact: true }).click();
      await dialog.getByRole("button", { name: "解除绑定", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "确认解除绑定", exact: true })).toBeVisible();
      const before = await (await request.get("/api/v1/dingtalk/bindings")).json();
      expect(before.bindings.some((value: { accountId: string }) => value.accountId === account.id)).toBe(true);
      await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
      await expect(userId).toHaveValue(`dialog-employee-${suffix}`);
      await dialog.getByRole("button", { name: "解除绑定", exact: true }).click();
      await dialog.getByRole("button", { name: "确认解除绑定", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(binding.getByText("未绑定", { exact: true })).toBeVisible();
      await expect(binding.getByRole("button", { name: "测试通知", exact: true })).toBeDisabled();
      const after = await (await request.get("/api/v1/dingtalk/bindings")).json();
      expect(after.bindings.some((value: { accountId: string }) => value.accountId === account.id)).toBe(false);
    });
  });
}
