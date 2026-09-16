import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { ProductAccessEntry } from "./accounts-store.js";
import { MissionGoDatabase } from "./storage/database.js";
import { createAiAccessToken, type AdminAccountConfig } from "./admin-auth.js";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

const ADMIN_PASSWORD = "correct horse battery";
const MEMBER_PASSWORD = "a member password";

function adminAccount(overrides: Partial<AdminAccountConfig> = {}): AdminAccountConfig {
  const salt = Buffer.from("missiongo-accounts-salt");
  return {
    id: "account-test-1",
    username: "owner@example.com",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync(ADMIN_PASSWORD, salt, 64).toString("base64url")}`,
    sessionSecret: "test-session-secret-that-is-not-used-in-production",
    cookieSecure: true,
    ...overrides,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-accounts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function open(databasePath: string, account: AdminAccountConfig = adminAccount()): FastifyInstance {
  const app = buildApp({ databasePath, adminAccount: account, publicOrigin: "https://missiongo.test" });
  apps.push(app);
  return app;
}

/** An AI token for one of this deployment's accounts, as the OAuth exchange would mint it. */
function aiToken(app: FastifyInstance, config: AdminAccountConfig, accountId: string): string {
  const account = app.missionGoAccounts.getAccount(accountId);
  return createAiAccessToken(
    config,
    { id: account.id, username: account.email, role: account.role },
    app.missionGoAccounts.credentialsStamp(account),
    "mgc_test_client",
    ["missiongo:read"],
  ).token;
}

/** Call an MCP tool over the real /mcp route, the way a connected AI client would. */
async function callMcp(app: FastifyInstance, token: string, id: number, name: string, args: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  });
  const payload = response.headers["content-type"]?.includes("text/event-stream")
    ? response.body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : response.body;
  if (!payload) throw new Error(`MCP response carried no JSON payload: ${response.statusCode} ${response.body}`);
  return (JSON.parse(payload) as { result: { structuredContent?: unknown; isError?: boolean } }).result;
}

async function signIn(app: FastifyInstance, username: string, password: string): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  if (login.statusCode !== 200) throw new Error(`sign-in failed: ${login.statusCode} ${login.body}`);
  return login.headers["set-cookie"]!.split(";", 1)[0]!;
}

/** An administrator, a member, and one product each, with the member holding view on only its own. */
async function twoAccountWorkspace() {
  const app = open(join(await temporaryDirectory(), "missiongo.sqlite"));
  const adminCookie = await signIn(app, "owner@example.com", ADMIN_PASSWORD);

  const shared = (await app.inject({
    method: "POST",
    url: "/api/v1/products",
    headers: { cookie: adminCookie },
    payload: { name: "Shared", keyPrefix: "SHR" },
  })).json<{ id: string }>();
  const hidden = (await app.inject({
    method: "POST",
    url: "/api/v1/products",
    headers: { cookie: adminCookie },
    payload: { name: "Hidden", keyPrefix: "HID" },
  })).json<{ id: string }>();

  const member = (await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: { cookie: adminCookie },
    payload: { email: "member@example.com", password: MEMBER_PASSWORD, role: "member" },
  })).json<{ id: string }>();
  await app.inject({
    method: "PUT",
    url: `/api/v1/accounts/${member.id}/products`,
    headers: { cookie: adminCookie },
    payload: { permissions: [{ productId: shared.id, canView: true, canOperate: true, canUseAi: false }] },
  });

  const memberCookie = await signIn(app, "member@example.com", MEMBER_PASSWORD);
  return { app, adminCookie, memberCookie, member, shared, hidden };
}

async function createItem(app: FastifyInstance, cookie: string, productId: string, title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/items",
    headers: { cookie },
    payload: { productId, type: "task", priority: "normal", title, description: "body" },
  });
  if (response.statusCode !== 201) throw new Error(`item create failed: ${response.statusCode} ${response.body}`);
  return response.json<{ key: string }>().key;
}

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Seeding the environment administrator", () => {
  it("reuses ADMIN_ACCOUNT_ID, so the account_id already on nodes and events still resolves", async () => {
    const app = open(join(await temporaryDirectory(), "missiongo.sqlite"));
    expect(app.missionGoAccounts.listAccounts()).toMatchObject([
      { id: "account-test-1", email: "owner@example.com", role: "admin" },
    ]);
  });

  it("gives every product that already existed a creator, so it is not left ownerless", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "missiongo.sqlite");

    // A database from before accounts existed: products, and nobody recorded as
    // having made them.
    const legacy = new MissionGoDatabase(databasePath);
    legacy.connection
      .prepare("INSERT INTO products (id, key_prefix, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("product-legacy", "OLD", "Legacy", new Date().toISOString(), new Date().toISOString());
    legacy.close();

    const app = open(databasePath);
    expect(app.missionGoStore.getProduct("product-legacy")).toMatchObject({ createdByAccountId: "account-test-1" });
  });

  it("turns ADMIN_AUTHORIZED_PRODUCT_IDS into permission rows", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "missiongo.sqlite");
    const first = new MissionGoDatabase(databasePath);
    first.connection
      .prepare("INSERT INTO products (id, key_prefix, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("product-a", "AAA", "A", new Date().toISOString(), new Date().toISOString());
    first.close();

    const app = open(databasePath, adminAccount({ authorizedProductIds: ["product-a"] }));
    expect(app.missionGoAccounts.listPermissions("account-test-1")).toEqual([
      { productId: "product-a", canView: true, canOperate: true, canUseAi: true },
    ]);
  });

  it("does not put the environment's password back over one the owner changed", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "missiongo.sqlite");

    const first = open(databasePath);
    const cookie = await signIn(first, "owner@example.com", ADMIN_PASSWORD);
    const changed = await first.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: "a replacement password" },
    });
    expect(changed.statusCode).toBe(200);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    // Restarting the server re-runs the seed. It must find an account already
    // there and leave it alone, or a password change would survive exactly
    // until the next deploy.
    const second = open(databasePath);
    await expect(signIn(second, "owner@example.com", "a replacement password")).resolves.toBeTruthy();
    const stale = await second.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner@example.com", password: ADMIN_PASSWORD },
    });
    expect(stale.statusCode).toBe(401);
  });
});

describe("Signing in and changing a password", () => {
  it("signs in by email address, case-insensitively", async () => {
    const app = open(join(await temporaryDirectory(), "missiongo.sqlite"));
    await expect(signIn(app, "Owner@Example.COM", ADMIN_PASSWORD)).resolves.toBeTruthy();
  });

  it("gives the same answer for a wrong password, an unknown address and a suspended account", async () => {
    const { app, adminCookie, member } = await twoAccountWorkspace();
    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });

    const attempts = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner@example.com", password: "wrong" } }),
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "nobody@example.com", password: "wrong" } }),
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "member@example.com", password: MEMBER_PASSWORD } }),
    ]);
    for (const attempt of attempts) {
      expect(attempt.statusCode).toBe(401);
      expect(attempt.json()).toMatchObject({ code: "invalid_credentials" });
    }
  });

  it("refuses to change a password without the current one", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: memberCookie },
      payload: { currentPassword: "not the password", newPassword: "a brand new password" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("signs out every other session when the password changes, and keeps the one that changed it", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const otherBrowser = await signIn(app, "member@example.com", MEMBER_PASSWORD);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: memberCookie },
      payload: { currentPassword: MEMBER_PASSWORD, newPassword: "a brand new password" },
    });
    expect(changed.statusCode).toBe(200);
    const refreshed = changed.headers["set-cookie"]!.split(";", 1)[0]!;

    // The signature on the old cookie is still valid; what refuses it is the
    // accounts table, which now says the credentials moved on after it was
    // issued. This is the sessions table's job, done without a sessions table.
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: otherBrowser } })).statusCode)
      .toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: refreshed } })).statusCode)
      .toBe(200);
  });

  it("stops a suspended account's existing session immediately", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: memberCookie } })).statusCode)
      .toBe(200);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: memberCookie } })).statusCode)
      .toBe(401);
  });

  it("stops a deleted account's existing session immediately", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    await app.inject({ method: "DELETE", url: `/api/v1/accounts/${member.id}`, headers: { cookie: adminCookie } });
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: memberCookie } })).statusCode)
      .toBe(401);
  });

  it("refuses a password too short to be worth having", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: memberCookie },
      payload: { currentPassword: MEMBER_PASSWORD, newPassword: "short" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("Managing accounts", () => {
  it("is invisible to a member, who is told there is nothing there rather than that they may not look", async () => {
    const { app, memberCookie, member } = await twoAccountWorkspace();
    for (const request of [
      { method: "GET" as const, url: "/api/v1/accounts" },
      { method: "POST" as const, url: "/api/v1/accounts" },
      { method: "PATCH" as const, url: `/api/v1/accounts/${member.id}` },
      { method: "DELETE" as const, url: `/api/v1/accounts/${member.id}` },
      { method: "PUT" as const, url: `/api/v1/accounts/${member.id}/products` },
    ]) {
      const response = await app.inject({ ...request, headers: { cookie: memberCookie }, payload: {} });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });

  it("refuses a second account on the same address", async () => {
    const { app, adminCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: { cookie: adminCookie },
      payload: { email: "MEMBER@example.com", password: "another long password", role: "member" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "account_email_conflict" });
  });

  it("refuses to open an account on a password shorter than the minimum", async () => {
    const { app, adminCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: { cookie: adminCookie },
      payload: { email: "new@example.com", password: "short", role: "member" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to remove or demote the last administrator, which would lock everyone out of management", async () => {
    const { app, adminCookie } = await twoAccountWorkspace();
    const admin = app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!;
    const demoted = await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "member" },
    });
    expect(demoted.statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/accounts/${admin.id}`, headers: { cookie: adminCookie } })).statusCode)
      .toBe(409);
  });

  it("replaces the whole permission set, so an unticked product is actually revoked", async () => {
    const { app, adminCookie, memberCookie, member, shared } = await twoAccountWorkspace();
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toHaveLength(1);

    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [] },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toEqual([]);
    expect(app.missionGoAccounts.listPermissions(member.id)).toEqual([]);
    expect(shared.id).toBeTruthy();
  });

  it("stores operate and AI as implying view, so a row never says 'may edit but may not see'", async () => {
    const { app, adminCookie, member, hidden } = await twoAccountWorkspace();
    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: hidden.id, canView: false, canOperate: true, canUseAi: false }] },
    });
    expect(app.missionGoAccounts.listPermissions(member.id)).toEqual([
      { productId: hidden.id, canView: true, canOperate: true, canUseAi: false },
    ]);
  });

  it("refuses a permission naming a product that does not exist", async () => {
    const { app, adminCookie, member } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: "no-such-product", canView: true, canOperate: false, canUseAi: false }] },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("What a member can reach", () => {
  it("lists only the products it holds, in both /products and /bootstrap", async () => {
    const { app, memberCookie, shared } = await twoAccountWorkspace();
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toMatchObject([{ id: shared.id }]);
    expect((await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { cookie: memberCookie } })).json())
      .toMatchObject({ products: [{ id: shared.id }], productId: shared.id });
  });

  it("answers 404, not 403, for a product it does not hold", async () => {
    const { app, memberCookie, hidden } = await twoAccountWorkspace();
    // 403 would confirm the product exists, which is the fact being withheld.
    for (const url of [
      `/api/v1/products/${hidden.id}/components`,
      `/api/v1/products/${hidden.id}/icon`,
      `/api/v1/items?productId=${hidden.id}`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("cannot read or edit an item in a product it does not hold, and is told nothing about it", async () => {
    const { app, adminCookie, memberCookie, hidden } = await twoAccountWorkspace();
    const itemKey = await createItem(app, adminCookie, hidden.id, "Must stay private");

    const read = await app.inject({ method: "GET", url: `/api/v1/items/${itemKey}`, headers: { cookie: memberCookie } });
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain("Must stay private");

    for (const request of [
      { method: "PATCH" as const, url: `/api/v1/items/${itemKey}`, payload: { title: "Renamed" } },
      { method: "GET" as const, url: `/api/v1/items/${itemKey}/timeline`, payload: undefined },
      { method: "GET" as const, url: `/api/v1/items/${itemKey}/comments`, payload: undefined },
      { method: "POST" as const, url: `/api/v1/items/${itemKey}/comments`, payload: { text: "hello" } },
      { method: "GET" as const, url: `/api/v1/items/${itemKey}/attachments`, payload: undefined },
      { method: "POST" as const, url: `/api/v1/items/${itemKey}/transitions`, payload: { to: "ready", reason: "ready" } },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { cookie: memberCookie },
        ...(request.payload ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }

    // And the item is untouched.
    expect((await app.inject({ method: "GET", url: `/api/v1/items/${itemKey}`, headers: { cookie: adminCookie } })).json())
      .toMatchObject({ title: "Must stay private" });
  });

  it("works normally in a product it does hold", async () => {
    const { app, memberCookie, shared } = await twoAccountWorkspace();
    const itemKey = await createItem(app, memberCookie, shared.id, "Member's own work");
    expect((await app.inject({ method: "GET", url: `/api/v1/items/${itemKey}`, headers: { cookie: memberCookie } })).json())
      .toMatchObject({ title: "Member's own work" });
  });

  it("cannot create an item in a product it does not hold", async () => {
    const { app, memberCookie, hidden } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie: memberCookie },
      payload: { productId: hidden.id, type: "task", priority: "normal", title: "Smuggled", description: "body" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("sees only the SDK tokens of products it holds, and cannot revoke the others", async () => {
    const { app, adminCookie, memberCookie, shared, hidden } = await twoAccountWorkspace();
    for (const productId of [shared.id, hidden.id]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/sdk-tokens",
        headers: { cookie: adminCookie },
        payload: { name: `${productId} token`, productId },
      });
    }
    const visible = (await app.inject({ method: "GET", url: "/api/v1/sdk-tokens", headers: { cookie: memberCookie } }))
      .json<Array<{ id: string; productId: string }>>();
    expect(visible).toHaveLength(1);
    expect(visible[0]!.productId).toBe(shared.id);

    const all = (await app.inject({ method: "GET", url: "/api/v1/sdk-tokens", headers: { cookie: adminCookie } }))
      .json<Array<{ id: string; productId: string }>>();
    const hiddenToken = all.find((token) => token.productId === hidden.id)!;
    expect((await app.inject({ method: "DELETE", url: `/api/v1/sdk-tokens/${hiddenToken.id}`, headers: { cookie: memberCookie } })).statusCode)
      .toBe(404);
  });

  it("cannot dispatch an item it cannot operate on, and the batch is refused whole", async () => {
    const { app, adminCookie, memberCookie, shared, hidden } = await twoAccountWorkspace();
    const mine = await createItem(app, memberCookie, shared.id, "Mine");
    const theirs = await createItem(app, adminCookie, hidden.id, "Theirs");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie: memberCookie },
      payload: { nodeId: "any", agentKind: "claude_code", mode: "plan", itemKeys: [mine, theirs] },
    });
    // Refused for the item, before a node is even looked up, so a mixed batch
    // cannot dispatch its reachable half.
    expect(response.statusCode).toBe(404);
  });
});

describe("Products a member creates", () => {
  it("are theirs immediately: visible, editable, and archivable", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: memberCookie },
      payload: { name: "Member's product", keyPrefix: "MEM" },
    });
    expect(created.statusCode).toBe(201);
    const product = created.json<{ id: string }>();

    // Without the creator grant this would 404 on the very next request, which
    // looks exactly like the creation having failed.
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toHaveLength(2);
    expect((await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}`,
      headers: { cookie: memberCookie },
      payload: { archived: true },
    })).statusCode).toBe(200);
  });

  it("does not let a member archive a product someone shared with them", async () => {
    const { app, memberCookie, shared } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${shared.id}`,
      headers: { cookie: memberCookie },
      payload: { archived: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "product_not_owned" });
  });

  it("still lets a member rename a product shared with them", async () => {
    const { app, memberCookie, shared } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${shared.id}`,
      headers: { cookie: memberCookie },
      payload: { name: "Renamed by a collaborator" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("lets an administrator archive anything, including a member's product", async () => {
    const { app, adminCookie, memberCookie } = await twoAccountWorkspace();
    const product = (await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: memberCookie },
      payload: { name: "Member's product", keyPrefix: "MEM" },
    })).json<{ id: string }>();
    expect((await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}`,
      headers: { cookie: adminCookie },
      payload: { archived: true },
    })).statusCode).toBe(200);
  });
});

