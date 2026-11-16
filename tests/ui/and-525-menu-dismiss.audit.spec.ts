import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };

for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) test.describe(`${width} ${theme} menu dismissal`, () => {
  test.use({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, colorScheme: theme });
  test("add menu closes outside without stealing focus, losing drafts or sending", async ({ page }) => {
    const stamp = "2026-11-14T12:00:00Z", id = "dismiss-menu";
    await page.clock.setFixedTime(new Date("2026-11-14T13:00:00Z"));
    const session = { id, agentSessionId: id, dispatchId: id, productId: fixture.productId, agentKind: "codex", status: "idle", dispatchStatus: "launched",
      sessionName: "菜单关闭", nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "auto", createdAt: stamp, updatedAt: stamp, activityAt: stamp,
      items: [], canReply: true, canAttach: true, canRetry: false, canStop: false, canArchive: true, unread: false, settings: { adjustable: false },
      attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, activities: [], turnState: { turnActive: false } };
    let writes = 0;
    await page.route("**/api/v1/agent-sessions**", route => {
      if (route.request().method() !== "GET") { writes++; return route.fulfill({ status: 204 }); }
      return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/v1/agent-sessions" ? { sessions: [session] } : { ...session, messages: [] } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const draft = page.locator(".agent-console-reply textarea"), menu = page.locator(".common-command-add"), trigger = menu.locator("summary");
    await draft.fill("保留这份草稿");
    const url = page.url(), depth = () => page.evaluate(() => (history.state?.["missiongo:dialogs"] ?? []).length);
    const base = await depth();
    for (const close of ["outside", "trigger", "escape", "back", ...(width === 390 ? ["pageBack"] : []), "outside"]) {
      await trigger.click();
      await expect(menu).toHaveAttribute("open");
      await expect.poll(depth).toBe(base + 1);
      // Blank space inside the menu is not an outside click.
      await menu.locator(".detail-more-menu-popover").click({ position: { x: 2, y: 2 } });
      await expect(menu).toHaveAttribute("open");
      if (close === "outside") {
        if (width === 390) await draft.tap({ position: { x: 8, y: 8 } }); else await draft.click({ position: { x: 8, y: 8 } });
        await expect(draft).toBeFocused();
      } else if (close === "trigger") await trigger.click();
      else if (close === "escape") await page.keyboard.press("Escape");
      else if (close === "pageBack") await page.locator(".agent-console-conversation-back").click();
      else await page.evaluate(() => history.back());
      await expect(menu).not.toHaveAttribute("open");
      await expect.poll(depth).toBe(base);
      if (close === "escape" || close === "back" || close === "pageBack") await expect(trigger).toBeFocused();
      await expect(draft).toHaveValue("保留这份草稿");
      await expect(page).toHaveURL(url);
    }
    // The inside action still lands once and its modal returns to the trigger.
    await trigger.click();
    await menu.getByRole("button", { name: "常用指令", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect.poll(depth).toBe(base);
    await expect(draft).toHaveValue("保留这份草稿");
    expect(writes).toBe(0);
  });
});
