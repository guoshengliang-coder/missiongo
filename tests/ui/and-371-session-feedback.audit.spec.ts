import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixture.mjs";
import { AUDIT_SOURCE } from "./audit-page.mjs";
import type { AgentSessionCommand } from "../../apps/web/src/types";
import { advanceSessionDetailPoll } from "./polling";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string };
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#16382e"/><text x="40" y="80" fill="#a9edcf" font-size="32">AND-371 Preview</text></svg>').toString("base64");

for (const width of [320, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`compact feedback, recall and generated image ${width}px ${theme}`, async ({ browser }, testInfo) => {
    const touch = width < 1024;
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch,
      colorScheme: theme, storageState: "./tests/ui/.auth/state.json" });
    const page = await context.newPage();
    await page.clock.install();
    const id = "and371-session"; const stamp = new Date().toISOString();
    const attachment = { id: "source-file", filename: "notes.txt", kind: "document" as const, contentType: "text/plain", sizeBytes: 5, sha256: "fixture" };
    let command: AgentSessionCommand = { id: "queued-message", kind: "message", text: "那你找一个需要审批的内容来测试下", status: "queued", createdAt: stamp, attachments: [attachment] };
    let rejectCancel = true; let imageFailed = false; let imagePolls = 0; const artifactRequests: string[] = []; let cancels = 0;
    const turnState = { turnActive: true, waitingForInput: false, turnStartedAt: stamp, observedAt: stamp, lastProgressAt: stamp };
    const summary = { id, agentSessionId: id, agentKind: "codex", status: "active", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
      nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false, mode: "plan", dispatchStatus: "launched", settings: {},
      activities: [], turnState, canReply: true, canStop: true, canArchive: true, canRetry: false, unread: false,
      items: [{ key: "EX-371", title: "会话反馈", productId: fixture.productId }], attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false };
    await page.route("**/api/v1/agent-sessions**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/cancel")) {
        cancels++;
        if (rejectCancel) return route.fulfill({ status: 409, json: { error: { code: "conflict", message: "Already accepted" } } });
        command = { ...command, status: "cancelled" }; return route.fulfill({ json: command });
      }
      if (path.endsWith("/artifacts")) {
        const href = route.request().postDataJSON().href; artifactRequests.push(href);
        return route.fulfill({ json: { id: "generated-image", filename: "preview.svg", status: "pending" } });
      }
      if (path.endsWith("/bundle")) return route.fulfill({ json: { entry: "preview.svg", files: [{ name: "preview.svg", contentType: "image/svg+xml", base64: image }] } });
      if (path.includes("/artifacts/")) {
        imagePolls++;
        return route.fulfill({ json: { id: "generated-image", filename: "preview.svg", status: imageFailed ? "failed" : "ready", ...(imageFailed ? { error: "file_missing" } : {}) } });
      }
      if (path.includes("/attachments/")) return route.fulfill({ contentType: "text/plain", body: "notes" });
      if (path.endsWith("/read")) return route.fulfill({ status: 204 });
      const detail = { ...summary, command, canAttach: true, canResolveDelivery: true, messages: [
        { id: "previous", sourceId: "previous", role: "user", text: "前一条消息", occurredAt: stamp },
        { id: "generated", sourceId: "generated", role: "agent", text: "![image](<file:///tmp/fixture-output/preview.svg>)\n[原图](/tmp/fixture-output/preview.svg) [文档](/tmp/fixture-output/report.pdf)", occurredAt: stamp },
      ] };
      return route.fulfill({ json: path === "/api/v1/agent-sessions" ? { sessions: [{ ...summary, command }] } : detail });
    });
    await page.goto(`/?product=${fixture.productId}&console=agent&session=${id}`);
    const bubble = page.locator(".agent-console-message-outgoing"); const details = page.locator(".agent-run-details");
    await expect(page.locator(".agent-console-outgoing")).toContainText("排队中");
    await expect(bubble).toHaveCSS("padding-top", "12px");
    await expect(bubble).toHaveCSS("padding-left", "16px");
    await expect(bubble.locator(".markdown-text")).toHaveCSS("font-size", "12px");
    await expect(bubble.locator(".markdown-text")).toHaveCSS("line-height", "19.2px");
    await expect(bubble.locator(".agent-reply-feedback")).toHaveCount(0);
    await expect(page.locator(".agent-console-outgoing")).toHaveCSS("gap", "4px");
    await expect(page.locator(".agent-reply-spin")).toHaveCSS("animation-name", "spin");
    await expect(bubble).not.toContainText("详情");
    await expect(bubble).not.toContainText("送达与开始执行");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(details.locator("summary")).toContainText("排队中");
    await expect(page.locator(".agent-run-diagnostics")).not.toBeVisible();
    await details.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".agent-run-diagnostics")).toContainText("送达与开始执行是两个阶段");
    await details.locator("summary").click();
    const edit = page.locator(".agent-console-outgoing").getByRole("button", { name: "撤回编辑" });
    await expect(edit).toHaveCSS("border-top-width", "0px");
    if (touch) {
      expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await details.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const thumbnail = page.locator(".agent-output-images").getByRole("button", { name: "查看原图" });
    await expect(thumbnail).toHaveCount(1);
    await expect.poll(() => thumbnail.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(640);
    expect(artifactRequests).toHaveLength(1); expect(artifactRequests[0]).toContain("preview.svg"); expect(imagePolls).toBeGreaterThan(0);
    await thumbnail.click();
    const viewer = page.getByRole("dialog", { name: "文件预览" });
    await expect(viewer.getByRole("img")).toBeVisible();
    const download = page.waitForEvent("download"); await viewer.getByRole("link", { name: "下载", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("preview.svg");
    await viewer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(thumbnail).toBeFocused();
    expect(artifactRequests).toHaveLength(1);
    for (const scale of ["small", "medium", "large"]) {
      await page.evaluate((scale) => { document.documentElement.dataset.fontScale = scale; document.documentElement.dataset.consoleFontScale = scale; }, scale);
      await expect(edit).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const right = await bubble.boundingBox(); const previous = await page.locator(".agent-console-message-user").first().boundingBox();
      expect(Math.abs(right!.x + right!.width - previous!.x - previous!.width)).toBeLessThanOrEqual(1);
    }
    const audit = await page.evaluate(AUDIT_SOURCE) as { text: { fontSize: number; fontWeight: number; contrast: number; sample: string }[] };
    expect(audit.text.filter((text) => text.fontSize > 0 && text.fontSize < 11)).toEqual([]);
    expect(audit.text.filter((text) => text.contrast < (text.fontSize >= 24 || (text.fontSize >= 18.66 && text.fontWeight >= 700) ? 3 : 4.5))).toEqual([]);
    await page.locator(".agent-console-messages").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const statusBounds = await details.locator("summary").boundingBox();
    const composerBounds = await page.locator(".agent-console-reply").boundingBox();
    expect(statusBounds!.y + statusBounds!.height).toBeLessThanOrEqual(composerBounds!.y);
    await page.screenshot({ path: testInfo.outputPath(`feedback-${width}-${theme}.png`) });
    // A rejected recall retains the message; a successful one restores text AND original files.
    await edit.click(); await expect(edit).toBeEnabled(); await expect(bubble).toContainText(command.text);
    expect(command.status).toBe("queued"); expect(cancels).toBe(1);
    rejectCancel = false; await edit.click();
    const editor = page.locator(".agent-console-reply textarea");
    await expect(editor).toHaveValue(command.text); await expect(editor).toBeEnabled(); await expect(editor).toBeFocused();
    await expect(page.locator(".agent-chat-draft-files")).toContainText("notes.txt");
    await expect(bubble).toHaveCount(0); expect(cancels).toBe(2);
    // Native delivery is no promise of execution; later states must not offer recall.
    for (const status of ["delivering", "delivered", "delivery_unknown", "failed"] as const) {
      command = { ...command, id: `message-${status}`, status };
      await advanceSessionDetailPoll(page);
      await expect(page.locator(`.agent-console-message-outgoing-${status}`)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: "撤回编辑" })).toHaveCount(0);
      if (status === "delivered") await expect(page.locator(".agent-reply-feedback")).toContainText("已送达");
      if (status === "delivery_unknown" || status === "failed") await expect(page.locator(".agent-console-message-delivery")).toBeVisible();
    }
    // An unavailable image is explicit and retryable, and does not attempt a document fetch.
    imageFailed = true;
    await page.reload();
    const imageError = page.locator(".agent-output-image-state[role=alert]");
    await expect(imageError).toContainText("原文件已删除或移动");
    imageFailed = false; await imageError.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".agent-output-image-open img")).toBeVisible();
    expect(artifactRequests.every((href) => href.includes("preview.svg"))).toBe(true);
    await context.close();
  });
}

