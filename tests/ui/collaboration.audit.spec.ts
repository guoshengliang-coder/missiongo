import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { chooseOption } from "./select-helpers";
import { postItemCommand } from "./item-command";
import { AUDIT_SOURCE } from "./audit-page.mjs";
async function json(request: APIRequestContext, url: string, data: unknown) {
  const r = await request.post(url, { data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function openRelation(panel: Locator, key: string) {
  await panel.getByRole("button", { name: "展开", exact: true }).click();
  await panel.locator(".collaboration-record > summary").filter({ hasText: key }).click();
  await panel.getByRole("button", { name: new RegExp(key) }).click();
}
for (const width of [375, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`collaboration approval and source acceptance ${width} ${theme}`, async ({
      page,
      request,
      browser,
    }) => {
      await page.setViewportSize({ width, height: 950 });
      await page.emulateMedia({ colorScheme: theme });
      const suffix = `${width}${theme}`,
        password = randomUUID();
      const source = await json(request, "/api/v1/products", {
        name: `Application ${suffix}`,
        keyPrefix: `CA${width}${theme[0]!.toUpperCase()}`,
      });
      const target = await json(request, "/api/v1/products", {
        name: `Engine ${suffix}`,
        keyPrefix: `CE${width}${theme[0]!.toUpperCase()}`,
      });
      const sender = await json(request, "/api/v1/accounts", {
        email: `sender-${suffix}@example.test`,
        password,
        role: "member",
      });
      const receiver = await json(request, "/api/v1/accounts", {
        email: `receiver-${suffix}@example.test`,
        password,
        role: "member",
      });
      for (const [account, product] of [
        [sender, source],
        [receiver, target],
      ])
        expect(
          (
            await request.put(`/api/v1/accounts/${account.id}/products`, {
              data: {
                permissions: [
                  {
                    productId: product.id,
                    canView: true,
                    canOperate: true,
                    canUseAi: true,
                  },
                ],
              },
            })
          ).ok(),
        ).toBe(true);
      const original = await json(request, "/api/v1/items", {
        productId: source.id,
        title: "Retry issue",
        description: "Private source context",
        type: "bug",
        priority: "normal",
        status: "ready",
        environment: { platform: "web" },
        builderAccountId: sender.id,
      });
      await page.goto(
        `/settings/products/${target.id}/collaboration?product=${target.id}`,
      );
      await page
        .getByRole("button", { name: "添加接收权限", exact: true })
        .click();
      let dialog = page.getByRole("dialog");
      await chooseOption(
        dialog.getByRole("combobox", { name: "来源项目", exact: true }),
        source.id,
      );
      await chooseOption(
        dialog.getByRole("combobox", { name: "默认接单 Builder", exact: true }),
        receiver.id,
      );
      await dialog.getByRole("button", { name: "确认", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("configuration.png"),
        fullPage: true,
      });
      const baseURL = new URL(page.url()).origin;
      const sourceContext = await browser.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
        viewport: { width, height: 950 },
        colorScheme: theme,
        isMobile: width === 375,
        hasTouch: width === 375,
      });
      const targetContext = await browser.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
        viewport: { width, height: 950 },
        colorScheme: theme,
      });
      try {
        for (const [ctx, account] of [
          [sourceContext, sender],
          [targetContext, receiver],
        ] as const)
          await json(ctx.request, "/api/v1/auth/login", {
            username: account.email,
            password,
          });
        const sourcePage = await sourceContext.newPage();
        await sourcePage.goto(`/?product=${source.id}&item=${original.key}`);
        const section = sourcePage.getByRole("region", {
          name: "协作与依赖",
          exact: true,
        });
        await section.locator(".collaboration-add-menu > summary").click();
        await section
          .getByRole("button", { name: "发起协作请求", exact: true })
          .click();
        dialog = sourcePage.getByRole("dialog");
        const grants = await (
          await sourceContext.request.get(
            `/api/v1/items/${original.key}/collaboration/targets`,
          )
        ).json();
        await chooseOption(
          dialog.getByRole("combobox", {
            name: "目标项目 / 接收模块",
            exact: true,
          }),
          grants.targets[0].id,
        );
        await dialog
          .getByPlaceholder("请输入清晰、具体的标题")
          .fill("Support idempotent retries");
        await chooseOption(
          dialog.getByRole("combobox", { name: "所属平台必填", exact: true }),
          "web",
        );
        await dialog
          .getByPlaceholder("请说明实际发生了什么，以及异常表现是什么。", { exact: true })
          .fill("Approved public reproduction");
        await dialog
          .getByLabel("交付要求与验收条件", { exact: true })
          .fill("Repeated request returns exactly once");
        // AND-406: the request picks up the same file capability as any other
        // creation; the material is saved with the target item.
        await dialog
          .locator('input[type="file"][accept*=".txt"]')
          .setInputFiles({
            name: "collaboration-evidence.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("request evidence"),
          });
        await expect(dialog.getByText("collaboration-evidence.txt")).toBeVisible();
        await dialog
          .getByRole("button", { name: "预览并确认", exact: true })
          .click();
        await expect(
          dialog.getByRole("button", { name: "批准并提交", exact: true }),
        ).toBeDisabled();
        expect(
          (
            await (
              await sourceContext.request.get(
                `/api/v1/items/${original.key}/collaboration`,
              )
            ).json()
          ).blocked,
        ).toBe(false);
        await sourcePage.screenshot({
          path: test.info().outputPath("human-approval.png"),
        });
        await dialog.getByRole("checkbox").check();
        await dialog
          .getByRole("button", { name: "批准并提交", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await expect(
          section.getByText(
            "依赖未结束，暂不能推进交付；可以继续独立开发与联调。",
            { exact: true },
          ),
        ).toBeVisible();
        const relation = (
          await (
            await sourceContext.request.get(
              `/api/v1/items/${original.key}/collaboration`,
            )
          ).json()
        ).requests[0];
        expect(
          (
            await sourceContext.request.get(
              `/api/v1/items/${relation.targetKey}`,
            )
          ).status(),
        ).toBe(404);
        const uploaded = await (
          await targetContext.request.get(
            `/api/v1/items/${relation.targetKey}/attachments`,
          )
        ).json();
        expect(
          uploaded.attachments.map((attachment: { filename: string }) => attachment.filename),
        ).toContain("collaboration-evidence.txt");
        const targetPage = await targetContext.newPage();
        await targetPage.goto(
          `/?product=${target.id}&item=${relation.targetKey}`,
        );
        const receiving = targetPage.getByRole("region", {
          name: "协作与依赖",
          exact: true,
        });
        await openRelation(receiving, original.key);
        const targetDialog = targetPage.getByRole("dialog");
        await expect(targetDialog).not.toContainText("Private source context");
        await targetDialog
          .getByRole("button", { name: "发送共享评论", exact: true })
          .click();
        await targetDialog
          .getByLabel("说明 / 处理结果", { exact: true })
          .fill(
            "Engine v2.1 delivered; tested repeated request against staging.",
          );
        await targetDialog
          .getByLabel("这是接收方的交付说明", { exact: true })
          .check();
        await targetDialog
          .getByRole("button", { name: "确认", exact: true })
          .click();
        await expect(
          targetDialog.getByText(
            "Engine v2.1 delivered; tested repeated request against staging.",
            { exact: true },
          ),
        ).toBeVisible();
        const moved = await postItemCommand(
          request,
          `/api/v1/items/${relation.targetKey}/transitions`,
          {
            data: {
              to: "pending_verification",
              reason: "manual_override",
              note: "Published fixture delivery",
            },
          },
        );
        expect(moved.ok(), await moved.text()).toBe(true);
        await sourcePage.reload();
        await openRelation(section, relation.targetKey);
        dialog = sourcePage.getByRole("dialog");
        await dialog
          .getByRole("button", { name: "验收协作结果", exact: true })
          .click();
        await dialog
          .getByLabel("说明 / 处理结果", { exact: true })
          .fill("Verified retries; request satisfied.");
        await expect(
          dialog.getByRole("button", { name: "验收通过", exact: true }),
        ).toBeDisabled();
        await dialog
          .getByLabel("我已验证交付结果，确认符合本次请求与验收条件。", {
            exact: true,
          })
          .check();
        expect(
          await sourcePage.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        const audit = (await sourcePage.evaluate(AUDIT_SOURCE)) as {
          text: Array<{
            fontSize: number;
            fontWeight: number;
            contrast: number;
          }>;
        };
        expect(
          audit.text.filter((r) => r.fontSize > 0 && r.fontSize < 11),
        ).toEqual([]);
        expect(
          audit.text.filter(
            (r) =>
              r.contrast <
              (r.fontSize >= 24 || (r.fontWeight >= 700 && r.fontSize >= 18.66)
                ? 3
                : 4.5),
          ),
        ).toEqual([]);
        await sourcePage.screenshot({
          path: test.info().outputPath("source-verification.png"),
        });
        await dialog
          .getByRole("button", { name: "验收通过", exact: true })
          .click();
        await expect(
          dialog.getByText("依赖已有结论，由原 Builder 决定下一步。", {
            exact: true,
          }),
        ).toBeVisible();
        expect(
          (
            await (
              await sourceContext.request.get(`/api/v1/items/${original.key}`)
            ).json()
          ).status,
        ).toBe("ready");
        expect(
          (
            await (
              await sourceContext.request.get(
                `/api/v1/items/${original.key}/collaboration`,
              )
            ).json()
          ).blocked,
        ).toBe(false);
        await sourcePage.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);

        // AND-406: the receiving side opens the linked source item read-only.
        await targetPage.reload();
        const receivingAgain = targetPage.getByRole("region", {
          name: "协作与依赖",
          exact: true,
        });
        await openRelation(receivingAgain, original.key);
        await targetPage
          .getByRole("dialog")
          .getByRole("button", { name: "查看原条目", exact: true })
          .click();
        const readOnlyDetail = targetPage.locator(".detail-pane");
        await expect(readOnlyDetail).toContainText("Retry issue");
        await expect(readOnlyDetail).toContainText("Private source context");
        await expect(readOnlyDetail).toContainText("协作只读内容");
        await expect(
          readOnlyDetail.getByRole("button", { name: "编辑", exact: true }),
        ).toHaveCount(0);
        await expect(
          readOnlyDetail.getByRole("textbox"),
        ).toHaveCount(0);
        await targetPage.screenshot({
          path: test.info().outputPath("source-read-only.png"),
        });
      } finally {
        await sourceContext.close();
        await targetContext.close();
      }
    });
  }

test("cancel source explicitly withdraws dependencies without cancelling receiver; dirty drafts survive close", async ({
  page,
  request,
}) => {
  const source = await json(request, "/api/v1/products", {
    name: "Cancellation source",
    keyPrefix: "CCS",
  });
  const target = await json(request, "/api/v1/products", {
    name: "Cancellation receiver",
    keyPrefix: "CCR",
  });
  const response = await request.put(
    `/api/v1/products/${target.id}/collaboration`,
    { data: { sourceProductId: source.id, expectedRevision: 0 } },
  );
  expect(response.ok()).toBe(true);
  const grant = await response.json();
  const item = await json(request, "/api/v1/items", {
    productId: source.id,
    title: "Cancel source",
    description: "Source",
    type: "requirement",
    priority: "normal",
    status: "ready",
    environment: { platform: "web" },
  });
  await page.goto(`/?product=${source.id}&item=${item.key}`);
  await page.locator(".collaboration-add-menu > summary").click();
  await page
    .getByRole("region", { name: "协作与依赖", exact: true })
    .getByRole("button", { name: "发起协作请求", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("请输入清晰、具体的标题").fill("Unsaved draft");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "放弃修改？", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(dialog.getByPlaceholder("请输入清晰、具体的标题")).toHaveValue(
    "Unsaved draft",
  );
  await page.reload();
  const draft = await json(
    request,
    `/api/v1/items/${item.key}/collaboration/drafts`,
    {
      grantId: grant.id,
      title: "Existing approved collaboration",
      description: "Shared reproduction",
      acceptance: "Shared criteria",
      idempotencyKey: randomUUID(),
    },
  );
  const relation = await json(
    request,
    `/api/v1/collaboration/drafts/${draft.id}/submit`,
    { version: draft.version, approved: true, idempotencyKey: randomUUID() },
  );
  const detail = await (
    await request.get(`/api/v1/collaboration/${relation.id}`)
  ).json();
  await page.reload();
  await page.locator(".detail-toolbar .detail-more-menu > summary").click();
  await page.locator(".detail-toolbar .detail-more-menu button.danger").click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("取消前请处置未完成协作。撤回依赖不会取消接收方条目。", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.locator("textarea").first().fill("We resolved this locally");
  await expect(
    dialog.getByRole("combobox", { name: "协作与依赖", exact: true }),
  ).toContainText("撤回未完成的协作请求");
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await (await request.get(`/api/v1/items/${item.key}`)).json()).status,
  ).toBe("cancelled");
  expect(
    (await (await request.get(`/api/v1/items/${detail.targetKey}`)).json())
      .status,
  ).toBe("ready");
  expect(
    (
      await (
        await request.get(`/api/v1/items/${item.key}/collaboration`)
      ).json()
    ).blocked,
  ).toBe(false);
});
