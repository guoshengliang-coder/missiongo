import { expect, test } from "@playwright/test";
import { AUDIT_SOURCE } from "./audit-page.mjs";

for (const width of [375, 1440])
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} unified filters`, () => {
      test.use({
        viewport: { width, height: 1000 },
        hasTouch: width === 375,
        isMobile: width === 375,
        colorScheme: theme,
      });
      test("applies combinations, cancels drafts, restores URLs and stays usable beside detail", async ({
        page,
        request,
      }) => {
        const suffix = `${width}${theme[0]}`;
        const product = await (
          await request.post("/api/v1/products", {
            data: {
              name: `Filters ${suffix}`,
              keyPrefix: `UF${suffix.toUpperCase()}`,
            },
          })
        ).json();
        const module = await (
          await request.post(`/api/v1/products/${product.id}/components`, {
            data: { name: "Frontend", kind: "web" },
          })
        ).json();
        for (const [type, priority, status, hasModule] of [
          ["bug", "high", "ready", true],
          ["requirement", "normal", "ready", false],
          ["task", "high", "ready", true],
          ["bug", "high", "inbox", true],
        ] as const) {
          const result = await request.post("/api/v1/items", {
            data: {
              productId: product.id,
              status,
              type,
              priority,
              title: `${type} ${status}`,
              description: "Synthetic filter fixture",
              environment: { platform: "web" },
              ...(hasModule ? { sourceComponentId: module.id } : {}),
            },
          });
          expect(result.status()).toBe(201);
        }
        await page.goto(`/?product=${product.id}`);
        await expect(page.locator(".item-row")).toHaveCount(3);
        const bar = page.locator(".list-filter-bar");
        expect((await bar.boundingBox())!.height).toBeLessThan(65);
        const more = bar.getByRole("button", { name: /更多筛选|^筛选/ });
        await more.click();
        const dialog = page.getByRole("dialog");
        const checkbox = async (name: string) => {
          const back = dialog.getByRole("button", { name: "返回筛选总览", exact: true });
          if (await back.isVisible()) await back.click();
          const dimension = name === "高" || name === "低" ? "优先级" : name === "我提出的" ? "提需者" : name === "Frontend" ? "模块" : "类型";
          await dialog.getByRole("button", { name: new RegExp(`^${dimension}`) }).click();
          return dialog.getByRole("checkbox", { name, exact: true });
        };
        await (await checkbox("高")).check();
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(page.locator(".item-row")).toHaveCount(3);
        await more.click();
        await expect(
          (await checkbox("高")),
        ).not.toBeChecked();
        await (await checkbox("高")).check();
        await (await checkbox("我提出的"))
          .check();
        await (await checkbox("Frontend"))
          .check();
        await (await checkbox("Bug"))
          .check();
        await (await checkbox("任务"))
          .check();
        await page.screenshot({
          path: test.info().outputPath("filter-dialog.png"),
        });
        expect(
          await dialog
            .locator(".list-filter-choices")
            .evaluateAll((nodes) =>
              nodes.some((node) => node.scrollWidth > node.clientWidth + 1),
            ),
        ).toBe(false);
        const audit = (await page.evaluate(AUDIT_SOURCE)) as {
          text: Array<{
            fontSize: number;
            fontWeight: number;
            contrast: number;
          }>;
        };
        expect(
          audit.text.filter((row) => row.fontSize > 0 && row.fontSize < 11),
        ).toEqual([]);
        expect(
          audit.text.filter(
            (row) =>
              row.contrast <
              (row.fontSize >= 24 ||
              (row.fontWeight >= 700 && row.fontSize >= 18.66)
                ? 3
                : 4.5),
          ),
        ).toEqual([]);
        await dialog
          .getByRole("button", { name: "应用筛选", exact: true })
          .click();
        await expect(page.locator(".item-row")).toHaveCount(2);
        await expect(page).toHaveURL(/priorities=/);
        expect((await bar.boundingBox())!.height).toBeLessThan(120);
        expect(
          await bar.evaluate((node) => node.scrollWidth > node.clientWidth),
        ).toBe(false);
        await page.reload();
        await expect(page.locator(".item-row")).toHaveCount(2);
        const savedFilters = page.url();
        const statusNav = page.locator(
          width === 375 ? ".mobile-status-nav" : ".sidebar",
        );
        await statusNav.getByRole("button", { name: /^草稿 / }).click();
        await expect(page.locator(".item-row")).toHaveCount(1);
        await expect(page).toHaveURL(/priorities=/);
        await bar
          .getByRole("button", { name: "清除筛选", exact: true })
          .click();
        await expect(page.locator(".item-row")).toHaveCount(1);
        await expect(page).toHaveURL(/status=inbox/);
        await page.goto(savedFilters);
        await expect(page.locator(".item-row")).toHaveCount(2);
        await more.click();
        await expect(
          (await checkbox("高")),
        ).toBeChecked();
        await dialog
          .getByRole("button", { name: "重置条件", exact: true })
          .click();
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(page.locator(".item-row")).toHaveCount(2);
        if (width === 1440) {
          await page.locator(".item-row-main").first().click();
          await expect(page.locator(".workspace")).toHaveClass(/detail-open/);
          await expect(more).toBeVisible();
          await page.locator(".list-page").evaluate((node) => {
            (node as HTMLElement).style.width = "260px";
          });
          await expect(
            bar.getByRole("button", { name: /^筛选/ }),
          ).toBeVisible();
          await bar.getByRole("button", { name: /^筛选/ }).click();
          await expect(dialog).toBeVisible();
          await dialog
            .getByRole("button", { name: "取消", exact: true })
            .click();
          await page
            .locator(".list-page")
            .evaluate((node) =>
              (node as HTMLElement).style.removeProperty("width"),
            );
        }
        await page.screenshot({
          path: test.info().outputPath("filtered-list.png"),
        });
        await bar
          .getByRole("button", { name: "清除筛选", exact: true })
          .click();
        await expect(page.locator(".item-row")).toHaveCount(3);
        await expect(page).not.toHaveURL(/priorities=/);
        await more.click();
        await (await checkbox("低")).check();
        await dialog
          .getByRole("button", { name: "应用筛选", exact: true })
          .click();
        await expect(page.locator(".item-row")).toHaveCount(0);
        await expect(
          page
            .locator(".empty-list")
            .getByRole("button", { name: "清除筛选", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".empty-list")).not.toContainText("记录第一");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
      });
    });
  }
