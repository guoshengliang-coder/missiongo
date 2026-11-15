import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

for (const transition of ["editor", "picker", "settings", "menu"]) test(`account clear cancels a queued ${transition} transition`, async ({ page }) => {
 const errors: string[] = [];
 page.on("pageerror", error => errors.push(error.message));
 const harness = fileURLToPath(new URL("./command-lifecycle-harness.tsx", import.meta.url));
 await page.route("**/__command-lifecycle", route => route.fulfill({ contentType: "text/html", body:
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="command-audit-root"></div><script type="module" src="/@fs/${harness}"></script>` }));
 await page.route("**/api/v1/common-commands", route => route.fulfill({ json: { revision: 1, commands: [] } }));
 await page.goto("/__command-lifecycle");
 const picker = page.locator(".common-command-picker");
 if (transition === "menu") await page.locator(".common-command-add summary").click();
 else {
  await page.getByRole("button", { name: "打开指令", exact: true }).click();
  await expect(picker).toBeVisible();
 }
 if (transition === "picker") {
  await picker.getByRole("button", { name: "新建指令", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "指令内容", exact: true })).toBeFocused();
 }
 const instanceId = await page.evaluate(() => { window.commandAudit.hold(); return window.commandAudit.instanceId; });
 if (transition === "editor") await picker.getByRole("button", { name: "新建指令", exact: true }).click();
 else if (transition === "settings") await picker.getByRole("button", { name: "管理指令", exact: true }).click();
 else if (transition === "menu") await page.getByRole("button", { name: "常用指令", exact: true }).click();
 else await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
 await expect(page.getByRole("dialog")).toHaveCount(0);
 expect(await page.evaluate(() => window.commandAudit.instanceId)).toBe(instanceId);
 await page.evaluate(() => window.commandAudit.clear());
 await page.evaluate(() => window.commandAudit.release());
 // Let history retirement and the queued React commit finish before checking.
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 await expect(page.getByRole("dialog")).toHaveCount(0);
 expect(await page.evaluate(() => window.commandAudit.instanceId)).toBe(instanceId);
 expect(await page.evaluate(() => window.commandAudit.settingsVisits())).toBe(0);
 await expect(page.getByRole("textbox", { name: "草稿", exact: true })).toHaveValue("已有草稿");
 // Cancellation is scoped to the old account, not a permanent disabled picker.
 await page.getByRole("button", { name: "打开指令", exact: true }).click();
 await expect(picker).toBeVisible();
 await expect(picker.getByRole("textbox", { name: "搜索指令内容" })).not.toBeFocused();
 expect(errors).toEqual([]);
});
