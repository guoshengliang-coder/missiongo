import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { refreshFromConsoleStream } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-13T12:00:00.000Z";
const target = "and-516-target";
function summary(id = target) {
  return { id, agentSessionId: id, dispatchId: `dispatch-${id}`, agentKind: "codex", status: "idle",
    updatedAt: stamp, activityAt: stamp, createdAt: stamp, nodeName: "Fixture", nodeId: "fixture-node",
    nodeConnectionState: "online", nodeRevoked: false, mode: "auto", dispatchStatus: "launched",
    items: [{ key: fixture.detailKey, title: id, productId: fixture.productId }],
    activities: [], settings: {}, unread: false, canReply: true, canRetry: false, canStop: false,
    canArchive: true, attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
}
const detail = (id = target) => ({ ...summary(id), canResolveDelivery: false,
  messages: [{ id: `message-${id}`, role: "agent", text: `Transcript ${id}`, occurredAt: stamp }] });
const url = (id = target) => `/?product=${fixture.productId}&item=${fixture.detailKey}&console=agent&session=${id}`;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function mock(page: Page, list: () => Promise<unknown> | unknown,
  read: (id: string) => Promise<{ status?: number; json?: unknown }> | { status?: number; json?: unknown }) {
  let writes = 0;
  await page.route("**/api/v1/agent-sessions**", async route => {
    const request = route.request();
    if (request.method() !== "GET") { writes++; return route.fulfill({ status: 204 }); }
    const path = new URL(request.url()).pathname;
    return route.fulfill(path === "/api/v1/agent-sessions" ? { json: await list() }
      : await read(decodeURIComponent(path.split("/").at(-1)!)));
  });
  return () => writes;
}
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(stamp)); });

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) test.describe(`${width} ${theme}`, () => {
  test.use({ viewport: { width, height: width === 320 ? 568 : 900 }, hasTouch: width === 320, colorScheme: theme });
  test("a delayed list restores the target without clearing its route or flashing unavailable", async ({ page }, info) => {
    const wait = gate(); let lists = 0, reads = 0;
    const writes = await mock(page, async () => {
      if (++lists === 1) return { sessions: [] };
      await wait.promise; return { sessions: [summary()] };
    }, () => { reads++; return { json: detail() }; });
    await page.goto(url());
    const pane = page.locator(".agent-console-conversation");
    await expect(pane.getByRole("status")).toContainText("正在读取对话");
    await expect(page).toHaveURL(/session=and-516-target/);
    await expect(page.getByRole("alert").filter({ hasText: "该会话已失效" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("recovering.png") });
    wait.release();
    await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
    expect(lists).toBe(2); expect(reads).toBe(1); expect(writes()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test("a fresh list arriving during an obsolete probe cannot be undone by its late denial", async ({ page }) => {
  const wait = gate(); let synced = false, reads = 0;
  await mock(page, () => ({ sessions: synced ? [summary()] : [] }), async () => {
    if (++reads > 1) return { json: detail() };
    await wait.promise; return { status: 404, json: { code: "not_found" } };
  });
  await page.goto(url()); await expect.poll(() => reads).toBe(1);
  synced = true; await refreshFromConsoleStream(page);
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
  wait.release();
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "该会话已失效" })).toHaveCount(0);
});

for (const width of [320, 1440]) test.describe(`item-origin ${width}`, () => {
 test.use({ viewport: { width, height: 812 }, hasTouch: width === 320 });
 test("unavailable target can return directly to its item", async ({ page }, info) => {
  await mock(page, () => ({ sessions: [] }), () => ({ status: 404, json: { code: "not_found" } }));
  await page.route(`**/api/v1/items/${fixture.detailKey}/dispatches`, route => route.fulfill({ json: { dispatches: [{
    id: "dispatch-target", agentSessionId: target, agentKind: "codex", nodeName: "Fixture", mode: "auto",
    status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey],
  }] } }));
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  const jump = page.locator(".detail-dispatch-line").getByRole("button", { name: "在控制台查看", exact: true });
  await jump.click();
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toContainText("该会话已失效");
  const back = pane.getByRole("button", { name: "返回条目详情", exact: true });
  await expect(back).toBeInViewport();
  const retry = pane.getByRole("button", { name: "重试", exact: true });
  await expect(retry).toBeInViewport();
  if (width === 320) {
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath("unavailable.png") });
  await back.click(); await expect(jump).toBeVisible(); await expect(jump).toBeFocused();
  await expect(page).not.toHaveURL(/console=agent/);
});
});

test("an accessible detail with no summary offers bounded retry, then opens the synced row", async ({ page }) => {
  let synced = false, reads = 0, lists = 0;
  await mock(page, () => { lists++; return { sessions: synced ? [summary()] : [] }; }, () => { reads++; return { json: detail() }; });
  await page.goto(url());
  const pane = page.locator(".agent-console-conversation");
  await expect(pane).toContainText("会话可以访问，但列表尚未同步");
  expect(reads).toBe(1); expect(lists).toBe(3);
  await expect(page).toHaveURL(/session=and-516-target/);
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  synced = true;
  await pane.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
  await expect(pane).not.toContainText("列表尚未同步");
});

test("a failed initial list retains the deep link and retries it", async ({ page }) => {
  let fail = true;
  await page.route(/\/api\/v1\/agent-sessions$/, route => route.fulfill(fail
    ? { status: 503, json: { code: "service_unavailable" } } : { json: { sessions: [summary()] } }));
  await page.route(`**/api/v1/agent-sessions/${target}?*`, route => route.fulfill({ json: detail() }));
  await page.goto(url());
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toBeVisible(); await expect(page).toHaveURL(/session=and-516-target/);
  fail = false; await pane.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
});

test("a temporary detail failure retains the target and recovers after retry", async ({ page }) => {
  let fail = true;
  await mock(page, () => ({ sessions: [] }), () => fail
    ? { status: 503, json: { code: "service_unavailable" } } : { json: detail() });
  await page.goto(url());
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toBeVisible(); await expect(pane).not.toContainText("该会话已失效");
  await expect(page).toHaveURL(/session=and-516-target/);
  fail = false; await pane.getByRole("button", { name: "重试", exact: true }).click();
  await expect(pane).toContainText("会话可以访问，但列表尚未同步");
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("late identity mapping canonicalizes only the current target", async ({ page }) => {
  let lists = 0;
  await mock(page, () => ({ sessions: ++lists < 3 ? [] : [{ ...summary(), relatedSessionIds: [target, "legacy-id"] }] }),
    () => ({ json: detail("legacy-id") }));
  await page.goto(url("legacy-id"));
  await expect(page).toHaveURL(/session=and-516-target/);
  await expect(page.locator(".agent-console-message")).toBeVisible();
});

test("a list row arriving after a denied probe cannot restore controls before detail access succeeds", async ({ page }) => {
  const wait = gate(); let synced = false, reads = 0;
  await mock(page, () => ({ sessions: synced ? [summary()] : [] }), async () => {
    if (++reads === 1) return { status: 403, json: { code: "forbidden" } };
    await wait.promise; return { json: detail() };
  });
  await page.goto(url());
  await expect(page.locator(".agent-console-conversation").getByRole("alert")).toBeVisible();
  synced = true; await refreshFromConsoleStream(page);
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  wait.release();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
});

test("late failure from an abandoned recovery cannot disturb another conversation or its draft", async ({ page }) => {
  const wait = gate(); let entered = false; const other = "and-516-other";
  await mock(page, () => ({ sessions: [summary(other)] }), async id => {
    if (id !== target) return { json: detail(other) };
    entered = true; await wait.promise; return { status: 404, json: { code: "not_found" } };
  });
  await page.goto(url()); await expect.poll(() => entered).toBe(true);
  await page.locator(".agent-console-session").click();
  const input = page.locator(".agent-console-reply textarea"); await input.fill("Keep the new draft");
  wait.release();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${other}`);
  await expect(input).toHaveValue("Keep the new draft"); await expect(page).toHaveURL(/session=and-516-other/);
  await expect(page.getByRole("alert").filter({ hasText: "该会话已失效" })).toHaveCount(0);
});

for (const status of [401, 403, 404]) test(`confirmed ${status} hides cached content and controls, then can retry`, async ({ page }) => {
  let denied = false, retrying = false;
  const wait = gate();
  await mock(page, () => ({ sessions: [summary()] }), async () => {
    if (denied) return { status, json: { code: status === 404 ? "not_found" : status === 403 ? "forbidden" : "unauthorized" } };
    if (retrying) await wait.promise;
    return { json: detail() };
  });
  await page.goto(url());
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
  await page.locator(".agent-console-reply textarea").fill("Retain this draft");
  denied = true; await refreshFromConsoleStream(page);
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toBeVisible();
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  await expect(page).toHaveURL(/session=and-516-target/);
  denied = false; retrying = true;
  await pane.getByRole("button", { name: "重试", exact: true }).click();
  await expect(pane.getByRole("button", { name: "重试", exact: true })).toBeDisabled();
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  wait.release();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
  await expect(page.locator(".agent-console-reply textarea")).toHaveValue("Retain this draft");
});

test("confirmed missing target stays retryable and returning to the list clears its feedback", async ({ page }) => {
  await mock(page, () => ({ sessions: [] }), () => ({ status: 404, json: { code: "not_found" } }));
  await page.goto(url());
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toContainText("该会话已失效");
  await pane.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await expect(page).not.toHaveURL(/session=/); await expect(pane).toContainText("选择一个会话后");
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("another conversation's successful read cannot unlock a denied target on return", async ({ page }) => {
  const other = "and-516-other", wait = gate();
  let phase: "ready" | "denied" | "retrying" = "ready";
  await mock(page, () => ({ sessions: [summary(), summary(other)] }), async id => {
    if (id === other) return { json: detail(other) };
    if (phase === "denied") return { status: 403, json: { code: "forbidden" } };
    if (phase === "retrying") await wait.promise;
    return { json: detail() };
  });
  await page.goto(url());
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
  phase = "denied"; await refreshFromConsoleStream(page);
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toBeVisible();
  await page.locator(".agent-console-session").filter({ hasText: other }).click();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${other}`);
  phase = "retrying";
  await page.locator(".agent-console-session").filter({ hasText: target }).click();
  await expect(pane.getByRole("alert")).toBeVisible();
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "归档", exact: true })).toHaveCount(0);
  wait.release();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
});

test("denial survives canonical mapping and a 503 retry before a successful detail check", async ({ page }) => {
  const legacy = "and-516-legacy", wait = gate();
  let mapped = false, successful = false, failures = 0;
  await mock(page, () => ({ sessions: mapped ? [{ ...summary(), relatedSessionIds: [legacy, target] }] : [] }), async id => {
    if (id === legacy) return { status: 403, json: { code: "forbidden" } };
    if (!successful) { failures++; return { status: 503, json: { code: "unavailable" } }; }
    await wait.promise; return { json: detail() };
  });
  await page.goto(url(legacy));
  const pane = page.locator(".agent-console-conversation");
  await expect(pane.getByRole("alert")).toBeVisible();
  mapped = true; await refreshFromConsoleStream(page);
  await expect(page).toHaveURL(/session=and-516-target/);
  await expect.poll(() => failures).toBeGreaterThan(1);
  await expect(pane.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
  await expect(page.locator(".agent-console-message, .agent-console-reply textarea")).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "归档", exact: true })).toHaveCount(0);
  successful = true; await pane.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".agent-console-reply textarea")).toHaveCount(0);
  wait.release();
  await expect(page.locator(".agent-console-message")).toContainText(`Transcript ${target}`);
});
