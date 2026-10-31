import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const version = JSON.parse(readFileSync(new URL("../../product.json", import.meta.url), "utf8")).web.version;
for (const width of [375, 480, 680, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme} Web polish`, () => {
    test.use({ viewport: { width, height: 1000 }, hasTouch: width === 375, isMobile: width === 375, colorScheme: theme });
    test("keeps priority filters available, drafts transactional and toolbar sizes aligned", async ({ page, request }) => {
      const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
      await page.goto(`/?product=${fixture.productId}&status=ready`);
      const bar = page.locator(".list-filter-bar");
      const dialog = page.getByRole("dialog");
      await expect(page.locator(".workspace-head .eyebrow")).toHaveCount(0);
      const manifest = await (await request.get("/web-version.json")).json();
      expect(manifest.version).toBe(version);
      const versionLabel = page.locator(".sidebar .web-version");
      if (width <= 1023) await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await expect(versionLabel).toBeVisible();
      await expect(versionLabel).toHaveText(`Web v${version}`);
      if (width <= 1023) await page.getByRole("button", { name: "关闭导航", exact: true }).first().click();
      const proposer = bar.locator(".list-filter-proposer");
      if (width >= 480) {
        await expect(proposer).toBeVisible();
        await proposer.click();
      } else {
        await bar.locator(".list-filter-more").click();
        await dialog.getByRole("button", { name: /^提需者/ }).click();
      }
      await expect(dialog.getByRole("heading", { name: "提需者", exact: true })).toBeVisible();
      await dialog.getByRole("checkbox", { name: "我提出的", exact: true }).check();
      await dialog.getByRole("button", { name: "返回筛选总览", exact: true }).click();
      await expect(dialog.getByRole("button", { name: /^提需者/ })).toContainText("我");
      // Moving between dimensions edits a draft; the URL remains unchanged.
      await expect(page).not.toHaveURL(/proposerKeys=/);
      await dialog.getByRole("button", { name: /^优先级/ }).click();
      await dialog.getByRole("checkbox", { name: "高", exact: true }).check();
      await dialog.getByRole("button", { name: "返回筛选总览", exact: true }).click();
      await expect(dialog.getByRole("button", { name: /^优先级/ })).toContainText("高");
      await page.screenshot({ path: test.info().outputPath("filter-overview.png") });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page).not.toHaveURL(/priorities=/);
      await bar.locator(".list-filter-more").click();
      await expect(dialog.getByRole("button", { name: /^优先级/ })).toContainText("不限");
      await dialog.getByRole("button", { name: /^创建时间/ }).click();
      await dialog.getByLabel("创建开始日期", { exact: true }).fill("2026-10-31");
      await dialog.getByLabel("创建结束日期", { exact: true }).fill("2026-10-30");
      await dialog.getByRole("button", { name: "返回筛选总览", exact: true }).click();
      await expect(dialog.getByRole("button", { name: /^Builder/ })).toBeFocused();
      await dialog.getByRole("button", { name: "应用筛选", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("开始日期不能晚于结束日期");
      await expect(page).not.toHaveURL(/createdFrom=/);
      await dialog.getByRole("button", { name: "清除此项", exact: true }).click();
      await dialog.getByRole("button", { name: "返回筛选总览", exact: true }).click();
      await dialog.getByRole("button", { name: /^提需者/ }).click();
      await dialog.getByRole("checkbox", { name: "我提出的", exact: true }).check();
      await dialog.getByRole("button", { name: "应用筛选", exact: true }).click();
      await expect(page).toHaveURL(/proposerKeys=/);
      const builder = bar.locator(".list-filter-builder");
      const more = bar.locator(".list-filter-more");
      expect(Math.abs((await builder.boundingBox())!.height - (await more.boundingBox())!.height)).toBeLessThanOrEqual(1);
      if (await proposer.isVisible()) {
        expect(Math.abs((await builder.boundingBox())!.height - (await proposer.boundingBox())!.height)).toBeLessThanOrEqual(1);
        expect((await proposer.boundingBox())!.x).toBeGreaterThan((await builder.boundingBox())!.x);
      }
      expect(await bar.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
      await page.screenshot({ path: test.info().outputPath("workspace.png") });
      await page.goto(`/?product=${fixture.productId}&console=agent`);
      const select = page.locator(".agent-console-agent-filter .single-select");
      const search = page.locator(".agent-console-search");
      await expect(select).toBeVisible();
      expect(Math.abs((await select.boundingBox())!.height - (await search.boundingBox())!.height)).toBeLessThanOrEqual(1);
      const switcher = page.locator(".product-switcher");
      const back = page.locator(".agent-console-topbar-back");
      expect(Math.abs((await switcher.boundingBox())!.height - (await back.boundingBox())!.height)).toBeLessThanOrEqual(1);
      if (width === 1440) await expect(page.locator(".agent-console-filters .web-version")).toHaveText(`Web v${version}`);
      await page.screenshot({ path: test.info().outputPath("agent-toolbar.png") });
    });
  });
}
