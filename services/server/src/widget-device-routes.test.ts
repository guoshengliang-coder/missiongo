import { generateKeyPairSync, scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminAccountConfig } from "./admin-auth.js";
import { buildApp } from "./app.js";
import type { WidgetPushServiceAccount } from "./widget-push.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SERVICE_ACCOUNT: WidgetPushServiceAccount = {
  projectId: "missiongo-test",
  clientEmail: "push@test.example",
  privateKey,
};

function adminAccount(): AdminAccountConfig {
  const salt = Buffer.from("missiongo-test-salt");
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    username: "owner@example.com",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
    sessionSecret: "test-session-secret-that-is-not-used-in-production",
    cookieSecure: true,
  };
}

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Let a short debounce fire and whatever it started finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/**
 * The widget's HTTP wiring (AND-150), which the service-level tests do not reach:
 * the token-registration route, and the onResponse hook that decides which API
 * calls may have changed what a widget shows. Only the two Google endpoints are
 * replaced; the account, session and summary are the real ones.
 */
describe("widget device registration and the push trigger (AND-150)", () => {
  it("registers a token, pushes when a mutation changes the summary, and stays quiet on reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-widget-routes-"));
    directories.push(directory);
    const pushed: Array<{ token: string; body: unknown }> = [];
    const app = buildApp({
      databasePath: join(directory, "missiongo.sqlite"),
      attachmentsPath: join(directory, "attachments"),
      adminAccount: adminAccount(),
      widgetPushServiceAccount: SERVICE_ACCOUNT,
      widgetPushDebounceMs: 5,
      widgetPushFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
        }
        const body = JSON.parse(String(init?.body)) as { message: { token: string } };
        pushed.push({ token: body.message.token, body });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner@example.com", password: "correct horse" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;

    // Registering the device is itself a mutation, so the device hears about the
    // summary it is about to draw.
    const register = await app.inject({
      method: "PUT",
      url: "/api/v1/widget/device",
      headers: { cookie },
      payload: { token: "device-token" },
    });
    expect(register.statusCode).toBe(200);
    await settle();
    expect(pushed.map((request) => request.token)).toEqual(["device-token"]);

    // A read changes nothing a widget shows, so it must not push.
    await app.inject({ method: "GET", url: "/api/v1/widget/summary", headers: { cookie } });
    await settle();
    expect(pushed).toHaveLength(1);

    // A ready item moves the summary's fingerprint, and the mutation pushes it.
    const product = await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie },
      payload: { name: "Mission GO", keyPrefix: "AND" },
    });
    expect(product.statusCode).toBe(201);
    const productId = product.json().id as string;
    const item = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: { productId, status: "ready", environment: { platform: "android" }, type: "task", priority: "normal", title: "title", description: "description" },
    });
    expect(item.statusCode).toBe(201);
    await settle();
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed.at(-1)).toEqual({
      token: "device-token",
      body: { message: { token: "device-token", data: { widget: "refresh" }, android: { priority: "NORMAL" } } },
    });

    // The same summary is not announced twice.
    const before = pushed.length;
    await app.inject({ method: "GET", url: "/api/v1/widget/summary", headers: { cookie } });
    await settle();
    expect(pushed).toHaveLength(before);
  });
});
