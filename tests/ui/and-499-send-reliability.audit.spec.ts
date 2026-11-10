import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentSessionCommand } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const stamp = "2026-11-10T07:00:00Z";
for (const external of [false, true]) for (const width of [320, 1440]) {
  test(`AND-499 lost reply result keeps original request external=${external} width=${width}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(stamp));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 320 ? "dark" : "light" });
    const id = "send-recovery";
    const row = { id, agentSessionId: id, dispatchId: `dispatch-${id}`, sessionName: "发送恢复核对", productId: fixture.productId,
      source: external ? "external" : "dispatch", agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: external ? "external" : "launched", nodeName: "Fixture",
      ...(external ? { refKind: "native", nativeConnection: { state: "connected", nodeName: "Fixture", nodeId: "fixture", lastSyncedAt: stamp } } : {}),
      nodeConnectionState: "online", nodeRevoked: false, createdAt: stamp, updatedAt: stamp, activityAt: stamp,
      activities: [], items: [], settings: { mode: "auto", adjustable: false }, canReply: true, canAttach: true, canArchive: true,
      canStop: false, canRetry: false, unread: false, needsAttention: false, attention: { state: "not_needed" } };
    const sent: { text: string; requestKey: string; attachmentIds: string[] }[] = [];
    const uploadKeys: string[] = []; let deletes = 0, lookupVisible = false, secondUploadFails = true;
    let command: AgentSessionCommand | undefined;
    let releaseUpload!: () => void;
    let delayUpload = true;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "DELETE") { deletes++; return route.fulfill({ status: 204 }); }
      if (path.endsWith("/attachments") && route.request().method() === "POST") {
        const key = route.request().headers()["x-missiongo-request-key"]!; uploadKeys.push(key);
        if (delayUpload) { delayUpload = false; await new Promise<void>(resolve => { releaseUpload = resolve; }); }
        if (key.endsWith("-1") && secondUploadFails) {
          secondUploadFails = false; return route.fulfill({ status: 400, json: { code: "invalid_input", title: "Upload rejected" } });
        }
        return route.fulfill({ status: 201, json: { id: key.endsWith("-0") ? "file-a" : "file-b", filename: "file.txt", kind: "document", contentType: "text/plain", sizeBytes: 1, sha256: "fixture", createdAt: stamp } });
      }
      if (path.endsWith("/commands")) {
        const body = route.request().postDataJSON(); sent.push(body);
        expect(body.requestKey).toMatch(/^[a-z0-9-]{36}$/);
        command = { id: `command-${sent.length}`, kind: "message", text: body.text, createdAt: stamp, status: "delivered" };
        if (sent.length === 1) return route.abort("failed");
        return route.fulfill({ status: 201, json: command });
      }
      if (path.includes("/send-requests/")) return route.fulfill({ json: { command: lookupVisible ? command : null } });
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] }
        : { ...row, messages: [], canResolveDelivery: true } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const reply = page.locator(".agent-console-reply textarea");
    await reply.fill("执行本次操作");
    await page.locator('.agent-console-reply input[type="file"]').setInputFiles([
      { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }, { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b") },
    ]);
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(page.locator(".agent-console-reply")).toContainText("正在上传附件 1/2");
    await expect(reply).toBeDisabled();
    releaseUpload();
    await expect(page.getByRole("button", { name: "发送回复", exact: true })).toBeEnabled();
    await expect(reply).toHaveValue("执行本次操作");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(page.locator(".agent-console-reply")).toContainText("提交结果待核对");
    expect(sent).toHaveLength(1);
    expect(uploadKeys).toHaveLength(3);
    expect(uploadKeys[1]).toBe(uploadKeys[2]);
    expect(sent[0]!.attachmentIds).toEqual(["file-a", "file-b"]);
    expect(deletes).toBe(0);
    await expect(reply).toHaveValue("执行本次操作");
    await expect(reply).toBeDisabled();
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate(scale => { document.documentElement.dataset.fontScale = scale; }, scale);
      await expect(page.getByRole("button", { name: "核对结果", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`unconfirmed-${external}-${width}.png`) });
    // Read-only recovery never replays the command. Confirmed success releases the original draft.
    lookupVisible = true;
    await page.getByRole("button", { name: "核对结果", exact: true }).click();
    await expect(reply).toHaveValue("");
    await expect(reply).toBeEnabled();
    expect(sent).toHaveLength(1);
    await expect(page.locator(".agent-console-reply .agent-chat-draft-files")).toHaveCount(0);
    await reply.fill("执行本次操作");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]!.requestKey).not.toBe(sent[0]!.requestKey);
    expect(errors).toEqual([]);
  });
}

test("AND-499 item panel keeps an unknown send and only retries the original key", async ({ page }) => {
  await page.clock.setFixedTime(new Date(stamp));
  const id = "panel-send-recovery";
  const row = { id, agentSessionId: id, dispatchId: "dispatch-panel", agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", nodeName: "Fixture",
    createdAt: stamp, updatedAt: stamp, activityAt: stamp, activities: [], items: [{ key: fixture.detailKey, productId: fixture.productId, title: "Fixture" }],
    settings: { mode: "auto", adjustable: false }, canReply: true, canArchive: true, canStop: false, canRetry: false, attention: { state: "not_needed" } };
  const sent: { text: string; requestKey: string }[] = [];
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/commands")) {
      const body = route.request().postDataJSON(); sent.push(body);
      if (sent.length === 1) return route.abort("failed");
      return route.fulfill({ status: 201, json: { id: "same-command", kind: "message", text: body.text, status: "queued", createdAt: stamp } });
    }
    if (path.includes("/send-requests/")) return route.fulfill({ json: { command: null } });
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [] } });
  });
  await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: row.dispatchId,
    agentSessionId: id, agentKind: "codex", mode: "auto", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey] }] } }));
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  await page.locator(".execution-history > summary").click();
  await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
  await page.locator(".agent-session-toggle").click();
  const panel = page.locator(".agent-session-panel"), reply = panel.locator("textarea");
  await reply.fill("执行一次");
  await panel.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect(panel).toContainText("提交结果待核对");
  await expect(reply).toBeDisabled();
  await panel.getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(panel.getByRole("button", { name: "重试本次请求" })).toBeEnabled();
  expect(sent).toHaveLength(1);
  await page.locator(".detail-dispatch-jump").click();
  const consoleReply = page.locator(".agent-console-reply textarea");
  await expect(page.locator(".agent-console-reply")).toContainText("提交结果待核对");
  await expect(consoleReply).toHaveValue("执行一次");
  await expect(consoleReply).toBeDisabled();
  await page.getByRole("button", { name: "重试本次请求", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  await expect(consoleReply).toHaveValue("");
});

for (const terminal of ["cancelled", "failed"] as const) {
  test(`AND-499 audit R3 keeps attachment draft after recovering ${terminal}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(stamp));
    const id = `terminal-${terminal}`;
    const row = { id, agentSessionId: id, dispatchId: `dispatch-${id}`, sessionName: id, productId: fixture.productId,
      agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
      createdAt: stamp, updatedAt: stamp, activityAt: stamp, activities: [], items: [], settings: { mode: "auto", adjustable: false },
      canReply: true, canAttach: true, canArchive: true, canStop: false, canRetry: false, unread: false, needsAttention: false, attention: { state: "not_needed" } };
    const sent: { text: string; requestKey: string; attachmentIds: string[] }[] = [], uploads: string[] = [];
    let command: AgentSessionCommand | undefined;
    await page.route("**/api/v1/agent-sessions**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/attachments") && route.request().method() === "POST") {
        const key = route.request().headers()["x-missiongo-request-key"]!; uploads.push(key);
        return route.fulfill({ status: 201, json: { id: key, filename: "reference.txt", kind: "document", contentType: "text/plain", sizeBytes: 1, sha256: "fixture", createdAt: stamp } });
      }
      if (path.endsWith("/commands")) {
        const body = route.request().postDataJSON(); sent.push(body);
        command = { id: `command-${sent.length}`, kind: "message", text: body.text, status: sent.length === 1 ? terminal : "delivered", createdAt: stamp };
        return sent.length === 1 ? route.abort("failed") : route.fulfill({ status: 201, json: command });
      }
      if (path.includes("/send-requests/")) return route.fulfill({ json: { command } });
      if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [] } });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const reply = page.locator(".agent-console-reply textarea");
    await reply.fill("保留这份资料");
    await page.locator('.agent-console-reply input[type="file"]').setInputFiles({ name: "reference.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(page.locator(".agent-console-reply")).toContainText("原消息已撤回或发送失败");
    await expect(reply).toHaveValue("保留这份资料");
    await expect(page.locator(".agent-console-reply .agent-chat-draft-files > *")).toHaveCount(1);
    expect(sent).toHaveLength(1);
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(reply).toHaveValue("");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.requestKey).not.toBe(sent[0]!.requestKey);
    expect(uploads[1]).not.toBe(uploads[0]);
    expect(sent[1]!.attachmentIds).toEqual([uploads[1]]);
  });
}