describe("What an AI client reaches", () => {
  it("loses a product the moment it is unticked, without waiting for the token to expire", async () => {
    // The reason product reach is not written into the token. A 30-day token that
    // froze its own permissions would keep reading a revoked product for 30 days.
    const { app, adminCookie, member, shared } = await twoAccountWorkspace();
    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: shared.id, canView: true, canOperate: true, canUseAi: true }] },
    });
    const token = aiToken(app, adminAccount(), member.id);

    expect((await callMcp(app, token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [shared.id] } });
    expect((await callMcp(app, token, 2, "list_products")).structuredContent)
      .toMatchObject({ products: [{ id: shared.id }] });

    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: shared.id, canView: true, canOperate: true, canUseAi: false }] },
    });

    // Same token, no re-authorization.
    expect((await callMcp(app, token, 3, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [] } });
    expect((await callMcp(app, token, 4, "list_products")).structuredContent).toMatchObject({ products: [] });
  });

  it("reaches only what the account that authorized it reaches, not what an administrator would", async () => {
    const { app, adminCookie, member, shared, hidden } = await twoAccountWorkspace();
    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: shared.id, canView: true, canOperate: true, canUseAi: true }] },
    });
    const itemKey = await createItem(app, adminCookie, hidden.id, "Must stay private");

    const forbidden = await callMcp(app, aiToken(app, adminAccount(), member.id), 1, "get_item_context", { itemKey });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).not.toContain("Must stay private");
  });

  it("keeps an administrator's full reach when they create a product", async () => {
    // An administrator with no can_use_ai rows reaches every product; one with
    // rows is bounded by them. Recording the creator as a permission row would
    // therefore narrow an administrator's AI to "products I made myself" the
    // first time they made one -- silently, and after the fact for everything
    // that already existed.
    const { app, adminCookie, shared, hidden } = await twoAccountWorkspace();
    const adminId = app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!.id;
    expect(app.missionGoAccounts.listPermissions(adminId)).toEqual([]);

    const token = aiToken(app, adminAccount(), adminId);
    expect((await callMcp(app, token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: true } });
    expect((await callMcp(app, token, 2, "list_products")).structuredContent)
      .toMatchObject({ products: [{ id: hidden.id }, { id: shared.id }] });

    await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: adminCookie },
      payload: { name: "One more", keyPrefix: "ONE" },
    });
    expect(app.missionGoAccounts.listPermissions(adminId)).toEqual([]);
    expect((await callMcp(app, token, 3, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: true } });
  });

  it("stops working when the account is suspended", async () => {
    const { app, adminCookie, member } = await twoAccountWorkspace();
    const token = aiToken(app, adminAccount(), member.id);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_account", arguments: {} } },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("Dispatch configuration per account (item 2.3)", () => {
  /** Register a Mac the way the macOS client does: an AI login carrying the node scope. */
  async function registerNode(app: FastifyInstance, accountId: string, name: string) {
    const account = app.missionGoAccounts.getAccount(accountId);
    const token = createAiAccessToken(
      adminAccount(),
      { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account),
      "mgc_macos_test",
      ["missiongo:read", "missiongo:node"],
    ).token;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/node/register",
      headers: { authorization: `Bearer ${token}` },
      payload: { installationId: `installation-${accountId}`, name, hostname: "test-host" },
    });
    if (response.statusCode !== 201) throw new Error(`register failed: ${response.statusCode} ${response.body}`);
    return response.json<{ nodeId: string; token: string }>();
  }

  it("keeps one account's machines invisible to the other, including to an administrator", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    const adminId = app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!.id;

    await registerNode(app, adminId, "Admin's Mac");
    await registerNode(app, member.id, "Member's Mac");

    const seenBy = async (cookie: string) =>
      (await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } }))
        .json<{ nodes: Array<{ name: string }> }>().nodes.map((node) => node.name);

    // Machines belong to the account that registered them. The administrator
    // role reaches every product; it does not reach another person's Macs.
    expect(await seenBy(adminCookie)).toEqual(["Admin's Mac"]);
    expect(await seenBy(memberCookie)).toEqual(["Member's Mac"]);
  });

  it("refuses to let one account revoke or rename another account's machine", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    const memberNode = await registerNode(app, member.id, "Member's Mac");

    for (const request of [
      { method: "PATCH" as const, url: `/api/v1/nodes/${memberNode.nodeId}`, payload: { nickname: "Taken over" } },
      { method: "DELETE" as const, url: `/api/v1/nodes/${memberNode.nodeId}`, payload: undefined },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { cookie: adminCookie },
        ...(request.payload ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }

    // Still there, still called what its owner calls it.
    expect((await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie: memberCookie } }))
      .json<{ nodes: Array<{ name: string }> }>().nodes).toMatchObject([{ name: "Member's Mac" }]);
  });

  it("offers a machine only the products its owning account reaches", async () => {
    const { app, member, shared } = await twoAccountWorkspace();
    const node = await registerNode(app, member.id, "Member's Mac");

    // The client draws its product menu from the heartbeat. An unfiltered list
    // would name the administrator's other products on a member's Mac.
    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/v1/node/heartbeat",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { agents: [{ kind: "claude_code", version: "2.1.232" }], repoCandidates: [] },
    });
    expect(heartbeat.json<{ products: Array<{ id: string }> }>().products).toMatchObject([{ id: shared.id }]);
  });

  it("refuses to map a machine's checkout to a product its owner cannot reach", async () => {
    const { app, member, hidden } = await twoAccountWorkspace();
    const node = await registerNode(app, member.id, "Member's Mac");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/node/repos",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { repos: [{ productId: hidden.id, repoPath: "/Users/dev/Projects/hidden" }] },
    });
    expect(response.statusCode).toBe(404);
  });

  it("cuts a machine off when its account is disabled, instead of handing it every product", async () => {
    const { app, adminCookie, member } = await twoAccountWorkspace();
    const node = await registerNode(app, member.id, "Member's Mac");
    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });

    // The heartbeat used to fall back to every product on the deployment when
    // the owning account could not be found, and queued work could still be
    // pulled. A machine acts for its account; with the account gone, so is it.
    const authorization = { authorization: `Bearer ${node.token}` };
    for (const request of [
      { method: "POST" as const, url: "/api/v1/node/heartbeat", payload: { agents: [], repoCandidates: [] } },
      { method: "GET" as const, url: "/api/v1/node/me", payload: undefined },
      { method: "POST" as const, url: "/api/v1/node/dispatches/claim-next", payload: {} },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: authorization,
        ...(request.payload ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
    }
  });

  it("keeps saving after a mapped product is taken away, and keeps that product's mapping", async () => {
    const { app, adminCookie, memberCookie, member, shared, hidden } = await twoAccountWorkspace();
    const grant = (productIds: readonly string[]) => app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${member.id}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: productIds.map((productId) => ({ productId, canView: true, canOperate: true, canUseAi: false })) },
    });
    await grant([shared.id, hidden.id]);
    const node = await registerNode(app, member.id, "Member's Mac");
    const save = (repos: ReadonlyArray<{ productId: string; repoPath: string }>) => app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie: memberCookie },
      payload: { repos },
    });
    const mappings = async () => (await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie: memberCookie } }))
      .json<{ nodes: Array<{ repos: Array<{ productId: string; repoPath: string }> }> }>().nodes[0]!.repos;

    expect((await save([
      { productId: shared.id, repoPath: "/Users/dev/shared" },
      { productId: hidden.id, repoPath: "/Users/dev/hidden" },
    ])).statusCode).toBe(200);

    await grant([shared.id]);
    // The product it lost is no longer named to it...
    expect(await mappings()).toEqual([expect.objectContaining({ productId: shared.id })]);
    // ...so a save carries only what it can see, and that has to succeed. It
    // used to have to send every saved row back, and the hidden one was a 404.
    expect((await save([{ productId: shared.id, repoPath: "/Users/dev/shared-2" }])).statusCode).toBe(200);

    // Nobody asked to unmap the product it could not see: given back, it is still there.
    await grant([shared.id, hidden.id]);
    expect(await mappings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: shared.id, repoPath: "/Users/dev/shared-2" }),
      expect.objectContaining({ productId: hidden.id, repoPath: "/Users/dev/hidden" }),
    ]));
  });
});

