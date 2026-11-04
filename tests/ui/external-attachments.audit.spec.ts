import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentSession, AgentSessionAttachment, AgentSessionCommand, AgentSessionSummary } from "../../apps/web/src/types";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAA60lEQVR4nO3RAQkAIBDAwM9pNbuYzRQijIMLMNisswmb7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcdwHvS5pSNxWeuQAAAABJRU5ErkJggg==", "base64");
for (const kind of ["codex", "claude_code", "opencode"] as const) {
  for (const width of [375, 1440]) {
    for (const theme of ["light", "dark"] as const) {
      test(`external attachment ${kind} ${width}px ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.emulateMedia({ colorScheme: theme });
        const stamp = new Date().toISOString();
        let failUpload = true;
        let command: AgentSessionCommand | undefined;
        const uploads: AgentSessionAttachment[] = [];
        const summary = (): AgentSessionSummary => ({
          id: "external-files", agentSessionId: "external-files", source: "external", agentKind: kind,
          status: "idle", progressStatus: "working", refKind: "native", lastReportedAt: stamp,
          nativeConnection: { state: "connected", nodeId: "node", nodeName: "Fixture", lastSyncedAt: stamp },
          ...(command ? { command } : {}), nodeName: kind, nodeRevoked: false, mode: "external", dispatchStatus: "external",
          updatedAt: stamp, activityAt: stamp, createdAt: stamp, sessionName: "外部会话附件",
          items: [{ key: fixture.detailKey, title: "附件测试", productId: fixture.productId }], activities: [],
          canReply: true, canRetry: false, canStop: false, canArchive: true, canConnectNative: false, canDisconnectNative: true,
          settings: { mode: "external", adjustable: false }, attention: { state: "not_needed" },
          needsAttention: false, waitingForReply: false, unread: false,
        });
        const detail = (): AgentSession => ({ ...summary(), canAttach: true, messages: [], activities: [],
          ...(command ? { attachmentMessages: [{ commandId: command.id, text: command.text, status: command.status,
            createdAt: stamp, attachments: command.attachments! }] } : {}) });
        await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async route => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/attachments") && route.request().method() === "POST") {
            if (failUpload) { failUpload = false; return route.fulfill({ status: 503, json: { title: "Temporary failure" } }); }
            const filename = decodeURIComponent(route.request().headers()["x-missiongo-filename"]!);
            const file: AgentSessionAttachment = { id: `upload-${uploads.length}`, filename, kind: filename.endsWith("png") ? "image" : "document",
              contentType: filename.endsWith("png") ? "image/png" : "application/pdf", sizeBytes: route.request().postDataBuffer()!.length,
              sha256: "fixture", createdAt: stamp };
            uploads.push(file);
            return route.fulfill({ status: 201, json: file });
          }
          if (path.endsWith("/commands")) {
            const body = route.request().postDataJSON();
            expect(body.text).toBe("");
            expect(body.attachmentIds).toEqual(uploads.map(file => file.id));
            command = { id: "attachment-command", kind: "message", text: "", status: "delivered", createdAt: stamp, attachments: uploads };
            return route.fulfill({ status: 201, json: command });
          }
          if (path.endsWith("/content") || path.endsWith("/preview")) return route.fulfill({ contentType: "image/png", body: png });
          if (path.endsWith("/agent-sessions")) return route.fulfill({ json: { sessions: [summary()] } });
          if (route.request().method() === "GET") return route.fulfill({ json: detail() });
          throw new Error(`Unexpected attachment request: ${path}`);
        });
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.goto(`/?product=${fixture.productId}&console=agent&session=external-files`);
        await expect(page.getByRole("button", { name: "添加图片、文件或视频", exact: true })).toBeEnabled();
        await page.locator('.agent-console-reply input[type="file"]').setInputFiles([
          { name: "reference.png", mimeType: "image/png", buffer: png },
          { name: "reference.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") },
        ]);
        await expect(page.locator(".agent-chat-draft-files > *")).toHaveCount(2);
        const draftPreview = page.getByRole("button", { name: "预览 reference.png", exact: true });
        await draftPreview.click();
        await expect(page.locator(".selected-media-lightbox .zoomable-image img")).toHaveAttribute("alt", "reference.png");
        await page.getByRole("button", { name: "关闭预览", exact: true }).click();
        await expect(draftPreview).toBeFocused();
        await expect(page.locator(".agent-chat-draft-files > *")).toHaveCount(2);
        await page.getByRole("button", { name: "发送回复", exact: true }).click();
        await expect(page.locator(".agent-chat-draft-files > *")).toHaveCount(2);
        await expect(page.getByRole("button", { name: "发送回复", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "发送回复", exact: true }).click();
        await expect.poll(() => command?.attachments?.length).toBe(2);
        await expect(page.locator(".agent-chat-draft-files")).toHaveCount(0);
        await page.reload();
        await expect(page.locator(".agent-chat-attachments")).toHaveCount(1);
        await expect(page.getByText("暂时还没有可显示的消息。")).toHaveCount(0);
        await expect(page.locator(".agent-chat-attachment")).toHaveCount(1);
        await expect.poll(() => page.locator('.agent-chat-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(160);
        await page.locator(".agent-chat-image-open").click();
        await expect(page.locator(".selected-media-lightbox .zoomable-image")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator(".agent-chat-image-open")).toBeFocused();
        const picker = await page.getByRole("button", { name: "添加图片、文件或视频", exact: true }).boundingBox();
        expect(picker!.width).toBeGreaterThanOrEqual(44); expect(picker!.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`external-files-${kind}-${width}-${theme}.png`) });
        expect(errors).toEqual([]);
      });
    }
  }
}
