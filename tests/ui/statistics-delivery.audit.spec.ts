import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [1440,375]) {
  test.describe(`statistics delivery on ${width}`, () => {
    test.use({viewport:{width,height:900},hasTouch:width<1024,isMobile:width<1024});
    test("opens cycle and weekly delivery details without changing the report scope", async ({page}) => {
      // Full-suite runs can cross midnight after their delivery samples were seeded.
      await page.goto("/?statistics=1&statsPeriod=last7Days");
      await page.locator(".statistics-week").first().waitFor();
      await page.locator(".statistics-week").first().click();
      await expect(page).toHaveURL(/statsEndDay=/);
      await expect(page).toHaveURL(/statsPeriod=last7Days/);
      await expect(page.locator(".statistics-details h2")).toContainText("进入待验证");
      await page.reload();
      await expect(page.locator(".statistics-details h2")).toContainText("进入待验证");
      await page.getByRole("button",{name:/查看周期样本：开工至交付周期/}).click();
      await expect(page.locator(".statistics-details h2")).toHaveText("开工至交付周期");
      await expect(page.locator(".statistics-details")).toContainText("首次开工");
      await expect(page.locator(".statistics-details")).toContainText("首次交付");
      const audit=await page.evaluate(AUDIT_SOURCE) as {horizontalOverflow:number};
      expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
    });
    test("saves fixed batch membership, restores it on reload, and deletes only the batch", async ({page}) => {
      await page.goto("/?statistics=1&statsPeriod=last7Days");
      const batch=page.locator(".statistics-batches");
      await batch.getByRole("button",{name:"创建批次"}).click();
      await batch.getByLabel("批次名称").fill(`UI batch ${width}`);
      await expect(batch.locator(".statistics-batch-candidates input").first()).toBeVisible();
      await batch.locator(".statistics-batch-candidates input").nth(0).check();
      await batch.locator(".statistics-batch-candidates input").nth(1).check();
      await batch.locator(".statistics-batch-candidates input").nth(2).check();
      await batch.getByRole("button",{name:"保存固定批次"}).click();
      await expect(batch.locator(".statistics-batch-summary")).toContainText("原始 3");
      await expect(batch).toContainText("收到后 7 天交付率");
      await expect(batch).toContainText("收到后 14 天交付率");
      await page.reload();
      await expect(batch.locator(".statistics-batch-summary")).toContainText("原始 3");
      await batch.getByRole("button",{name:"已交付",exact:false}).filter({has:page.locator("strong")}).click();
      await expect(batch.locator(".statistics-batch-items")).toHaveAttribute("open", "");
      const audit=await page.evaluate(AUDIT_SOURCE) as {horizontalOverflow:number};
      expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
      await batch.getByRole("button",{name:"删除批次",exact:true}).click();
      await batch.getByRole("button",{name:"确认删除批次"}).click();
      await expect(batch.getByRole("button",{name:"返回批次列表",exact:true})).toHaveCount(0);
    });
  });
}