describe("Changing a sign-in address", () => {
  it("lets an account change its own, with the current password", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email",
      headers: { cookie: memberCookie },
      payload: { currentPassword: MEMBER_PASSWORD, email: "moved@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { username: "moved@example.com" } });
    await expect(signIn(app, "moved@example.com", MEMBER_PASSWORD)).resolves.toBeTruthy();
  });

  it("refuses without the current password, so a borrowed browser cannot take the account over", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email",
      headers: { cookie: memberCookie },
      payload: { currentPassword: "not the password", email: "attacker@example.com" },
    });
    expect(response.statusCode).toBe(401);
    await expect(signIn(app, "member@example.com", MEMBER_PASSWORD)).resolves.toBeTruthy();
  });

  it("keeps other sessions signed in: an address is an identifier, not a secret", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const otherBrowser = await signIn(app, "member@example.com", MEMBER_PASSWORD);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/email",
      headers: { cookie: memberCookie },
      payload: { currentPassword: MEMBER_PASSWORD, email: "moved@example.com" },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: otherBrowser } })).statusCode)
      .toBe(200);
  });

  it("refuses an address that is not one, and one another account already has", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/auth/email",
      headers: { cookie: memberCookie },
      payload: { currentPassword: MEMBER_PASSWORD, email: "liangguosheng" },
    })).statusCode).toBe(400);

    expect((await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { email: "owner@example.com" },
    })).statusCode).toBe(409);
  });

  it("lets an administrator correct someone else's address", async () => {
    // How a deployment seeded before addresses were required gets out of it:
    // the bootstrap account keeps whatever ADMIN_USERNAME said, and until now
    // nothing could change it.
    const { app, adminCookie, member } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { email: "corrected@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: "corrected@example.com" });
    await expect(signIn(app, "corrected@example.com", MEMBER_PASSWORD)).resolves.toBeTruthy();
  });
});

