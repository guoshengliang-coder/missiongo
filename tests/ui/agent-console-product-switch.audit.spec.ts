import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/**
 * A manual product pick in the agent console stays picked (AND-263).
 *
 * The console used to realign the selected product to the open session's
 * product on every agent-session refetch -- every 5 seconds while the console
 * is open -- so a manual pick bounced back within seconds. The fixture has no
 * agent sessions, so the session reads are answered from this file, and a
 * second product is created before the page loads so the switcher has
 * somewhere to switch to. Everything else -- the switcher, the console, the
 * realignment effect -- is the real thing.
 */

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./.auth/fixture.json", import.meta.url)), "utf8"),
) as { productId: string };

const SESSION_ID = "and-263-ui-fixture";
const CONSOLE_URL = `/?product=${fixture.productId}&console=agent&session=${SESSION_ID}`;
const now = "2026-09-30T03:00:00.000Z";

const summary = {
  id: SESSION_ID,
  agentSessionId: SESSION_ID,
  dispatchId: "dispatch-and-263",
  agentKind: "opencode",
  status: "active",
  updatedAt: now,
  activityAt: now,
  nodeName: "fixture-node",
  nodeConnectionState: "online",
  nodeRevoked: false,
  mode: "bypass",
  dispatchStatus: "in_progress",
  createdAt: now,
  // The session belongs to the fixture product, so opening it selects that
  // product and the realignment under test has a product to bounce back to.
  items: [{ key: "AND-263", title: "控制台项目切换失败", productId: fixture.productId }],
  activities: [],
  canReply: true,
  attention: { state: "not_needed" },
  needsAttention: false,
  waitingForReply: false,
  canRetry: false,
  canStop: true,
  canArchive: true,
  nodeId: "node-and-263",
  settings: {},
  unread: false,
};

const detail = {
  id: SESSION_ID,
  dispatchId: "dispatch-and-263",
  agentKind: "opencode",
  status: "active",
  updatedAt: now,
  messages: [],
  activities: [],
  canReply: true,
  canResolveDelivery: false,
};

/** Answers the session reads; the callback counts list refetches. */
async function stubSession(page: Page, onListFetch: () => void): Promise<void> {
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "command-1", kind: "instruction", status: "queued", text: "x", createdAt: now }),
      });
      return;
    }
    if (url.pathname === "/api/v1/agent-sessions") onListFetch();
    const body = url.pathname === "/api/v1/agent-sessions" ? { sessions: [summary] } : detail;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("a manual product pick survives the 5s session refetch", async ({ page }) => {
  // A second product, created before the page loads so bootstrap sees it. A
  // random suffix keeps reruns from colliding on the keyPrefix.
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const created = await page.request.post("/api/v1/products", {
    data: { name: `AND-263 切换验收 ${suffix}`, keyPrefix: `SW${suffix}`.slice(0, 10) },
  });
  expect(created.status()).toBe(201);
  const otherProduct = (await created.json()) as { id: string; name: string };

  let listFetches = 0;
  await stubSession(page, () => {
    listFetches += 1;
  });

  await page.goto(CONSOLE_URL);
  await expect(page.locator(".agent-console-reply textarea")).toBeVisible();
  await expect.poll(() => listFetches).toBeGreaterThanOrEqual(1);

  await page.locator("button.product-switcher").click();
  await page.locator(`#product-option-${otherProduct.id}`).click();

  // The bounce-back fired on the refetch after a switch, so wait past at least
  // one refetch that happened after the pick before asserting it held.
  await page.waitForTimeout(6_500);
  expect(listFetches).toBeGreaterThanOrEqual(2);

  expect(await page.evaluate(() => localStorage.getItem("missiongo.product"))).toBe(otherProduct.id);
  await expect(page.locator("span.product-switcher-name")).toHaveText(otherProduct.name);
  await page.screenshot({ path: "test-results/and-263-product-switch.png" });
});