test("AND-499 audit R3 failed upload moves back to item panel with original files", async ({ page }) => {
  await page.clock.setFixedTime(new Date(stamp));
  const id = "failed-file-cross-surface";
  const row = { id, agentSessionId: id, dispatchId: "dispatch-cross-file", sessionName: id, productId: fixture.productId,
    agentKind: "codex", status: "idle", mode: "auto", dispatchStatus: "launched", nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
    createdAt: stamp, updatedAt: stamp, activityAt: stamp, activities: [], items: [{ key: fixture.detailKey, title: "Fixture", productId: fixture.productId }],
    settings: { mode: "auto", adjustable: false }, canReply: true, canAttach: true, canArchive: true, canStop: false, canRetry: false, attention: { state: "not_needed" } };
  let failUpload = true;
  const uploadKeys: string[] = [], commands: { text: string; attachmentIds: string[] }[] = [];
  await page.route("**/api/v1/agent-sessions**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/attachments") && route.request().method() === "POST") {
      uploadKeys.push(route.request().headers()["x-missiongo-request-key"]!);
      if (failUpload) { failUpload = false; return route.fulfill({ status: 400, json: { code: "invalid_input" } }); }
      return route.fulfill({ status: 201, json: { id: "inherited-file", filename: "reference.txt", kind: "document", contentType: "text/plain", sizeBytes: 1, sha256: "fixture", createdAt: stamp } });
    }
    if (path.endsWith("/commands")) {
      commands.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "file-command", kind: "message", text: commands[0]!.text, status: "queued", createdAt: stamp } });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 204 });
    return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [row] } : { ...row, messages: [] } });
  });
  await page.route("**/api/v1/items/*/dispatches", route => route.fulfill({ json: { dispatches: [{ id: row.dispatchId,
    agentSessionId: id, agentKind: "codex", mode: "auto", nodeName: "Fixture", status: "launched", createdAt: stamp, itemKeys: [fixture.detailKey] }] } }));
  await page.goto(`/?product=${fixture.productId}&item=${fixture.detailKey}`);
  await page.locator(".detail-dispatch-jump").click();
  const consoleReply = page.locator(".agent-console-reply textarea");
  await expect(consoleReply).toBeVisible();
  // File-only draft exercises the panel's inherited attachment path, without adding a picker there.
  await page.locator('.agent-console-reply input[type="file"]').setInputFiles({ name: "reference.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect(page.locator(".agent-console-reply [role=alert]")).toBeVisible();
  await page.locator(".agent-console-topbar-back").click();
  await page.locator(".execution-history > summary").click();
  await page.locator(".execution-record > summary").filter({ hasText: "派单 · Fixture" }).click();
  await page.locator(".agent-session-toggle").click();
  const panel = page.locator(".agent-session-panel");
  await expect(panel.locator(".agent-chat-draft-files")).toContainText("reference.txt");
  await panel.locator(".agent-chat-draft-files").scrollIntoViewIfNeeded();
  await expect(panel.locator(".agent-chat-draft-files")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inherited-file-panel.png") });
  await expect(panel.getByRole("button", { name: "发送回复", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "重试本次请求", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ text: "", attachmentIds: ["inherited-file"] });
  expect(uploadKeys[1]).toBe(uploadKeys[0]);
});