describe("Nicknames", () => {
  const setNickname = (app: FastifyInstance, cookie: string, nickname: string | null) =>
    app.inject({ method: "POST", url: "/api/v1/auth/nickname", headers: { cookie }, payload: { nickname } });
  const session = (app: FastifyInstance, cookie: string) =>
    app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });

  it("lets an account name itself, with no password asked for", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const response = await setNickname(app, memberCookie, "  阿亮  ");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { username: "member@example.com", displayName: "阿亮", nickname: "阿亮" } });
    expect((await session(app, memberCookie)).json()).toMatchObject({ user: { displayName: "阿亮" } });
  });

  it("keeps every other session signed in: a name is not a credential", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    const otherBrowser = await signIn(app, "member@example.com", MEMBER_PASSWORD);
    await setNickname(app, memberCookie, "阿亮");
    expect((await session(app, otherBrowser)).statusCode).toBe(200);
  });

  it("falls back to the address when there is no nickname, and clearing puts it back", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    expect((await session(app, memberCookie)).json()).toMatchObject({ user: { displayName: "member" } });

    await setNickname(app, memberCookie, "阿亮");
    for (const cleared of [null, "", "   "]) {
      const response = await setNickname(app, memberCookie, cleared);
      expect(response.statusCode).toBe(200);
      // The raw value is gone rather than stored empty, so the settings field
      // shows a placeholder instead of a name the owner never chose.
      expect(response.json().user).not.toHaveProperty("nickname");
      expect(response.json()).toMatchObject({ user: { displayName: "member" } });
      await setNickname(app, memberCookie, "阿亮");
    }
  });

  it("refuses a name that would not fit on one line", async () => {
    const { app, memberCookie } = await twoAccountWorkspace();
    expect((await setNickname(app, memberCookie, "x".repeat(41))).statusCode).toBe(400);
    expect((await setNickname(app, memberCookie, "two\u0000words")).statusCode).toBe(400);
    expect((await setNickname(app, memberCookie, 42 as unknown as string)).statusCode).toBe(400);
    // Folded rather than refused: a byline sits next to a timestamp.
    expect((await setNickname(app, memberCookie, "阿  亮")).json()).toMatchObject({ user: { displayName: "阿 亮" } });
  });

  it("lets two accounts answer to the same name", async () => {
    // The address is the identity. Taking somebody's nickname takes nothing.
    const { app, adminCookie, memberCookie } = await twoAccountWorkspace();
    expect((await setNickname(app, memberCookie, "小郭")).statusCode).toBe(200);
    expect((await setNickname(app, adminCookie, "小郭")).statusCode).toBe(200);
  });

  it("lets an administrator correct someone else's, without signing them out", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { nickname: "阿亮" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nickname: "阿亮" });
    expect((await session(app, memberCookie)).statusCode).toBe(200);
    expect((await session(app, memberCookie)).json()).toMatchObject({ user: { displayName: "阿亮" } });
  });

  it("signs every browser-written item and attachment event with the nickname", async () => {
    const { app, adminCookie, memberCookie, member, shared } = await twoAccountWorkspace();
    await setNickname(app, memberCookie, "阿亮");
    const key = await createItem(app, memberCookie, shared.id, "Sync stalls");
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/items/${key}`,
      headers: { cookie: memberCookie },
      payload: { title: "Sync stalls again" },
    });
    expect(edit.statusCode).toBe(200);
    const attachmentHeaders = {
      cookie: memberCookie,
      "content-type": "application/octet-stream",
      "x-missiongo-filename": "note.txt",
      "x-missiongo-content-type": "text/plain",
    };
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/items/${key}/attachments`,
      headers: attachmentHeaders,
      payload: Buffer.from("first"),
    });
    expect(added.statusCode).toBe(201);
    const attachmentId = added.json<{ id: string }>().id;
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/v1/items/${key}/attachments/${attachmentId}/content`,
      headers: attachmentHeaders,
      payload: Buffer.from("second"),
    });
    expect(replaced.statusCode).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/items/${key}/attachments/${attachmentId}`,
      headers: { cookie: memberCookie },
    });
    expect(removed.statusCode).toBe(204);
    await app.inject({
      method: "POST",
      url: `/api/v1/items/${key}/comments`,
      headers: { cookie: memberCookie },
      payload: { text: "Reproduced on the second launch." },
    });

    const comments = (await app.inject({ method: "GET", url: `/api/v1/items/${key}/comments`, headers: { cookie: memberCookie } }))
      .json<{ comments: Array<{ accountName?: string }> }>().comments;
    expect(comments.at(-1)).toMatchObject({ accountName: "阿亮" });

    const events = (await app.inject({ method: "GET", url: `/api/v1/items/${key}/timeline`, headers: { cookie: adminCookie } }))
      .json<{ events: Array<{ eventType: string; actorKind: string; accountId?: string; accountName?: string }> }>().events;
    for (const eventType of ["item_created", "item_updated", "attachment_added", "attachment_replaced", "attachment_removed", "comment_added"]) {
      expect(events.find((event) => event.eventType === eventType)).toMatchObject({
        actorKind: "human", accountId: member.id, accountName: "阿亮",
      });
    }
  });

  it("still names a suspended account, because the question is who wrote it", async () => {
    const { app, adminCookie, memberCookie, member, shared } = await twoAccountWorkspace();
    await setNickname(app, memberCookie, "阿亮");
    const key = await createItem(app, adminCookie, shared.id, "Sync stalls");
    await app.inject({
      method: "POST",
      url: `/api/v1/items/${key}/comments`,
      headers: { cookie: memberCookie },
      payload: { text: "Reproduced on the second launch." },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });

    const events = (await app.inject({ method: "GET", url: `/api/v1/items/${key}/timeline`, headers: { cookie: adminCookie } }))
      .json<{ events: Array<{ eventType: string; accountName?: string }> }>().events;
    expect(events.find((event) => event.eventType === "comment_added")).toMatchObject({ accountName: "阿亮" });
  });
});

