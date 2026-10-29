import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ARTIFACT_PREVIEW_POLICY, ARTIFACT_PREVIEW_SHELL } from "../../services/server/src/agent-artifacts";

const fixture = JSON.parse(readFileSync(new URL("./.auth/fixture.json", import.meta.url), "utf8")) as { productId: string; detailKey: string };
const file = (name: string, contentType: string, text: string) => ({ name, contentType, base64: Buffer.from(text).toString("base64") });
const htmlBundle = { entry: "prototype.html", files: [
  file("prototype.html", "text/html", `<link rel="stylesheet" href="style.css"><h1>可点击原型</h1><button id="action">切换状态</button><output id="result">初始</output><script src="app.js"></script>`),
  file("style.css", "text/css", "h1 { color: rgb(12, 120, 60); }"),
  file("app.js", "text/javascript", `document.getElementById('action').onclick = () => { document.getElementById('result').textContent = '已切换'; }; try { parent.document.body.dataset.escaped='yes'; } catch { document.body.dataset.isolated='yes'; } fetch('https://blocked.example.test/leak').catch(() => { document.body.dataset.network='blocked'; });`),
] };

for (const width of [375, 1440]) test(`historical artifacts preview, isolation, offline cache and errors at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const stamp = new Date().toISOString();
  let kind = "html"; let missing = false; let saved = false; let requests = 0; let network = 0;
  const summary = { id: "artifact-session", agentSessionId: "artifact-session", source: "external", agentKind: "codex", status: "idle",
    nodeName: "Fixture", nodeRevoked: false, mode: "external", dispatchStatus: "external", updatedAt: stamp, activityAt: stamp, createdAt: stamp,
    items: [{ key: fixture.detailKey, title: "文件预览", productId: fixture.productId }], activities: [], turnState: {}, canReply: false,
    canRetry: false, canStop: false, canArchive: true, settings: { mode: "external", adjustable: false }, attention: { state: "not_needed" }, needsAttention: false, waitingForReply: false, unread: false };
  const text = "[效果图](/tmp/fixture-output/overview.png) · [可点击原型](/tmp/fixture-output/prototype.html) · [说明](file:///tmp/fixture-output/notes.md) · [文档](/tmp/fixture-output/report.pdf)";
  const detail = { id: summary.id, source: "external", agentKind: "codex", status: "idle", updatedAt: stamp,
    messages: [{ id: "output-message", sourceId: "native-message", role: "agent", text, occurredAt: stamp }], activities: [], turnState: {}, canReply: false, canAttach: false, canResolveDelivery: false };
  await page.route("https://blocked.example.test/**", (route) => { network++; return route.abort(); });
  await page.route((url) => url.pathname === "/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'" } });
  });
  await page.route(/\/api\/v1\/agent-sessions(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return route.fulfill({ contentType: "text/html", headers: { "content-security-policy": ARTIFACT_PREVIEW_POLICY, "x-frame-options": "SAMEORIGIN" }, body: ARTIFACT_PREVIEW_SHELL });
    if (path.endsWith("/bundle")) return route.fulfill({ json: kind === "html" ? htmlBundle
      : kind === "md" ? { entry: "notes.md", files: [file("notes.md", "text/markdown", "# 已保存说明\n\n**可以离线查看**\n\n![本地图](diagram.svg)"), file("diagram.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')] }
      : kind === "pdf" ? { entry: "report.pdf", files: [file("report.pdf", "application/pdf", "%PDF-1.4\n%%EOF")] }
      : { entry: "overview.png", files: [{ name: "overview.png", contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=" }] } });
    if (path.endsWith("/artifacts")) {
      requests++;
      const href = route.request().postDataJSON().href as string;
      kind = href.endsWith(".md") ? "md" : href.endsWith(".pdf") ? "pdf" : href.endsWith(".png") ? "png" : "html";
      return route.fulfill({ json: { id: `${missing ? "missing" : "saved"}-${kind}`, status: missing ? "failed" : saved ? "ready" : "pending", filename: `output.${kind}`, ...(missing ? { error: "file_missing" } : {}) } });
    }
    if (path.includes("/artifacts/")) { saved = true; return route.fulfill({ json: { id: `${missing ? "missing" : "saved"}-${kind}`, status: missing ? "failed" : "ready", filename: `output.${kind}`, ...(missing ? { error: "file_missing" } : {}) } }); }
    if (path.endsWith("/artifact-session")) return route.fulfill({ json: detail });
    if (path.endsWith("/read")) return route.fulfill({ status: 204 });
    return route.fulfill({ json: { sessions: [summary] } });
  });
  await page.goto(`/?product=${fixture.productId}&console=agent&session=artifact-session`);
  await page.getByRole("button", { name: "可点击原型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文件预览" });
  await expect(dialog).toBeVisible();
  const frame = page.frameLocator('iframe[title="prototype.html"]');
  await expect(frame.getByRole("heading", { name: "可点击原型" })).toBeVisible();
  await expect(frame.getByRole("heading")).toHaveCSS("color", "rgb(12, 120, 60)");
  await frame.getByRole("button", { name: "切换状态" }).click();
  await expect(frame.locator("#result")).toHaveText("已切换");
  await expect(frame.locator("body")).toHaveAttribute("data-isolated", "yes");
  await expect(frame.locator("body")).toHaveAttribute("data-network", "blocked");
  expect(network).toBe(0);
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "下载", exact: true }).click();
  const download = await downloaded;
  const downloadedPath = test.info().outputPath("offline-prototype.html");
  await download.saveAs(downloadedPath);
  const offlineHtml = readFileSync(downloadedPath, "utf8");
  expect(offlineHtml).toContain("data:text/javascript;base64,");
  expect(offlineHtml).toContain("data:text/css;base64,");
  await page.screenshot({ path: test.info().outputPath(`artifact-preview-${width}.png`) });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "可点击原型", exact: true }).click();
  await expect(dialog.getByText("已保存，原设备离线后仍可查看。")).toBeVisible();
  expect(requests).toBe(2);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "说明", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "已保存说明" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "本地图" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "本地图" })).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "效果图", exact: true }).click();
  await expect(dialog.getByRole("img")).toBeVisible();
  await expect.poll(() => dialog.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await expect(dialog.locator('iframe[title="report.pdf"]')).toHaveAttribute("src", /^blob:/);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  missing = true;
  await page.getByRole("button", { name: "可点击原型", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("原文件已删除或移动");
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
