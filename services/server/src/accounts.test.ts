import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
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