describe("Listing and revoking AI authorizations", () => {
  /** Mint a token and record it, the way the OAuth exchange does. */
  function authorize(app: FastifyInstance, accountId: string, clientId = "mgc_test_client") {
    const account = app.missionGoAccounts.getAccount(accountId);
    const issued = createAiAccessToken(
      adminAccount(),
      { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account),
      clientId,
      ["missiongo:read"],
    );
    app.missionGoAccounts.recordAiAuthorization({
      tokenId: issued.claims.tokenId,
      accountId: account.id,
      clientId,
      scopes: issued.claims.scopes,
      issuedAt: issued.claims.issuedAt,
      expiresAt: issued.claims.expiresAt,
    });
    return issued;
  }

  it("lists what is connected, and revoking one leaves the others working", async () => {
    const { app, memberCookie, member } = await twoAccountWorkspace();
    const first = authorize(app, member.id, "mgc_first");
    const second = authorize(app, member.id, "mgc_second");

    const listed = (await app.inject({ method: "GET", url: "/api/v1/ai-authorizations", headers: { cookie: memberCookie } }))
      .json<{ authorizations: Array<{ id: string; clientId: string }> }>().authorizations;
    expect(listed.map((entry) => entry.clientId).sort()).toEqual(["mgc_first", "mgc_second"]);

    expect((await app.inject({
      method: "DELETE",
      url: `/api/v1/ai-authorizations/${first.claims.tokenId}`,
      headers: { cookie: memberCookie },
    })).statusCode).toBe(204);

    // This is the whole point: one client cut off, the rest untouched. Before
    // this the only lever was the account password, which stopped all of them.
    expect((await callMcp(app, second.token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ account: { id: member.id } });
    const refused = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_account", arguments: {} } },
    });
    expect(refused.statusCode).toBe(401);
  });

  it("drops a revoked authorization out of the list", async () => {
    const { app, memberCookie, member } = await twoAccountWorkspace();
    const issued = authorize(app, member.id);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/ai-authorizations/${issued.claims.tokenId}`,
      headers: { cookie: memberCookie },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/ai-authorizations", headers: { cookie: memberCookie } })).json())
      .toEqual({ authorizations: [] });
  });

  it("shows an account only its own, and refuses to revoke another account's", async () => {
    const { app, adminCookie, memberCookie, member } = await twoAccountWorkspace();
    const adminId = app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!.id;
    const memberAuthorization = authorize(app, member.id, "mgc_member_client");
    authorize(app, adminId, "mgc_admin_client");

    expect((await app.inject({ method: "GET", url: "/api/v1/ai-authorizations", headers: { cookie: memberCookie } }))
      .json<{ authorizations: Array<{ clientId: string }> }>().authorizations.map((e) => e.clientId))
      .toEqual(["mgc_member_client"]);

    // An administrator manages accounts; an authorization is a credential its
    // owner granted. Suspending the account is the administrator's lever.
    expect((await app.inject({
      method: "DELETE",
      url: `/api/v1/ai-authorizations/${memberAuthorization.claims.tokenId}`,
      headers: { cookie: adminCookie },
    })).statusCode).toBe(404);
  });

  it("does not refuse a token minted before the table existed", async () => {
    // Shipping revocation must not itself revoke everything. A token with no
    // record stays valid until it expires.
    const { app, member } = await twoAccountWorkspace();
    const account = app.missionGoAccounts.getAccount(member.id);
    const unrecorded = createAiAccessToken(
      adminAccount(),
      { id: account.id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account),
      "mgc_legacy_client",
      ["missiongo:read"],
    );
    expect((await callMcp(app, unrecorded.token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ account: { id: member.id } });
    // It simply has nothing to list or revoke.
    expect(app.missionGoAccounts.listAiAuthorizations(member.id)).toEqual([]);
  });

  it("records when an authorization was last used, without writing on every call", async () => {
    const { app, memberCookie, member } = await twoAccountWorkspace();
    const issued = authorize(app, member.id);
    const read = async () =>
      (await app.inject({ method: "GET", url: "/api/v1/ai-authorizations", headers: { cookie: memberCookie } }))
        .json<{ authorizations: Array<{ lastUsedAt?: string }> }>().authorizations[0]!;

    expect((await read()).lastUsedAt).toBeUndefined();
    await callMcp(app, issued.token, 1, "get_current_account");
    const first = (await read()).lastUsedAt;
    expect(first).toBeTruthy();

    // A second call inside the interval must not move it, or every MCP read
    // would carry a database write for a field nobody needs to the second.
    await callMcp(app, issued.token, 2, "get_current_account");
    expect((await read()).lastUsedAt).toBe(first);
  });
});

describe("Setting permissions from the product's side (item 2.2)", () => {
  it("lists every account against one product, marking the ones that reach it by role", async () => {
    const { app, adminCookie, member, shared } = await twoAccountWorkspace();
    const listed = (await app.inject({
      method: "GET",
      url: `/api/v1/products/${shared.id}/accounts`,
      headers: { cookie: adminCookie },
    })).json<{ accounts: Array<{ account: { email: string; role: string }; permission: { canView: boolean }; reachesByRole: boolean }> }>().accounts;

    // An administrator that holds no row still reaches the product. Leaving it
    // off the list would make the list lie about who can open this product.
    expect(listed.find((entry) => entry.account.role === "admin")).toMatchObject({
      reachesByRole: true,
      permission: { canView: false },
    });
    expect(listed.find((entry) => entry.account.id === member.id)).toMatchObject({
      reachesByRole: false,
      permission: { canView: true, canOperate: true, canUseAi: false },
    });
  });

  it("grants and revokes from this side, and the account side agrees", async () => {
    const { app, adminCookie, memberCookie, member, hidden } = await twoAccountWorkspace();
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toHaveLength(1);

    await app.inject({
      method: "PUT",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: adminCookie },
      payload: { accounts: [{ accountId: member.id, canView: true, canOperate: false, canUseAi: false }] },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toHaveLength(2);
    expect(app.missionGoAccounts.listPermissions(member.id).find((entry) => entry.productId === hidden.id))
      .toMatchObject({ canView: true, canOperate: false });

    await app.inject({
      method: "PUT",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: adminCookie },
      payload: { accounts: [{ accountId: member.id, canView: false, canOperate: false, canUseAi: false }] },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: memberCookie } })).json())
      .toHaveLength(1);
  });

  it("leaves an account's other products alone, which the account-side editor does not", async () => {
    // The two editors replace different things on purpose. From a product you
    // cannot see what else an account holds, so replacing its whole set here
    // would revoke permissions that were never on screen.
    const { app, adminCookie, member, shared, hidden } = await twoAccountWorkspace();
    await app.inject({
      method: "PUT",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: adminCookie },
      payload: { accounts: [{ accountId: member.id, canView: true, canOperate: false, canUseAi: false }] },
    });
    const held = app.missionGoAccounts.listPermissions(member.id).map((entry) => entry.productId).sort();
    expect(held).toEqual([shared.id, hidden.id].sort());
  });

  it("stores operate and AI as implying view here too", async () => {
    const { app, adminCookie, member, hidden } = await twoAccountWorkspace();
    await app.inject({
      method: "PUT",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: adminCookie },
      payload: { accounts: [{ accountId: member.id, canView: false, canOperate: false, canUseAi: true }] },
    });
    expect(app.missionGoAccounts.listPermissions(member.id).find((entry) => entry.productId === hidden.id))
      .toMatchObject({ canView: true, canOperate: false, canUseAi: true });
  });

  // AND-58 opened these two routes to a product's creator, which splits the one
  // refusal a member used to get into two: 404 for a product they cannot see at
  // all, 403 for one they can see but did not create. The 404 is what keeps the
  // 403 from confirming that a product they were not allowed to know about
  // exists.
  it("refuses a member the product side of a product shared with them, without hiding that it exists", async () => {
    const { app, memberCookie, shared } = await twoAccountWorkspace();
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/products/${shared.id}/accounts`,
      headers: { cookie: memberCookie },
    });
    expect(listed.statusCode).toBe(403);
    expect(listed.json()).toMatchObject({ code: "product_not_owned" });
    const written = await app.inject({
      method: "PUT",
      url: `/api/v1/products/${shared.id}/accounts`,
      headers: { cookie: memberCookie },
      payload: { accounts: [] },
    });
    expect(written.statusCode).toBe(403);
    expect(written.json()).toMatchObject({ code: "product_not_owned" });
  });

  it("answers a member 404 for a product they hold nothing on, rather than 403", async () => {
    // 403 here would say "this product is not yours", which tells them it is
    // somebody's -- the one thing a product they cannot see must not reveal.
    const { app, memberCookie, hidden } = await twoAccountWorkspace();
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: memberCookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/products/${hidden.id}/accounts`,
      headers: { cookie: memberCookie },
      payload: { accounts: [] },
    })).statusCode).toBe(404);
  });

  it("refuses an unknown product or account", async () => {
    const { app, adminCookie, member, shared } = await twoAccountWorkspace();
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/products/no-such-product/accounts",
      headers: { cookie: adminCookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/products/${shared.id}/accounts`,
      headers: { cookie: adminCookie },
      payload: { accounts: [{ accountId: "no-such-account", canView: true, canOperate: false, canUseAi: false }] },
    })).statusCode).toBe(404);
    expect(member.id).toBeTruthy();
  });
});