test("recalling attachments stays bound to the original session and reports partial restore failures", async ({ page }) => {
  const stamp = new Date().toISOString();
  const attachments = ["notes.txt", "missing.txt"].map((filename) => ({ id: filename, filename, kind: "document", contentType: "text/plain", sizeBytes: 5, sha256: "fixture" }));
  let cancelled = false; let releaseFiles!: () => void;
  const files = new Promise<void>((resolve) => { releaseFiles = resolve; });
  const summary = (id: string) => ({ id, agentSessionId: id, agentKind: "codex", status: "idle", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    sessionName: id === "recall-first" ? "First conversation" : "Second conversation", nodeName: "Fixture", nodeConnectionState: "online", nodeRevoked: false,
    mode: "default", dispatchStatus: "launched", settings: {}, activities: [], turnState: {}, canReply: true, canStop: false, canArchive: true,
    canRetry: false, unread: false, items: [{ key: id === "recall-first" ? "EX-371" : "EX-372", title: id === "recall-first" ? "First conversation" : "Second conversation", productId: fixture.productId }],
    attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false });
  const command = () => ({ id: "recall", kind: "message", text: "恢复这条消息", status: cancelled ? "cancelled" : "queued", createdAt: stamp, attachments });
  await page.route("**/api/v1/agent-sessions**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) { cancelled = true; return route.fulfill({ json: command() }); }
    if (path.includes("/attachments/")) {
      await files;
      return path.includes("missing.txt") ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: "text/plain", body: "notes" });
    }
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    if (path === "/api/v1/agent-sessions") return route.fulfill({ json: { sessions: [summary("recall-first"), summary("recall-second")] } });
    const id = path.endsWith("recall-first") ? "recall-first" : "recall-second";
    return route.fulfill({ json: { ...summary(id), canAttach: true, messages: [], ...(id === "recall-first" ? { command: command() } : {}) } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=recall-first`);
  await page.getByRole("button", { name: "撤回编辑" }).click();
  await expect(page.locator(".agent-console-reply textarea")).toBeDisabled();
  await page.locator(".agent-console-session").filter({ hasText: "Second conversation" }).click();
  const editor = page.locator(".agent-console-reply textarea");
  await expect(editor).toBeEnabled(); await editor.fill("第二会话草稿");
  releaseFiles();
  await expect(editor).toHaveValue("第二会话草稿");
  await expect(editor).toBeFocused();
  await expect(page.locator(".agent-chat-draft-files")).toHaveCount(0);
  await page.locator(".agent-console-session").filter({ hasText: "First conversation" }).click();
  await expect(editor).toHaveValue("恢复这条消息");
  await expect(editor).toBeEnabled();
  await expect(page.locator(".agent-chat-draft-files")).toContainText("notes.txt");
  await expect(page.getByText("部分附件未能恢复，请重新添加后再发送。", { exact: true })).toBeVisible();
});
