import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { MissionGoDatabase } from "../../services/server/dist/storage/database.js";
import { ManagedRunStore } from "../../services/server/dist/managed-run-store.js";
import { AUDIT_SOURCE } from "./audit-page.mjs";

async function propose(page: Page, origin: string, accountId = "ui-fixture") {
  const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
  const directory = process.env.MISSIONGO_UI_FIXTURE_DATA;
  if (!directory) throw new Error("Isolated UI fixture is required");
  const db = new MissionGoDatabase(join(directory, "missiongo.sqlite"));
  let run;
  try {
    run = new ManagedRunStore(db).createRun({ accountId, productIds: [fixture.productId] }, {
      scope: { productId: fixture.productId, repositoryRef: "test-repository", itemKeys: [fixture.detailKey], contractRevision: 1 }, idempotencyKey: randomUUID(),
    });
  } finally { db.close(); }
  const response = await page.request.post(`/api/v1/managed-runs/${run.id}/decisions`, { headers: { origin }, data: {
    decisionKey: "implementation", scopeDigest: run.scopeDigest, contractRevision: 1, idempotencyKey: randomUUID(),
    content: { title: "正式批准测试", recommendation: "隔离实现并验证", alternatives: ["延期：功能暂不可用"], costs: "不发布、不迁移生产",
      acceptanceCriteria: ["权限测试通过", "不启动执行器"], allowedActions: ["implement", "review", "verify"] },
  } });
  expect(response.status()).toBe(201);
  return response.json();
}
const guard = (d: any) => ({ version: d.version, stateVersion: d.stateVersion, contentDigest: d.contentDigest,
  scopeDigest: d.scopeDigest, contractRevision: d.scope.contractRevision, idempotencyKey: randomUUID() });

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
for (const theme of ["light", "dark"] as const) {
  test(`decision content remains readable in ${theme} on narrow and landscape screens`, async ({ page, baseURL }) => {
    const d = await propose(page, baseURL!);
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/managed-decisions/${d.id}`);
      await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
      const audit = await page.evaluate(AUDIT_SOURCE) as { horizontalOverflow: number; text: { fontSize: number; fontWeight: number; contrast: number; where: string }[] };
      expect(audit.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(audit.text.filter((t) => t.fontSize > 0 && t.fontSize < 11)).toEqual([]);
      expect(audit.text.filter((t) => t.contrast < ((t.fontSize >= 24 || (t.fontSize >= 18.66 && t.fontWeight >= 700)) ? 3 : 4.5))).toEqual([]);
      for (const control of [page.getByLabel("我已核对当前版本的范围和允许动作").locator(".."), page.getByRole("button", { name: "重新读取状态" })]) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    }
  });
}
test("records explicit approval and revocation on mobile without launching work", async ({ page, baseURL }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const d = await propose(page, baseURL!);
  await page.goto(`/managed-decisions/${d.id}`);
  await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准当前版本", exact: true })).toBeDisabled();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: /查看原条目/ }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/?product=.*item=/); await popup.close();
  expect((await (await page.request.get(`/api/v1/managed-decisions/${d.id}`)).json()).decision.status).toBe("pending");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("decision-mobile.png"), fullPage: true });
  await page.getByLabel("我已核对当前版本的范围和允许动作").check();
  await page.getByRole("button", { name: "批准当前版本", exact: true }).click();
  await expect(page.getByTestId("decision-status")).toHaveText("已批准");
  await page.getByLabel("我已核对当前版本的范围和允许动作").check();
  await page.getByRole("button", { name: "撤销批准", exact: true }).click();
  await expect(page.getByTestId("decision-status")).toHaveText("已撤销");
  await page.reload();
  await expect(page.getByTestId("decision-status")).toHaveText("已撤销");
  const events = await (await page.request.get(`/api/v1/managed-decisions/${d.id}/events`)).json();
  expect(events.events.map((x: any) => x.operation)).toEqual(["create", "approve", "revoke"]);
  expect(errors).toEqual([]);
});

test("ignores superseded initial reads rather than carrying confirmation to a new version", async ({ page, baseURL }) => {
  const d = await propose(page, baseURL!);
  let blockInitialReads = true;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const initialReads: Promise<void>[] = [];
  await page.route(`**/api/v1/managed-decisions/${d.id}`, async (route) => {
    if (!blockInitialReads) { await route.continue(); return; }
    let finished!: () => void;
    initialReads.push(new Promise<void>((resolve) => { finished = resolve; }));
    await barrier;
    // Delay processing, not just delivery: this old request reads the revised state.
    const response = await route.fetch();
    await route.fulfill({ response }); finished();
  });
  await page.goto(`/managed-decisions/${d.id}`);
  // The development root uses StrictMode; hold both the probe and the active effect.
  await expect.poll(() => initialReads.length).toBe(2);
  blockInitialReads = false;
  await page.getByRole("button", { name: "重新读取状态" }).click();
  await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
  await page.getByLabel("我已核对当前版本的范围和允许动作").check();
  const revised = await page.request.post(`/api/v1/managed-decisions/${d.id}/revise`, { headers: { origin: baseURL! }, data: {
    ...guard(d), content: { ...d.content, costs: "迟到读取到的新版代价" },
  } });
  expect(revised.status()).toBe(200);
  release(); await Promise.all(initialReads);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText(d.content.costs, { exact: true })).toBeVisible();
  await expect(page.getByText("迟到读取到的新版代价", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "批准当前版本", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("决策已变化");
  await expect(page.getByLabel("我已核对当前版本的范围和允许动作")).not.toBeChecked();
  expect((await (await page.request.get(`/api/v1/managed-decisions/${d.id}`)).json()).decision.status).toBe("pending");
});

for (const late of ["pending", "unauthorized"] as const) {
  test(`does not let an old ${late} read replace an approved readback`, async ({ page, baseURL }) => {
    const d = await propose(page, baseURL!);
    let blockInitialReads = true;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const initialReads: Promise<void>[] = [];
    await page.route(`**/api/v1/managed-decisions/${d.id}`, async (route) => {
      if (!blockInitialReads) { await route.continue(); return; }
      const response = await route.fetch();
      expect((await response.json()).decision.status).toBe("pending");
      let finished!: () => void;
      initialReads.push(new Promise<void>((resolve) => { finished = resolve; }));
      await barrier;
      if (late === "unauthorized") await route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ code: "unauthorized", message: "Simulated expired initial read" }) });
      else await route.fulfill({ response });
      finished();
    });
    await page.goto(`/managed-decisions/${d.id}`);
    await expect.poll(() => initialReads.length).toBe(2);
    blockInitialReads = false;
    await page.getByRole("button", { name: "重新读取状态" }).click();
    await page.getByLabel("我已核对当前版本的范围和允许动作").check();
    await page.getByRole("button", { name: "批准当前版本", exact: true }).click();
    await expect(page.getByTestId("decision-status")).toHaveText("已批准");
    release(); await Promise.all(initialReads);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId("decision-status")).toHaveText("已批准");
    await expect(page.getByLabel("我已核对当前版本的范围和允许动作")).not.toBeChecked();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  });
}

test("requires fresh confirmation after stale-page conflict instead of auto-approving", async ({ page, baseURL }) => {
  const d = await propose(page, baseURL!);
  await page.goto(`/managed-decisions/${d.id}`);
  await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
  const revised = await page.request.post(`/api/v1/managed-decisions/${d.id}/revise`, { headers: { origin: baseURL! }, data: {
    ...guard(d), content: { ...d.content, costs: "新版代价：需要额外验证" },
  } });
  expect(revised.status()).toBe(200);
  await page.getByLabel("我已核对当前版本的范围和允许动作").check();
  await page.getByRole("button", { name: "批准当前版本", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("决策已变化");
  await expect(page.getByText("新版代价：需要额外验证", { exact: true })).toBeVisible();
  await expect(page.getByLabel("我已核对当前版本的范围和允许动作")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "批准当前版本", exact: true })).toBeDisabled();
  expect((await (await page.request.get(`/api/v1/managed-decisions/${d.id}`)).json()).decision.status).toBe("pending");
});

test("double clicks create only one approval and a lost response is reconciled", async ({ page, baseURL }) => {
  const d = await propose(page, baseURL!);
  await page.goto(`/managed-decisions/${d.id}`);
  await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
  let writes = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v1/managed-decisions/${d.id}/approve`, async (route) => {
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await barrier;
    // The server committed; the client did not receive the write receipt.
    await route.abort("failed");
  });
  await page.getByLabel("我已核对当前版本的范围和允许动作").check();
  await page.getByRole("button", { name: "批准当前版本", exact: true }).dblclick({ force: true });
  await expect(page.getByRole("button", { name: "批准当前版本", exact: true })).toBeDisabled();
  release();
  await expect(page.getByTestId("decision-status")).toHaveText("已批准");
  await expect(page.getByRole("alert")).toContainText("操作未确认");
  expect(writes).toBe(1);
  const events = await (await page.request.get(`/api/v1/managed-decisions/${d.id}/events`)).json();
  expect(events.events.map((x: any) => x.operation)).toEqual(["create", "approve"]);
});

test("keeps the deep link across a real human login", async ({ page, baseURL }) => {
  const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8"));
  const email = `decision-${randomUUID()}@example.test`;
  const password = `fixture-${randomUUID()}`;
  const memberResponse = await page.request.post("/api/v1/accounts", { data: { email, password, role: "member" } });
  expect(memberResponse.status()).toBe(201);
  const member = await memberResponse.json();
  const grant = await page.request.put(`/api/v1/accounts/${member.id}/products`, { data: { permissions: [
    { productId: fixture.productId, canView: true, canOperate: true, canUseAi: true },
  ] } });
  expect(grant.ok()).toBe(true);
  expect((await page.request.post("/api/v1/auth/login", { data: { username: email, password } })).ok()).toBe(true);
  const d = await propose(page, baseURL!, member.id);
  await page.context().clearCookies();
  await page.goto(`/managed-decisions/${d.id}`);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正式批准测试" })).toBeVisible();
  await expect(page).toHaveURL(`/managed-decisions/${d.id}`);
  await expect(page.getByTestId("decision-status")).toHaveText("待批准");
});
