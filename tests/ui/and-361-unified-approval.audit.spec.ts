import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8")) as { productId: string };
const id = "and-361-unified-approval";
const stamp = "2026-11-03T02:00:00.000Z";
const options = [
  { id: "accept", kind: "once" }, { id: "acceptForSession", kind: "session" },
  { id: "acceptAlways", kind: "always" },
  { id: "native-choice", kind: "choice", label: "Allow this application whenever it requests access", detail: "Remember access for this application only." },
  { id: "decline", kind: "decline" },
];
const permission = {
  id: "permission", kind: "manual", status: "pending", options,
  action: 'cua_repl: Allow Computer Use to use "Calculator"?\n' + "LongNativeRequest".repeat(24),
  reason: "请选择此次请求的授权范围；记住授权由来源工具处理。",
};
const session = {
  id, agentSessionId: id, dispatchId: "and-361-dispatch", agentKind: "codex", status: "idle",
  updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
  mode: "plan", dispatchStatus: "launched", createdAt: stamp, nodeId: "fixture-node", settings: {}, unread: false,
  items: [{ key: "AND-361", title: "统一权限请求", productId: fixture.productId }], activities: [],
  turnState: { turnActive: true, waitingForInput: true }, canReply: true, canRetry: false, canStop: true, canArchive: true,
  attention: { state: "needed", kind: "approval", reason: "请处理授权请求", revision: "attention" },
  needsAttention: true, waitingForReply: true,
  messages: [{ id: "message", sourceId: "message", role: "agent", text: "等待授权后继续。", occurredAt: stamp }],
  // Even a stale ready plan must never expose a second approval action.
  planApproval: { revision: "old-plan", reason: "批准方案" }, planApprovalStatus: { code: "ready" },
};
const url = `/?product=${fixture.productId}&console=agent&session=${id}`;

async function mockSession(page: Page, getDetail: () => Record<string, unknown>, onPost?: (path: string, body: unknown) => Promise<{ status?: number; json?: unknown }>) {
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      const result = await onPost?.(path, route.request().postDataJSON());
      return route.fulfill(result ?? { status: 204 });
    }
    const detail = getDetail();
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [detail] } : detail });
  });
}

test("one permission area replaces generic approval, submits the native scope once, then restores plan approval", async ({ page }) => {
  let current: Record<string, unknown> | undefined = permission;
  const decisions: unknown[] = [];
  const commands: unknown[] = [];
  await mockSession(page, () => ({ ...session, ...(current ? { approval: current } : {}) }), async (path, body) => {
    if (path.endsWith("/decision")) {
      decisions.push(body);
      current = { ...permission, decision: (body as { decision: string }).decision };
      return { json: { approval: current } };
    }
    if (path.endsWith("/commands")) commands.push(body);
    return { status: 204 };
  });
  await page.goto(url);
  const panel = page.locator(".agent-console-approval");
  await expect(page.locator(".agent-console-attention-banner")).toHaveCount(1);
  await expect(panel).toHaveClass(/agent-console-attention-banner/);
  await expect(panel.getByRole("button")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "无需处理", exact: true })).toHaveCount(0);
  await expect(panel.locator(".primary-button")).toHaveCount(1);
  await expect(panel.locator(".secondary-button")).toHaveCount(4);
  expect(decisions).toEqual([]);
  await panel.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator("details")).toHaveAttribute("open", "");
  await expect(panel.locator("details p")).toHaveText(permission.reason);
  await panel.getByRole("button", { name: "本会话内允许", exact: true }).dblclick();
  await expect(panel.getByRole("button").first()).toBeDisabled();
  await expect(panel).toContainText("决定已排队");
  expect(decisions).toEqual([{ decision: "acceptForSession" }]);
  expect(commands).toEqual([]);
  current = undefined;
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
});

