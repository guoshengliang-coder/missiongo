import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { openConsoleSearch } from "./console-helpers";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const stamp = "2026-11-14T10:00:00.000Z";

async function data(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 6);
  const create = async (name: string, prefix: string) => {
    const response = await request.post("/api/v1/products", { data: { name: `${name} ${suffix}`, keyPrefix: `${prefix}${suffix}` } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<{ id: string; name: string }>;
  };
  const current = await create("当前长项目名称 Long project name", "PC");
  const other = await create("其他项目", "PO");
  const third = await create("共享项目", "PS");
  const base = { agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched",
    createdAt: stamp, updatedAt: stamp, activityAt: stamp, nodeName: "Fixture", nodeConnectionState: "online",
    nodeRevoked: false, items: [] as { key: string; title: string; productId: string }[], activities: [], settings: {},
    unread: false, needsAttention: false, attention: { state: "not_needed" }, canReply: true, canArchive: true };
  const session = (id: string, productId: string, values: object = {}) => ({ ...base, id, agentSessionId: id, productId, sessionName: id, ...values });
  const sessions = [
    session("current-pending", current.id, { needsAttention: true }),
    session("current-unread", current.id, { unread: true }),
    session("current-cross", current.id, { needsAttention: true, items: [{ key: "X-1", title: "共享", productId: other.id }] }),
    session("shared-other", other.id, { needsAttention: true, unread: true, items: [
      { key: "X-2", title: "共享", productId: third.id }, { key: "X-3", title: "重复项目", productId: third.id },
    ] }),
    session("other-pending", other.id, { needsAttention: true }),
    session("archived", other.id, { needsAttention: true, unread: true, archivedAt: stamp }),
    session("running", current.id, { unread: true, status: "active" }),
  ];
  return { current, other, third, sessions };
}

async function stream(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith("/api/v1/console/events")) return original(input, init);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
        send('event: hello\ndata: {"epoch":"and524","version":0}\n\n');
        (window as unknown as { projectCountsChanged: () => void }).projectCountsChanged = () => send(
          'id: and524:1\nevent: change\ndata: {"resources":[{"kind":"sessions","resourceId":"other-pending"}]}\n\n');
        init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
}

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(stamp)); });

test("project labels preserve shared-session rules, filtering and collapsed/non-console values", async ({ page, request }) => {
  const f = await data(request);
  await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: f.sessions } }));
  await page.goto(`/?product=${f.current.id}&console=agent`);
  const trigger = page.getByRole("combobox", { name: "当前产品", exact: true });
  await expect(trigger.locator(".agent-unread-badge")).toHaveText("1");
  await expect(trigger).not.toContainText("待处理");
  const hint = page.locator(".agent-console-other-projects");
  await expect(hint).toContainText("待我处理 2");
  await expect(hint).toContainText("未读会话 1");
  await trigger.click();
  for (const [product, attention, unread] of [[f.current, 2, 1], [f.other, 3, 1], [f.third, 1, 1]] as const) {
    const option = page.getByRole("option").filter({ hasText: product.name });
    await expect(option.locator(".product-switcher-count")).toHaveText([`待处理 ${attention}`, `未读 ${unread}`]);
  }
  // The fixture's original project has no synthetic sessions.
  await expect(page.locator(`[role=option][data-value="${fixture.productId}"] .product-switcher-count`)).toHaveText(["待处理 0", "未读 0"]);
  await expect(page.locator(`[role=option][data-value="${fixture.productId}"] .attention`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await openConsoleSearch(page);
  await page.locator(".agent-console-search input").fill("current-unread");
  await expect(page.locator(".agent-console-session")).toHaveCount(1);
  await trigger.click();
  await expect(page.getByRole("option").filter({ hasText: f.current.name })).toContainText("待处理 2");
  await page.keyboard.press("Escape");
  await expect(hint).toContainText("待我处理 2");
  await trigger.click();
  await page.getByRole("option").filter({ hasText: f.other.name }).click();
  await expect(trigger).toContainText(f.other.name);
  await expect(trigger.locator(".agent-unread-badge")).toHaveText("1");
  await page.locator(".agent-console-topbar-back").click();
  await trigger.click();
  await expect(page.locator(".product-switcher-counts")).toHaveCount(0);
});