/**
 * AND-58: a product's creator delegates access to it, not only an administrator.
 *
 * The creator's own reach comes from grantCreatorPermissions, so these read and
 * write through a product the member made, not one that was shared with them.
 */
describe("Delegating product access to its creator (AND-58)", () => {
  async function creatorWorkspace() {
    const base = await twoAccountWorkspace();
    const owned = (await base.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: base.memberCookie },
      payload: { name: "Member's own", keyPrefix: "OWN" },
    })).json<{ id: string }>();
    const outsider = (await base.app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: { cookie: base.adminCookie },
      payload: { email: "outsider@example.com", password: MEMBER_PASSWORD, role: "member" },
    })).json<{ id: string }>();
    const adminId = base.app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!.id;
    return { ...base, owned, outsider, adminId };
  }

  const listFor = async (app: FastifyInstance, cookie: string, productId: string) =>
    (await app.inject({ method: "GET", url: `/api/v1/products/${productId}/accounts`, headers: { cookie } }))
      .json<{ accounts: ProductAccessEntry[] }>().accounts;

  const save = (app: FastifyInstance, cookie: string, productId: string, accounts: unknown[]) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/products/${productId}/accounts`,
      headers: { cookie },
      payload: { accounts },
    });

  it("lets the creator read the product side of a product they made", async () => {
    const { app, memberCookie, owned } = await creatorWorkspace();
    const listed = await listFor(app, memberCookie, owned.id);
    expect(listed.find((entry) => entry.account.email === "member@example.com")?.permission)
      .toMatchObject({ canView: true, canOperate: true, canUseAi: true });
  });

  it("shows the creator only who holds something, plus the administrators", async () => {
    // The roster itself stays an administrator's to know: app.ts answers a member
    // asking who else has an account here with "there is nothing here". Listing
    // every account from the product side would hand that same roster to anyone
    // who made a product. Administrators stay because they do reach it, and
    // because they are who a member asks for a new account.
    const { app, memberCookie, adminCookie, owned } = await creatorWorkspace();
    const emails = (await listFor(app, memberCookie, owned.id)).map((entry) => entry.account.email).sort();
    expect(emails).toEqual(["member@example.com", "owner@example.com"]);

    // Same product, same relation, read by an administrator: everyone.
    expect((await listFor(app, adminCookie, owned.id)).map((entry) => entry.account.email).sort())
      .toEqual(["member@example.com", "outsider@example.com", "owner@example.com"]);
  });

  it("does not tell the creator when anyone else last changed their password", async () => {
    // Narrowing which rows a member sees while still sending
    // credentialsChangedAt would give away what the narrowing was for.
    const { app, memberCookie, owned } = await creatorWorkspace();
    for (const entry of await listFor(app, memberCookie, owned.id)) {
      expect(Object.keys(entry.account).sort()).toEqual(["email", "id", "role"]);
    }
  });

  it("returns the same narrowed list from a save as from a read", async () => {
    // The PUT answers with the list too. If only the GET narrowed it, one save
    // would hand back the whole roster and the decision above would be worth
    // nothing.
    const { app, memberCookie, owned, outsider } = await creatorWorkspace();
    const saved = await save(app, memberCookie, owned.id, [
      { accountId: outsider.id, canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(saved.statusCode).toBe(400);

    const added = await save(app, memberCookie, owned.id, [
      { email: "outsider@example.com", canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(added.statusCode).toBe(200);
    expect(added.json<{ accounts: ProductAccessEntry[] }>().accounts.map((entry) => entry.account.email).sort())
      .toEqual(["member@example.com", "outsider@example.com", "owner@example.com"]);
  });

  it("adds someone by the address that was typed, whatever its case", async () => {
    // accounts.email is unique COLLATE NOCASE and normalizeEmail only trims, so
    // a case-sensitive lookup would report a typo for an address that is there.
    const { app, memberCookie, outsider, owned } = await creatorWorkspace();
    expect((await save(app, memberCookie, owned.id, [
      { email: "  OutSider@Example.COM ", canView: false, canOperate: true, canUseAi: false },
    ])).statusCode).toBe(200);
    expect(app.missionGoAccounts.listPermissions(outsider.id).find((entry) => entry.productId === owned.id))
      // Operate implies view, stored that way by the one write path.
      .toMatchObject({ canView: true, canOperate: true, canUseAi: false });
  });

  it("takes access away again", async () => {
    const { app, memberCookie, outsider, owned } = await creatorWorkspace();
    await save(app, memberCookie, owned.id, [{ email: "outsider@example.com", canView: true, canOperate: false, canUseAi: false }]);
    const outsiderCookie = await signIn(app, "outsider@example.com", MEMBER_PASSWORD);
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: outsiderCookie } })).json())
      .toHaveLength(1);

    expect((await save(app, memberCookie, owned.id, [
      { accountId: outsider.id, canView: false, canOperate: false, canUseAi: false },
    ])).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie: outsiderCookie } })).json())
      .toHaveLength(0);
  });

  it("refuses an address nobody holds, and a suspended account, with the same answer", async () => {
    // Telling them apart would say something about an account this caller is not
    // allowed to enumerate. Granting a suspended account would also look like it
    // worked while its sessions and tokens stay refused.
    const { app, adminCookie, memberCookie, outsider, owned } = await creatorWorkspace();
    const unknown = await save(app, memberCookie, owned.id, [
      { email: "nobody@example.com", canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "account_not_grantable" });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${outsider.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    const suspended = await save(app, memberCookie, owned.id, [
      { email: "outsider@example.com", canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(suspended.statusCode).toBe(400);
    expect(suspended.json()).toMatchObject({ code: "account_not_grantable" });
  });

  it("refuses an account id the creator was never shown", async () => {
    // The roster is hidden by not listing it; it would be hidden for nothing if a
    // guessed id still reached an account through the write side.
    const { app, memberCookie, outsider, owned } = await creatorWorkspace();
    const guessed = await save(app, memberCookie, owned.id, [
      { accountId: outsider.id, canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(guessed.statusCode).toBe(400);
    expect(guessed.json()).toMatchObject({ code: "account_not_grantable" });
    expect(app.missionGoAccounts.listPermissions(outsider.id)).toEqual([]);
  });

  it("will not let the creator change their own row, by id or by address", async () => {
    // Clearing their own view drops the product off their own list, and clearing
    // operate costs them renaming and archiving it -- while the button still
    // looks live. This editor is for other people's rows.
    const { app, memberCookie, member, owned } = await creatorWorkspace();
    for (const entry of [
      { accountId: member.id, canView: false, canOperate: false, canUseAi: false },
      { email: "member@example.com", canView: true, canOperate: false, canUseAi: false },
    ]) {
      const refused = await save(app, memberCookie, owned.id, [entry]);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "own_access_unchangeable" });
    }
    expect(app.missionGoAccounts.listPermissions(member.id).find((entry) => entry.productId === owned.id))
      .toMatchObject({ canView: true, canOperate: true, canUseAi: true });
  });

  it("saves the rows the editor draws read-only without refusing the whole request", async () => {
    // The editor posts every row it drew, including the creator's own and the
    // administrators'. An entry asking for exactly what is stored is not an
    // attempt to cross those lines, and refusing it would make every save fail.
    const { app, memberCookie, member, adminId, owned } = await creatorWorkspace();
    const saved = await save(app, memberCookie, owned.id, [
      { accountId: member.id, canView: true, canOperate: true, canUseAi: true },
      { accountId: adminId, canView: false, canOperate: false, canUseAi: false },
      { email: "outsider@example.com", canView: true, canOperate: false, canUseAi: false },
    ]);
    expect(saved.statusCode).toBe(200);
  });

  it("will not let the creator narrow an administrator's AI reach", async () => {
    // What commit 0637733 found: an administrator with no can_use_ai row reaches
    // every product, and one with rows is bounded by them. A member writing a row
    // onto an administrator would cut that administrator's AI down to this one
    // product, silently and after the fact.
    const { app, memberCookie, adminId, owned } = await creatorWorkspace();
    const token = aiToken(app, adminAccount(), adminId);
    expect((await callMcp(app, token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: true } });

    const refused = await save(app, memberCookie, owned.id, [
      { accountId: adminId, canView: true, canOperate: true, canUseAi: true },
    ]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "admin_access_unchangeable" });

    expect(app.missionGoAccounts.listPermissions(adminId)).toEqual([]);
    expect((await callMcp(app, token, 2, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: true } });
  });

  it("will not let the creator widen an administrator's AI reach either", async () => {
    // The same row read the other way round. An administrator bounded to a
    // whitelist by ADMIN_AUTHORIZED_PRODUCT_IDS holds exactly one can_use_ai row;
    // clearing it removes the bound instead of tightening it, so a member could
    // lift a deployment-level whitelist from inside a product they happen to own.
    const app = open(join(await temporaryDirectory(), "missiongo.sqlite"));
    const adminCookie = await signIn(app, "owner@example.com", ADMIN_PASSWORD);
    const adminId = app.missionGoAccounts.listAccounts().find((account) => account.role === "admin")!.id;
    const member = (await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: { cookie: adminCookie },
      payload: { email: "member@example.com", password: MEMBER_PASSWORD, role: "member" },
    })).json<{ id: string }>();
    const memberCookie = await signIn(app, "member@example.com", MEMBER_PASSWORD);
    const owned = (await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: memberCookie },
      payload: { name: "Member's own", keyPrefix: "OWN" },
    })).json<{ id: string }>();

    // The shape ADMIN_AUTHORIZED_PRODUCT_IDS leaves behind: one row, on this
    // product, bounding the administrator's AI to it.
    await app.inject({
      method: "PUT",
      url: `/api/v1/accounts/${adminId}/products`,
      headers: { cookie: adminCookie },
      payload: { permissions: [{ productId: owned.id, canView: true, canOperate: true, canUseAi: true }] },
    });
    const token = aiToken(app, adminAccount(), adminId);
    expect((await callMcp(app, token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [owned.id] } });

    const refused = await save(app, memberCookie, owned.id, [
      { accountId: adminId, canView: false, canOperate: false, canUseAi: false },
    ]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "admin_access_unchangeable" });
    expect((await callMcp(app, token, 2, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [owned.id] } });
    expect(member.id).toBeTruthy();
  });

  it("does not pass the power to delegate along with the access", async () => {
    // The item asked for no authorization or claiming flow, and this is what
    // makes that true: the right to delegate comes from role and
    // created_by_account_id, never from a row in account_products.
    const { app, memberCookie, owned } = await creatorWorkspace();
    await save(app, memberCookie, owned.id, [
      { email: "outsider@example.com", canView: true, canOperate: true, canUseAi: true },
    ]);
    const outsiderCookie = await signIn(app, "outsider@example.com", MEMBER_PASSWORD);

    const delegated = await app.inject({
      method: "GET",
      url: `/api/v1/products/${owned.id}/accounts`,
      headers: { cookie: outsiderCookie },
    });
    expect(delegated.statusCode).toBe(403);
    expect(delegated.json()).toMatchObject({ code: "product_not_owned" });
    // Nor archiving it, which is the other thing ownership decides.
    expect((await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${owned.id}`,
      headers: { cookie: outsiderCookie },
      payload: { archived: true },
    })).statusCode).toBe(403);
  });

  it("gives a granted account's AI client the product, without re-authorization", async () => {
    const { app, memberCookie, outsider, owned } = await creatorWorkspace();
    const token = aiToken(app, adminAccount(), outsider.id);
    expect((await callMcp(app, token, 1, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [] } });

    await save(app, memberCookie, owned.id, [
      { email: "outsider@example.com", canView: true, canOperate: false, canUseAi: true },
    ]);
    expect((await callMcp(app, token, 2, "get_current_account")).structuredContent)
      .toMatchObject({ permission: { allProducts: false, productIds: [owned.id] } });
  });

  it("leaves a product whose creator was deleted to administrators only", async () => {
    // deleteAccount leaves created_by_account_id pointing at an id nobody holds,
    // and nothing backfills that one. It matches no live account, so every member
    // is refused and only an administrator can act -- the safe way to fail.
    const { app, adminCookie, memberCookie, member, owned } = await creatorWorkspace();
    const secondMemberCookie = await (async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/accounts",
        headers: { cookie: adminCookie },
        payload: { email: "heir@example.com", password: MEMBER_PASSWORD, role: "member" },
      });
      await save(app, memberCookie, owned.id, [
        { email: "heir@example.com", canView: true, canOperate: true, canUseAi: false },
      ]);
      return signIn(app, "heir@example.com", MEMBER_PASSWORD);
    })();

    await app.inject({ method: "DELETE", url: `/api/v1/accounts/${member.id}`, headers: { cookie: adminCookie } });
    expect(app.missionGoStore.getProduct(owned.id).createdByAccountId).toBe(member.id);

    expect((await app.inject({
      method: "GET",
      url: `/api/v1/products/${owned.id}/accounts`,
      headers: { cookie: secondMemberCookie },
    })).statusCode).toBe(403);
    expect((await listFor(app, adminCookie, owned.id)).length).toBeGreaterThan(0);
  });

  it("still lets access be fixed after the product is archived", async () => {
    // Deliberate: needing to repair who reaches a product is a reason to un-retire
    // it, and refusing here would mean an archived product's permissions could
    // never be corrected.
    const { app, memberCookie, owned } = await creatorWorkspace();
    await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${owned.id}`,
      headers: { cookie: memberCookie },
      payload: { archived: true },
    });
    expect((await save(app, memberCookie, owned.id, [
      { email: "outsider@example.com", canView: true, canOperate: false, canUseAi: false },
    ])).statusCode).toBe(200);
  });

  it("refuses two entries for one account, and more entries than it will take", async () => {
    const { app, memberCookie, outsider, owned } = await creatorWorkspace();
    expect((await save(app, memberCookie, owned.id, [
      { accountId: outsider.id, canView: true, canOperate: false, canUseAi: false },
      { email: "outsider@example.com", canView: false, canOperate: false, canUseAi: false },
    ])).statusCode).toBe(400);

    expect((await save(
      app,
      memberCookie,
      owned.id,
      Array.from({ length: 201 }, () => ({ accountId: outsider.id, canView: true, canOperate: false, canUseAi: false })),
    )).statusCode).toBe(400);
  });

  it("keeps working for a deployment token, which has no account to narrow for", async () => {
    // requireProductOwnership and the guards both step aside for a deployment
    // credential: it is already past every product check, so there is nobody to
    // hide the roster from. What must not happen is it starting to need a
    // session, which is what reading the caller's role carelessly would cause.
    const operatorToken = "product-access-operator-token";
    const app = buildApp({
      databasePath: join(await temporaryDirectory(), "missiongo.sqlite"),
      adminAccount: adminAccount(),
      adminToken: operatorToken,
      publicOrigin: "https://missiongo.test",
    });
    apps.push(app);
    const adminCookie = await signIn(app, "owner@example.com", ADMIN_PASSWORD);
    const product = (await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: { cookie: adminCookie },
      payload: { name: "Operator", keyPrefix: "OPS" },
    })).json<{ id: string }>();

    const headers = { authorization: `Bearer ${operatorToken}` };
    const listed = await app.inject({ method: "GET", url: `/api/v1/products/${product.id}/accounts`, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ accounts: ProductAccessEntry[] }>().accounts.length).toBeGreaterThan(0);
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/products/${product.id}/accounts`,
      headers,
      payload: { accounts: [] },
    })).statusCode).toBe(200);
  });
});
