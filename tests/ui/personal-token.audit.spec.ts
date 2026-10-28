import { expect, test } from "@playwright/test";

import { SERVER_PORT } from "./fixture.mjs";

for (const width of [375, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} personal tokens`, () => {
      test.use({ viewport: { width, height: 900 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });

      test("creates a scoped token once, lists it and revokes access", async ({ page, request }) => {
        await page.goto("/");
        const openSettings = async () => {
          if (width === 375) await page.getByRole("button", { name: "打开导航", exact: true }).click();
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page.getByRole("button", { name: "Agent 配置", exact: true }).click();
          await page.locator(".settings-hub-row").filter({ has: page.getByText("连接与授权", { exact: true }) }).click();
        };
        await openSettings();
        const section = page.getByRole("region", { name: "个人访问令牌", exact: true });
        await expect(section).toBeVisible();
        await expect(section).toContainText("直接令牌授权");
        await section.getByRole("button", { name: "新建个人令牌", exact: true }).click();
        await expect(section.getByRole("button", { name: "生成令牌", exact: true })).toBeDisabled();
        const name = `Token ${width} ${theme}`;
        await section.getByLabel("名称", { exact: true }).fill(name);
        await section.getByRole("combobox", { name: "权限", exact: true }).selectOption("write");
        await section.getByRole("combobox", { name: "有效期", exact: true }).selectOption("7");
        const overflow = await section.evaluate(element => element.scrollWidth > element.clientWidth);
        expect(overflow).toBe(false);
        await section.screenshot({ path: test.info().outputPath("personal-token-form.png") });

        const response = page.waitForResponse(response => response.url().endsWith("/api/v1/ai-personal-tokens") && response.request().method() === "POST");
        await section.getByRole("button", { name: "生成令牌", exact: true }).click();
        const created = await response;
        expect(created.status()).toBe(201);
        const minted = await created.json();
        expect(minted.scopes).toEqual(["missiongo:read", "missiongo:write"]);
        await expect(section.getByRole("textbox", { name: "个人访问令牌", exact: true })).toHaveValue(minted.token);
        const call = () => request.post(`http://127.0.0.1:${SERVER_PORT}/mcp`, {
          headers: { authorization: `Bearer ${minted.token}`, accept: "application/json, text/event-stream" },
          data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_account", arguments: {} } },
        });
        expect((await call()).status()).toBe(200);

        await page.getByRole("button", { name: "返回工作区", exact: true }).click();
        await openSettings();
        await expect(section.getByRole("textbox", { name: "个人访问令牌", exact: true })).toHaveCount(0);
        const row = page.locator(".account-row").filter({ hasText: name });
        await expect(row).toContainText("missiongo:write");
        page.once("dialog", dialog => dialog.accept());
        await row.getByRole("button", { name: "撤销", exact: true }).click();
        await expect(row).toHaveCount(0);
        expect((await call()).status()).toBe(401);
      });
    });
  }
}
