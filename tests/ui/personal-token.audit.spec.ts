import { expect, test } from "@playwright/test";

import { SERVER_PORT } from "./fixture.mjs";

for (const width of [375, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} personal tokens`, () => {
      test.use({ viewport: { width, height: 900 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme, permissions: ["clipboard-read", "clipboard-write"] });

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
        const dialog = page.getByRole("dialog", { name: "新建个人令牌", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "生成令牌", exact: true })).toBeDisabled();
        // New tokens default to the write scope and the longest lifetime.
        await expect(dialog.getByRole("combobox", { name: "权限", exact: true })).toHaveValue("write");
        await expect(dialog.getByRole("combobox", { name: "有效期", exact: true })).toHaveValue("365");
        const name = `Token ${width} ${theme}`;
        await dialog.getByLabel("名称", { exact: true }).fill(name);
        await dialog.getByRole("combobox", { name: "权限", exact: true }).selectOption("write");
        await dialog.getByRole("combobox", { name: "有效期", exact: true }).selectOption("7");
        const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth);
        expect(overflow).toBe(false);
        await dialog.screenshot({ path: test.info().outputPath("personal-token-form.png") });

        const response = page.waitForResponse(response => response.url().endsWith("/api/v1/ai-personal-tokens") && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "生成令牌", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const created = await response;
        expect(created.status()).toBe(201);
        const minted = await created.json();
        expect(minted.scopes).toEqual(["missiongo:read", "missiongo:write"]);
        await expect(section.getByRole("textbox", { name: "个人访问令牌", exact: true })).toHaveValue(minted.token);
        // The reveal carries its own copy button; the clipboard really gets the token.
        await section.getByRole("button", { name: "复制", exact: true }).click();
        await expect(section.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(minted.token);
        await section.locator(".account-add-form").screenshot({ path: test.info().outputPath("personal-token-reveal.png") });
        const call = (token = minted.token) => request.post(`http://127.0.0.1:${SERVER_PORT}/mcp`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
          data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_account", arguments: {} } },
        });
        expect((await call()).status()).toBe(200);

        const otherResponse = await request.post("/api/v1/ai-personal-tokens", {
          data: { name, scopes: ["missiongo:read"], days: 7 },
        });
        expect(otherResponse.status()).toBe(201);
        const other = await otherResponse.json();

        await page.getByRole("button", { name: "返回工作区", exact: true }).click();
        await openSettings();
        // The second token was created outside the page; reload to read it
        // without the still-fresh query cached by the first creation.
        await page.reload();
        await expect(section.getByRole("textbox", { name: "个人访问令牌", exact: true })).toHaveCount(0);
        const group = page.getByRole("region", { name: "个人令牌", exact: true })
          .locator(".ai-client-group").filter({ hasText: name });
        await expect(group).toHaveCount(1);
        await expect(group.locator("summary")).toContainText("2 个连接");
        await expect(group.locator("summary")).toContainText("各连接权限不同");
        await expect(group.getByRole("button", { name: "撤销", exact: true })).toHaveCount(0);
        await group.locator("summary").click();
        const row = group.locator(".ai-connection-entry").filter({ hasText: "修改条目" });
        await expect(row).toContainText("查看条目");
        await expect(row).toContainText("授权时间");
        await expect(row).toContainText("到期时间");
        page.once("dialog", dialog => dialog.accept());
        await row.getByRole("button", { name: "撤销", exact: true }).click();
        await expect(row).toHaveCount(0);
        await expect(group.locator("summary")).toContainText("1 个连接");
        await expect(group.locator("summary")).not.toContainText("各连接权限不同");
        expect((await call()).status()).toBe(401);
        expect((await call(other.token)).status()).toBe(200);
        expect((await request.delete(`/api/v1/ai-authorizations/${other.id}`)).status()).toBe(204);
      });
    });
  }
}