test("failed permission delivery keeps the choices and lets the person retry", async ({ page }) => {
  let fail = true;
  let current: Record<string, unknown> = permission;
  const decisions: unknown[] = [];
  await mockSession(page, () => ({ ...session, approval: current }), async (path, body) => {
    if (!path.endsWith("/decision")) return { status: 204 };
    decisions.push(body);
    if (fail) return { status: 503, json: { error: "Service unavailable" } };
    current = { ...permission, decision: "acceptAlways" };
    return { json: { approval: current } };
  });
  await page.goto(url);
  const panel = page.locator(".agent-console-approval");
  const always = panel.getByRole("button", { name: "始终允许", exact: true });
  await always.click();
  await expect(page.getByLabel("会话操作反馈").locator(".inline-error")).toBeVisible();
  await expect(always).toBeEnabled();
  fail = false;
  await always.focus();
  await page.keyboard.press("Enter");
  await expect(always).toBeDisabled();
  await expect(panel).toContainText("决定已排队");
  expect(decisions).toEqual([{ decision: "acceptAlways" }, { decision: "acceptAlways" }]);
});

test("reconnecting permission retains the yellow area without stale choices or generic approval", async ({ page }) => {
  let current = { ...permission, status: "reconnecting" };
  await mockSession(page, () => ({ ...session, approval: current }));
  await page.goto(url);
  const panel = page.locator(".agent-console-approval");
  await expect(panel).toContainText("正在重新连接");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  current = { ...permission, id: "fresh-permission", status: "pending" };
  await expect(panel.getByRole("button")).toHaveCount(5, { timeout: 10_000 });
});

for (const viewport of [
  { name: "small-phone", width: 320, height: 568, touch: true },
  { name: "phone", width: 375, height: 812, touch: true },
  { name: "phone-landscape", width: 812, height: 375, touch: true },
  { name: "tablet", width: 768, height: 1024, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "laptop", width: 1280, height: 800, touch: false },
  { name: "desktop", width: 1440, height: 900, touch: false },
]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${viewport.name} ${theme}`, () => {
    test.use({ viewport, hasTouch: viewport.touch, colorScheme: theme });
    test("permission choices remain readable, aligned and reachable at every font scale", async ({ page }, testInfo) => {
      await mockSession(page, () => ({ ...session, approval: permission }));
      await page.goto(url);
      const panel = page.locator(".agent-console-approval");
      await expect(panel).toBeVisible();
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => {
          document.documentElement.dataset.fontScale = value;
          document.documentElement.dataset.consoleFontScale = value;
        }, scale);
        await expect(page.locator(".agent-console-attention-banner")).toHaveCount(1);
        const metrics = await panel.evaluate(element => {
          const card = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const controls = [...element.querySelectorAll("button, summary")];
          return {
            background: style.backgroundColor,
            overflowing: element.scrollWidth > element.clientWidth,
            controls: controls.map(control => {
              const rect = control.getBoundingClientRect();
              return { button: control.tagName === "BUTTON", y: rect.y, left: rect.left - card.left, right: card.right - rect.right, height: rect.height,
                font: parseFloat(getComputedStyle(control).fontSize), overflow: control.scrollWidth > control.clientWidth };
            }),
          };
        });
        expect(metrics.overflowing).toBe(false);
        expect(metrics.background).not.toBe("rgba(0, 0, 0, 0)");
        for (const control of metrics.controls) {
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeGreaterThanOrEqual(0);
          expect(control.font).toBeGreaterThanOrEqual(11);
          expect(control.height).toBeGreaterThanOrEqual(viewport.touch ? 44 : 32);
          expect(control.overflow).toBe(false);
        }
        const buttons = metrics.controls.filter(control => control.button);
        for (const button of buttons) for (const peer of buttons) {
          if (Math.abs(button.y - peer.y) < 1) expect(Math.abs(button.height - peer.height)).toBeLessThanOrEqual(1);
        }
        for (const button of await panel.getByRole("button").all()) {
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await panel.locator("summary").click();
      await expect(panel.locator("details p")).toBeVisible();
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await panel.locator("summary").click();
      await panel.locator("header").scrollIntoViewIfNeeded();
      const path = testInfo.outputPath("unified-permission.png");
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach("unified-permission", { path, contentType: "image/png" });
      if (viewport.width === 320 || viewport.height < 400) {
        await panel.getByRole("button").last().scrollIntoViewIfNeeded();
        const bottomPath = testInfo.outputPath("unified-permission-bottom.png");
        await page.screenshot({ path: bottomPath, animations: "disabled" });
        await testInfo.attach("unified-permission-bottom", { path: bottomPath, contentType: "image/png" });
      }
    });
  });
}
