import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DeepSeek title generation", () => {
  it("keeps the global key encrypted and sends only the requested text to Flash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-ai-title-"));
    directories.push(directory);
    const databasePath = join(directory, "data.sqlite");
    const provider = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: "  登录页面偶发空白  " } }] }), { status: 200 }));
    const app = buildApp({ databasePath, adminToken: "admin-test-token", aiProviderFetch: provider as typeof fetch });
    apps.push(app);
    const headers = { authorization: "Bearer admin-test-token" };
    const created = await app.inject({ method: "POST", url: "/api/v1/products", headers, payload: { name: "Test", keyPrefix: "TEST" } });
    expect(created.statusCode, created.body).toBe(201);
    const product = created.json<{ id: string }>();

    expect((await app.inject({ method: "GET", url: "/api/v1/ai/title-settings", headers })).json()).toEqual({ configured: false });
    const unconfigured = await app.inject({ method: "POST", url: "/api/v1/ai/title", headers, payload: { productId: product.id, content: "页面空白" } });
    expect(unconfigured.statusCode, unconfigured.body).toBe(503);
    const saved = await app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers, payload: { apiKey: "secret-deepseek-key" } });
    expect(saved.json()).toEqual({ configured: true });
    expect((await readFile(databasePath)).includes(Buffer.from("secret-deepseek-key"))).toBe(false);

    const generated = await app.inject({ method: "POST", url: "/api/v1/ai/title", headers, payload: { productId: product.id, content: "页面空白" } });
    expect(generated.json()).toEqual({ title: "登录页面偶发空白" });
    const [url, init] = provider.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret-deepseek-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
    expect(String(init?.body)).toContain("页面空白");

    await app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers, payload: { apiKey: null } });
    expect((await app.inject({ method: "GET", url: "/api/v1/ai/title-settings", headers })).json()).toEqual({ configured: false });
  });

  it("refuses untrusted callers and hides provider error bodies", async () => {
    const provider = vi.fn(async () => new Response("provider secret details", { status: 401 }));
    const app = buildApp({ adminToken: "admin-test-token", aiProviderFetch: provider as typeof fetch });
    apps.push(app);
    const headers = { authorization: "Bearer admin-test-token" };
    const created = await app.inject({ method: "POST", url: "/api/v1/products", headers, payload: { name: "Test", keyPrefix: "TEST" } });
    expect(created.statusCode, created.body).toBe(201);
    const product = created.json<{ id: string }>();
    expect((await app.inject({ method: "GET", url: "/api/v1/ai/title-settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/ai/title", payload: { productId: product.id, content: "example" } })).statusCode).toBe(401);
    await app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers, payload: { apiKey: "secret-deepseek-key" } });
    const response = await app.inject({ method: "POST", url: "/api/v1/ai/title", headers, payload: { productId: product.id, content: "example" } });
    expect(response.statusCode, response.body).toBe(502);
    expect(response.body).not.toContain("provider secret details");
  });

  it("lets an SDK feedback session generate from its own draft text only", async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "搜索结果重试后消失" } }],
    }), { status: 200 }));
    const app = buildApp({
      adminToken: "admin-test-token",
      aiProviderFetch: provider as typeof fetch,
      sdkRateLimits: { ai_title: { limit: 1, windowMilliseconds: 60_000 } },
    });
    apps.push(app);
    const adminHeaders = { authorization: "Bearer admin-test-token" };
    const product = (await app.inject({
      method: "POST", url: "/api/v1/products", headers: adminHeaders,
      payload: { name: "SDK Test", keyPrefix: "ST" },
    })).json<{ id: string }>();
    const sdkToken = (await app.inject({
      method: "POST", url: "/api/v1/sdk-tokens", headers: adminHeaders,
      payload: { name: "Android host", productId: product.id },
    })).json<{ token: string }>().token;
    await app.inject({ method: "PUT", url: "/api/v1/ai/title-settings", headers: adminHeaders,
      payload: { apiKey: "secret-deepseek-key" } });
    const draftPayload = {
      type: "bug", title: "", description: "Stored description must not be used",
      environment: { platform: "android" }, context: { private: "device context" },
      logs: [{ timestamp: "2026-09-18T00:00:00.000Z", level: "error", message: "private log" }],
    };
    const createEditor = async (clientDraftId: string) => (await app.inject({
      method: "POST", url: "/api/v1/sdk/editor-session",
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { ...draftPayload, clientDraftId },
    })).json<{ id: string; sessionToken: string }>();
    const draft = await createEditor("feedback-title-1");
    const otherDraft = await createEditor("feedback-title-2");
    const url = `/api/v1/sdk/drafts/${draft.id}/ai-title`;
    const payload = { content: "搜索结果重试后消失" };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, payload,
      headers: { cookie: `missiongo_feedback_session=${otherDraft.sessionToken}` },
    })).statusCode).toBe(401);
    const sessionHeaders = { cookie: `missiongo_feedback_session=${draft.sessionToken}` };
    const generated = await app.inject({ method: "POST", url, headers: sessionHeaders, payload });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json()).toEqual({ title: "搜索结果重试后消失" });
    const sent = JSON.stringify(JSON.parse(String(provider.mock.calls[0]?.[1]?.body)));
    expect(sent).toContain(payload.content);
    expect(sent).not.toContain(draftPayload.description);
    expect(sent).not.toContain("private log");
    expect(sent).not.toContain("device context");
    expect((await app.inject({ method: "POST", url, headers: sessionHeaders, payload })).statusCode).toBe(429);
    const edited = await app.inject({ method: "PATCH", url: `/api/v1/sdk/drafts/${draft.id}`,
      headers: sessionHeaders, payload: { title: generated.json<{ title: string }>().title } });
    expect(edited.statusCode).toBe(200);
    const finalized = await app.inject({ method: "POST",
      url: `/api/v1/sdk/drafts/${draft.id}/finalize`, headers: sessionHeaders });
    expect(finalized.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers: sessionHeaders, payload })).statusCode).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