test("unloaded counts are hidden and an event updates the open project menu", async ({ page, request }) => {
  const f = await data(request);
  await stream(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let waiting = true;
  await page.route("**/api/v1/agent-sessions**", async route => {
    if (waiting) await gate;
    await route.fulfill({ json: { sessions: f.sessions } });
  });
  await page.goto(`/?product=${f.current.id}&console=agent`);
  const trigger = page.getByRole("combobox", { name: "当前产品", exact: true });
  await trigger.click();
  try { await expect(page.locator(".product-switcher-counts")).toHaveCount(0); }
  finally { waiting = false; release(); }
  const option = page.getByRole("option").filter({ hasText: f.other.name });
  await expect(option).toContainText("待处理 3");
  f.sessions = f.sessions.map(session => session.id === "other-pending" ? { ...session, needsAttention: false, unread: true } : session);
  await page.evaluate(() => (window as unknown as { projectCountsChanged: () => void }).projectCountsChanged());
  await expect(option).toContainText("待处理 2");
  await expect(option).toContainText("未读 2");
  await expect(page.locator(".agent-console-other-projects")).toContainText("待我处理 1");
});

for (const width of [320, 375, 520, 521, 768, 1023, 1024, 1440]) for (const theme of ["light", "dark"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width <= 1023 });
    test("labelled counts fit long project names at every font scale", async ({ page, request }, info) => {
      const f = await data(request);
      f.sessions = Array.from({ length: 120 }, (_, index) => ({ ...f.sessions[0]!, id: `large-${index}`, agentSessionId: `large-${index}`, unread: true }));
      await page.route("**/api/v1/agent-sessions**", route => route.fulfill({ json: { sessions: f.sessions } }));
      await page.goto(`/?product=${f.current.id}&console=agent`);
      const trigger = page.getByRole("combobox", { name: "当前产品", exact: true });
      await expect(trigger.locator(".agent-unread-badge")).toHaveText(width <= 1023 ? "99+" : "120");
      await trigger.click();
      const option = page.getByRole("option").filter({ hasText: f.current.name });
      for (const scale of ["small", "medium", "large"]) {
        await page.evaluate(value => { document.documentElement.dataset.fontScale = value; }, scale);
        await option.scrollIntoViewIfNeeded();
        await expect(option.locator(".product-switcher-count")).toHaveText(["待处理 120", "未读 120"]);
        await expect(option).toHaveAccessibleName(/120 个未读/);
        await expect(async () => {
          const geometry = await option.evaluate(el => {
            const menu = el.closest("[role=listbox]")!;
            const r = menu.getBoundingClientRect();
            return { left: r.left, right: r.right, width: innerWidth, overflow: menu.scrollWidth > menu.clientWidth + 1,
              parts: [...el.querySelectorAll(".product-switcher-count,strong")].map(part => {
                const box = part.getBoundingClientRect();
                return { left: box.left, right: box.right, clipped: part.scrollWidth > part.clientWidth + 1 };
              }) };
          });
          expect(geometry.left).toBeGreaterThanOrEqual(7);
          expect(geometry.right).toBeLessThanOrEqual(geometry.width - 7);
          expect(geometry.overflow).toBe(false);
          for (const part of geometry.parts) {
            expect(part.left).toBeGreaterThanOrEqual(geometry.left);
            expect(part.right).toBeLessThanOrEqual(geometry.right);
            expect(part.clipped).toBe(false);
          }
        }).toPass();
      }
      await page.screenshot({ path: info.outputPath(`and524-${width}-${theme}.png`) });
      await page.goBack();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page).toHaveURL(/console=agent/);
    });
  });
}
