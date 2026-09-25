import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createAiAccessToken, type AdminAccountConfig } from "./admin-auth.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { MISSIONGO_SKILL_VERSION } from "@missiongo/contracts";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];
const accountsByApp = new WeakMap<FastifyInstance, AdminAccountConfig>();

function adminAccount(id = "account-test-1"): AdminAccountConfig {
  const salt = Buffer.from("missiongo-dispatch-salt");
  return {
    id,
    username: "mission-owner",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
    sessionSecret: "test-session-secret-that-is-not-used-in-production",
    cookieSecure: true,
  };
}

async function signedInApp(account: AdminAccountConfig = adminAccount(), aiProviderFetch?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-dispatch-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "missiongo.sqlite");
  const app = buildApp({
    databasePath,
    attachmentsPath: join(directory, "attachments"),
    adminAccount: account,
    ...(aiProviderFetch ? { aiProviderFetch } : {}),
  });
  apps.push(app);
  accountsByApp.set(app, account);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: account.username, password: "correct horse" },
  });
  const cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;
  return { app, cookie, databasePath };
}

async function readyItem(app: FastifyInstance, cookie: string, productName: string, keyPrefix: string) {
  const product = await app.inject({
    method: "POST",
    url: "/api/v1/products",
    headers: { cookie },
    payload: { name: productName, keyPrefix },
  });
  const productId = product.json<{ id: string }>().id;
  const item = await app.inject({
    method: "POST",
    url: "/api/v1/items",
    headers: { cookie },
    payload: {
      productId,
      status: "ready",
      type: "task",
      priority: "normal",
      title: `${keyPrefix} work`,
      description: "dispatch me",
      environment: { platform: "web" },
    },
  });
  if (item.statusCode !== 201) throw new Error(`item create failed: ${item.statusCode} ${item.body}`);
  return { productId, itemKey: item.json<{ key: string }>().key };
}

function loginToken(app: FastifyInstance, scopes: readonly string[] = ["missiongo:read", "missiongo:node"]): string {
  const account = accountsByApp.get(app)!;
  // The token is issued to an account, and the server resolves that id against
  // the accounts table on every request -- so it has to be the account the
  // bootstrap seed created, which reuses the configured id.
  const user = { id: account.id, username: account.username, role: "admin" as const };
  const credentialsAt = app.missionGoAccounts.credentialsStamp(app.missionGoAccounts.getAccount(account.id));
  return createAiAccessToken(account, user, credentialsAt, "mgc_macos_test", scopes).token;
}

async function register(
  app: FastifyInstance,
  token: string,
  payload: { installationId?: string; name?: string; hostname?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/node/register",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      installationId: payload.installationId ?? randomUUID(),
      name: payload.name ?? "Mac mini",
      hostname: payload.hostname ?? "macbook-test",
    },
  });
}

/** A node as the macOS client creates one: sign in, then register this Mac. */
async function registeredNode(app: FastifyInstance, name = "Mac mini", installationId: string = randomUUID()) {
  const registered = await register(app, loginToken(app), { name, installationId });
  if (registered.statusCode !== 201) throw new Error(`register failed: ${registered.statusCode} ${registered.body}`);
  return registered.json<{ nodeId: string; token: string; name: string }>();
}

async function heartbeat(
  app: FastifyInstance,
  token: string,
  kind = "claude_code",
  repoCandidates: Array<{ path: string; name: string; lastUsedAt?: string }> = [],
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/node/heartbeat",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      agents: [{
        kind,
        version: "2.1.232",
        ready: true,
        skill: { localVersion: MISSIONGO_SKILL_VERSION, expectedVersion: MISSIONGO_SKILL_VERSION, syncState: "ready" },
      }],
      clientVersion: "1.2.3",
      repoCandidates,
    },
  });
}

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Registering a Mac by signing in", () => {
  it("trades a login carrying the node scope for a machine credential", async () => {
    const { app } = await signedInApp();
    const registered = await register(app, loginToken(app), { name: "Mac mini" });
    expect(registered.statusCode).toBe(201);
    expect(registered.json<{ token: string }>().token.startsWith("mgn_")).toBe(true);
  });

  it("refuses no token, a login without the node scope, and a node credential", async () => {
    const { app } = await signedInApp();
    expect((await register(app, "")).statusCode).toBe(401);
    // A login granted for an AI to read and write items does not also sign this
    // Mac up to receive work.
    expect((await register(app, loginToken(app, ["missiongo:read", "missiongo:write"]))).statusCode).toBe(401);

    const node = await registeredNode(app);
    expect((await register(app, node.token)).statusCode).toBe(401);
  });

  it("finds the same Mac on a second login and retires its old credential", async () => {
    const { app, cookie } = await signedInApp();
    const installationId = randomUUID();
    const first = await registeredNode(app, "Mac mini", installationId);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${first.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/nodes/${first.nodeId}`, headers: { cookie }, payload: { name: "办公室 Mac mini" } });

    const second = await registeredNode(app, "Mac mini", installationId);
    expect(second.nodeId).toBe(first.nodeId);
    // A name set in the console belongs to the person who set it.
    expect(second.name).toBe("办公室 Mac mini");
    expect((await heartbeat(app, first.token)).statusCode).toBe(401);
    expect((await heartbeat(app, second.token)).json()).toMatchObject({
      repos: [{ repoPath: "/Users/dev/Projects/missiongo" }],
    });

    const nodes = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    expect(nodes.json<{ nodes: unknown[] }>().nodes).toHaveLength(1);
  });

  it("answers every heartbeat with the current product list", async () => {
    // The client polls this every 30 seconds whether or not its menu is open.
    // Before it carried the products, a product created in the console only
    // reached the machine when someone quit the client and opened it again.
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await readyItem(app, cookie, "Mission GO", "AND");
    expect((await heartbeat(app, node.token)).json()).toMatchObject({
      products: [{ keyPrefix: "AND", name: "Mission GO" }],
      expectedSkillVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });

    await readyItem(app, cookie, "HitGO", "HIG");
    const after = (await heartbeat(app, node.token)).json<{ products: Array<{ keyPrefix: string }> }>();
    expect(after.products.map((product) => product.keyPrefix).sort()).toEqual(["AND", "HIG"]);
  });

  it("brings a revoked Mac back on the next login, with a new credential only", async () => {
    const { app, cookie } = await signedInApp();
    const installationId = randomUUID();
    const node = await registeredNode(app, "Mac mini", installationId);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/nodes/${node.nodeId}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await heartbeat(app, node.token)).statusCode).toBe(401);

    const again = await registeredNode(app, "Mac mini", installationId);
    expect(again.nodeId).toBe(node.nodeId);
    expect((await heartbeat(app, again.token)).statusCode).toBe(200);
    expect((await heartbeat(app, node.token)).statusCode).toBe(401);
  });

  it("gives a different installation its own node", async () => {
    const { app } = await signedInApp();
    const one = await registeredNode(app, "Mac mini");
    const two = await registeredNode(app, "MacBook");
    expect(one.nodeId).not.toBe(two.nodeId);
  });

  it("no longer offers pairing codes", async () => {
    const { app, cookie } = await signedInApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/nodes/pairing-codes",
      headers: { cookie },
      payload: { name: "Mac mini" },
    });
    expect(created.statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/node/pair", payload: { code: "x" } })).statusCode).toBe(404);
  });
});

describe("The macOS client's sign-in, end to end", () => {
  it("registers a client, signs in with the node scope, and trades the login for a machine", async () => {
    // The whole flow the client runs, against the real OAuth routes: a loopback
    // redirect registered per attempt, PKCE S256, a form-encoded token exchange,
    // then registration. It is the one path a person takes to join a Mac.
    const directory = await mkdtemp(join(tmpdir(), "missiongo-client-login-"));
    temporaryDirectories.push(directory);
    const account = adminAccount();
    const app = buildApp({
      databasePath: join(directory, "missiongo.sqlite"),
      attachmentsPath: join(directory, "attachments"),
      adminAccount: account,
      publicOrigin: "https://missiongo.test",
    });
    apps.push(app);
    const redirectUri = "http://127.0.0.1:53086/callback";

    const client = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "MissionGo macOS", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = client.json<{ client_id: string }>().client_id;

    const verifier = "v".repeat(64);
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state: "client-state",
        scope: "missiongo:read missiongo:node",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      },
    });
    expect(authorize.statusCode).toBe(200);
    // The person is told what signing in here grants.
    expect(authorize.body).toContain("把这台 Mac 登记为你的设备");
    const requestToken = /name="request" value="([^"]+)"/.exec(authorize.body)?.[1];

    const approved = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ request: requestToken!, username: account.username, password: "correct horse" }).toString(),
    });
    expect(approved.statusCode).toBe(302);
    const callback = new URL(approved.headers.location!);
    expect(callback.searchParams.get("state")).toBe("client-state");

    const exchanged = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    expect(exchanged.statusCode).toBe(200);
    const accessToken = exchanged.json<{ access_token: string; scope: string }>();
    expect(accessToken.scope).toContain("missiongo:node");

    const registered = await register(app, accessToken.access_token, { name: "Mac mini" });
    expect(registered.statusCode).toBe(201);
    const token = registered.json<{ token: string }>().token;
    expect((await heartbeat(app, token)).statusCode).toBe(200);
  });
});

describe("A machine's nickname (AND-39)", () => {
  const nodeHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

  it("is called by its device name until someone gives it a nickname", async () => {
    const { app, cookie } = await signedInApp();
    await registeredNode(app, "Macbook-M5");
    const nodes = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    const node = nodes.json<{ nodes: Array<Record<string, unknown>> }>().nodes[0]!;
    expect(node).toMatchObject({ name: "Macbook-M5", deviceName: "Macbook-M5" });
    expect(node.nickname).toBeUndefined();
  });

  it("is one field, set from the client and seen in the console, and cleared back to the device name", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app, "Macbook-M5");

    const set = await app.inject({
      method: "PATCH",
      url: "/api/v1/node/me",
      headers: nodeHeaders(node.token),
      payload: { nickname: "  办公室 Mac mini  " },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ node: { name: "办公室 Mac mini", nickname: "办公室 Mac mini", deviceName: "Macbook-M5" } });

    const listed = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    expect(listed.json<{ nodes: Array<{ name: string }> }>().nodes[0]!.name).toBe("办公室 Mac mini");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie },
      payload: { nickname: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ name: "Macbook-M5", deviceName: "Macbook-M5" });
    expect(cleared.json<Record<string, unknown>>().nickname).toBeUndefined();
  });

  it("still accepts a rename sent as name, from a console page loaded before this change", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app, "Macbook-M5");
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie },
      payload: { name: "Mac mini" },
    });
    expect(renamed.json()).toMatchObject({ name: "Mac mini", nickname: "Mac mini", deviceName: "Macbook-M5" });
  });

  it("refuses a nickname too long for a session name, or one with a line break", async () => {
    const { app } = await signedInApp();
    const node = await registeredNode(app);
    for (const nickname of ["x".repeat(41), "Mac\nmini"]) {
      const refused = await app.inject({
        method: "PATCH",
        url: "/api/v1/node/me",
        headers: nodeHeaders(node.token),
        payload: { nickname },
      });
      expect(refused.statusCode).toBe(400);
    }
  });

  it("survives signing in again, while the device name follows the Mac", async () => {
    const { app } = await signedInApp();
    const installationId = randomUUID();
    const node = await registeredNode(app, "Macbook-M5", installationId);
    await app.inject({ method: "PATCH", url: "/api/v1/node/me", headers: nodeHeaders(node.token), payload: { nickname: "主力机" } });

    const again = await registeredNode(app, "Liang's MacBook Pro", installationId);
    expect(again.name).toBe("主力机");
    const me = await app.inject({ method: "GET", url: "/api/v1/node/me", headers: nodeHeaders(again.token) });
    expect(me.json()).toMatchObject({ node: { name: "主力机", nickname: "主力机", deviceName: "Liang's MacBook Pro" } });
  });

  it("names the machine in the job it pulls and in the dispatch record", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app, "Macbook-M5");
    await heartbeat(app, node.token);
    await app.inject({ method: "PATCH", url: "/api/v1/node/me", headers: nodeHeaders(node.token), payload: { nickname: "Mac mini" } });
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: "/api/v1/node/repos",
      headers: nodeHeaders(node.token),
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(dispatch.json()).toMatchObject({ nodeName: "Mac mini" });

    const job = await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: nodeHeaders(node.token) });
    expect(job.json()).toMatchObject({ nodeName: "Mac mini", itemKeys: [mission.itemKey] });
  });
});

describe("Dispatching the same item twice", () => {
  async function mappedNode(app: FastifyInstance, cookie: string, name = "Mac mini") {
    const node = await registeredNode(app, name);
    await heartbeat(app, node.token);
    return node;
  }

  async function dispatchTo(
    app: FastifyInstance,
    cookie: string,
    nodeId: string,
    itemKeys: string[],
    force?: boolean,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId, agentKind: "claude_code", mode: "plan", itemKeys, ...(force === undefined ? {} : { force }) },
    });
  }

  async function setup() {
    const { app, cookie, databasePath } = await signedInApp();
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    const mini = await mappedNode(app, cookie, "Mac mini");
    const laptop = await mappedNode(app, cookie, "MacBook");
    for (const node of [mini, laptop]) {
      await app.inject({
        method: "PUT",
        url: "/api/v1/node/repos",
        headers: { authorization: `Bearer ${node.token}` },
        payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
      });
    }
    return { app, cookie, databasePath, mission, mini, laptop };
  }

  it("refuses an item already dispatched and not yet claimed, to any machine", async () => {
    // An item stays ready until its session claims it — in plan mode, hours
    // later. A second dispatch in that window meant two sessions on one item.
    const { app, cookie, mission, mini, laptop } = await setup();
    expect((await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).statusCode).toBe(201);

    for (const target of [mini, laptop]) {
      const again = await dispatchTo(app, cookie, target.nodeId, [mission.itemKey]);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "item_already_dispatched" });
      expect(again.json<{ title: string }>().title).toContain(mission.itemKey);
    }
  });

  it("dispatches again when told the earlier session is gone, cancelling one never picked up", async () => {
    const { app, cookie, mission, mini, laptop } = await setup();
    const first = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();

    const forced = await dispatchTo(app, cookie, laptop.nodeId, [mission.itemKey], true);
    expect(forced.statusCode).toBe(201);

    const history = await app.inject({ method: "GET", url: `/api/v1/items/${mission.itemKey}/dispatches`, headers: { cookie } });
    const byId = new Map(history.json<{ dispatches: Array<{ id: string; status: string; error?: string }> }>().dispatches.map((d) => [d.id, d]));
    // The Mac mini never pulled it, so it must not start a second session when it comes back.
    expect(byId.get(first.id)).toMatchObject({ status: "cancelled", error: "已被重新派单取代" });
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${mini.token}` },
    })).statusCode).toBe(204);
  });

  it("leaves a dispatch already handed to its machine alone, since it cannot be recalled", async () => {
    const { app, cookie, mission, mini, laptop } = await setup();
    const first = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });

    expect((await dispatchTo(app, cookie, laptop.nodeId, [mission.itemKey], true)).statusCode).toBe(201);
    const history = await app.inject({ method: "GET", url: `/api/v1/items/${mission.itemKey}/dispatches`, headers: { cookie } });
    const earlier = history.json<{ dispatches: Array<{ id: string; status: string }> }>().dispatches.find((d) => d.id === first.id);
    expect(earlier?.status).toBe("delivered");
  });

  it("shows a delivery without a launch result as abnormal and retries only after confirmation", async () => {
    const { app, cookie, databasePath, mission, mini } = await setup();
    const first = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });

    const earlyRetry = await app.inject({ method: "POST", url: `/api/v1/dispatches/${first.id}/retry`, headers: { cookie } });
    expect(earlyRetry.statusCode).toBe(409);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE dispatches SET delivered_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), first.id);
    database.close();

    const listed = await app.inject({ method: "GET", url: `/api/v1/agent-sessions?productId=${mission.productId}`, headers: { cookie } });
    expect(listed.json()).toMatchObject({ sessions: [{ dispatchId: first.id, status: "failed", canRetry: true }] });
    const retried = await app.inject({ method: "POST", url: `/api/v1/dispatches/${first.id}/retry`, headers: { cookie } });
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ status: "queued", itemKeys: [mission.itemKey] });
    const lateReport = await app.inject({
      method: "POST", url: `/api/v1/node/dispatches/${first.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: { status: "launched", sessionName: "late Codex session" },
    });
    expect(lateReport.statusCode).toBe(409);
    const retryId = retried.json<{ id: string }>().id;
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reported = await app.inject({
        method: "POST", url: `/api/v1/node/dispatches/${retryId}/result`,
        headers: { authorization: `Bearer ${mini.token}` },
        payload: { status: "launched", sessionName: "new Codex session", sessionRef: "new-thread" },
      });
      expect(reported.statusCode).toBe(204);
    }
    const afterLaunch = await app.inject({ method: "GET", url: `/api/v1/agent-sessions?productId=${mission.productId}`, headers: { cookie } });
    expect(afterLaunch.json<{ sessions: Array<{ agentSessionId?: string }> }>().sessions.filter((session) => session.agentSessionId)).toHaveLength(1);
  });

  it("does not block after a dispatch failed", async () => {
    const { app, cookie, mission, mini } = await setup();
    const first = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${first.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: { status: "failed", error: "目录未信任" },
    });

    const failed = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(failed.json()).toMatchObject({
      active: [],
      latest: [{ dispatchId: first.id, itemKey: mission.itemKey, status: "failed" }],
    });

    expect((await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).statusCode).toBe(201);
    const retried = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(retried.json()).toMatchObject({
      active: [{ itemKey: mission.itemKey, status: "queued" }],
      latest: [{ itemKey: mission.itemKey, status: "queued" }],
    });
  });

  it("requeues a transient node failure with backoff and preserves MCP diagnostics", async () => {
    const { app, cookie, mission, mini } = await setup();
    const dispatch = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({
      method: "POST", url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${mini.token}` },
    });
    const reported = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatch.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: {
        status: "retry", retryAfterSeconds: 30, error: "MissionGo MCP startup timed out",
        failureCode: "mcp_timeout", failureStage: "mcp",
        diagnosticSnapshot: {
          mcp: {
            threadId: "thread-1", name: "missiongo", startupStatus: "failed",
            runtimeStatus: "starting", error: "MCP client startup timed out",
            observedAt: "2026-09-23T00:00:00Z",
          },
        },
      },
    });
    expect(reported.statusCode).toBe(204);

    // It is queued for the same node, but cannot hot-loop before the backoff.
    const immediate = await app.inject({
      method: "POST", url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${mini.token}` },
    });
    expect(immediate.statusCode).toBe(204);
    const history = await app.inject({
      method: "GET", url: `/api/v1/items/${mission.itemKey}/dispatches`, headers: { cookie },
    });
    expect(history.json()).toMatchObject({ dispatches: [{
      id: dispatch.id, status: "queued", error: "MissionGo MCP startup timed out",
      failureCode: "mcp_timeout", failureStage: "mcp",
      diagnosticSnapshot: { mcp: { threadId: "thread-1", name: "missiongo", runtimeStatus: "starting" } },
    }] });
  });

  it("lists ready items with an unclaimed dispatch, and forgets them once claimed", async () => {
    const { app, cookie, mission, mini } = await setup();
    await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey]);

    const active = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(active.json()).toMatchObject({
      active: [{ itemKey: mission.itemKey, nodeName: "Mac mini", status: "queued" }],
      latest: [{ itemKey: mission.itemKey, nodeName: "Mac mini", status: "queued" }],
    });

    // The session claims the item: it is no longer ready, so there is nothing to warn about.
    const claimed = await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "in_progress", reason: "claim" },
    });
    expect(claimed.json<{ status: string }>().status).toBe("in_progress");
    const after = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(after.json()).toEqual({ active: [], latest: [], handlers: [] });
  });

  it("names the agent behind an in-progress item once its session claims (AND-163)", async () => {
    const { app, cookie, mission, mini } = await setup();
    const dispatch = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatch.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: { status: "launched" },
    });
    app.missionGoStore.claimWorkItem({
      itemKey: mission.itemKey,
      agentId: "claude-code@Macbook",
      idempotencyKey: "claim-handler-1",
    });

    const active = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(active.json()).toMatchObject({
      active: [],
      latest: [],
      handlers: [{ itemKey: mission.itemKey, nodeName: "Mac mini", agentKind: "claude_code" }],
    });
  });

  it("does not credit an agent when a person starts work on an unclaimed launch", async () => {
    const { app, cookie, mission, mini } = await setup();
    const dispatch = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatch.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: { status: "launched" },
    });
    // The launch is still unclaimed when the person picks the item up themselves.
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "in_progress", reason: "claim" },
    });
    expect(started.json<{ status: string }>().status).toBe("in_progress");

    const active = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(active.json()).toMatchObject({ active: [], latest: [], handlers: [] });
  });

  it("dispatches an item sent back by a failed verification without force", async () => {
    // The first dispatch stays `launched` for good. Once its session claimed the
    // item, that dispatch is spent, even though the item is ready again.
    const { app, cookie, mission, mini } = await setup();
    const first = (await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).json<{ id: string }>();
    await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${first.id}/result`,
      headers: { authorization: `Bearer ${mini.token}` },
      payload: { status: "launched", sessionName: `Mac mini-${mission.itemKey}` },
    });
    for (const [to, reason] of [["in_progress", "claim"], ["development_complete", "resolution_submitted"], ["pending_verification", "release_verified"], ["ready", "verification_failed"]]) {
      const moved = await app.inject({
        method: "POST",
        url: `/api/v1/items/${mission.itemKey}/transitions`,
        headers: { cookie },
        payload: { to, reason, note: "按钮在暗色模式下看不见" },
      });
      expect(moved.statusCode, moved.body).toBe(200);
    }

    const active = await app.inject({ method: "GET", url: "/api/v1/dispatches/active", headers: { cookie } });
    expect(active.json()).toEqual({ active: [], latest: [], handlers: [] });
    expect((await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey])).statusCode).toBe(201);

    // The machine hears that this is a second session, and on reworked work.
    const again = await app.inject({ method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${mini.token}` } });
    expect(again.json()).toMatchObject({ itemKeys: [mission.itemKey], round: 2, reworkItemKeys: [mission.itemKey] });
  });

  it("counts rounds per item, ignoring dispatches that never reached a machine", async () => {
    const { app, cookie, mission, mini, laptop } = await setup();
    const other = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId: mission.productId, status: "ready", type: "task", priority: "normal",
        title: "fresh", description: "never dispatched", environment: { platform: "web" },
      },
    });
    const fresh = other.json<{ key: string }>().key;
    const claim = (token: string) => app.inject({
      method: "POST", url: "/api/v1/node/dispatches/claim-next", headers: { authorization: `Bearer ${token}` },
    });

    // Queued on the Mac mini, then replaced before it was picked up: cancelled, no session.
    await dispatchTo(app, cookie, mini.nodeId, [mission.itemKey]);
    await dispatchTo(app, cookie, laptop.nodeId, [mission.itemKey], true);
    expect((await claim(laptop.token)).json()).toMatchObject({ round: 1, reworkItemKeys: [] });

    // Delivered to the laptop and gone: the next one is the second session on it,
    // and a batch takes the highest round among its items.
    await dispatchTo(app, cookie, mini.nodeId, [fresh, mission.itemKey], true);
    expect((await claim(mini.token)).json()).toMatchObject({ itemKeys: [fresh, mission.itemKey], round: 2, reworkItemKeys: [] });
  });
});

describe("The client's own view of its Mac", () => {
  it("shows its node, its mapping and the products it can map", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/node/repos",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    expect(saved.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/v1/node/me", headers: { authorization: `Bearer ${node.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      node: { id: node.nodeId, online: true },
      repos: [{ productId: mission.productId, productKey: "AND", repoPath: "/Users/dev/Projects/missiongo" }],
      products: [{ id: mission.productId, keyPrefix: "AND", name: "Mission GO" }],
    });

    // The console sees the mapping the client saved.
    const nodes = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    expect(nodes.json<{ nodes: Array<{ repos: unknown[] }> }>().nodes[0]!.repos).toHaveLength(1);
  });

  it("refuses a relative path from the client too", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/node/repos",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { repos: [{ productId: mission.productId, repoPath: "Projects/missiongo" }] },
    });
    expect(saved.statusCode).toBe(400);
  });

  it("lists only this Mac's dispatches", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app, "Mac mini");
    const other = await registeredNode(app, "MacBook");
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: "/api/v1/node/repos",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });

    const mine = await app.inject({ method: "GET", url: "/api/v1/node/dispatches", headers: { authorization: `Bearer ${node.token}` } });
    expect(mine.json<{ dispatches: Array<{ itemKeys: string[] }> }>().dispatches).toMatchObject([{ itemKeys: [mission.itemKey] }]);

    const theirs = await app.inject({ method: "GET", url: "/api/v1/node/dispatches", headers: { authorization: `Bearer ${other.token}` } });
    expect(theirs.json<{ dispatches: unknown[] }>().dispatches).toEqual([]);
  });

  it("refuses these endpoints without a node credential", async () => {
    const { app, cookie } = await signedInApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/node/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/node/me", headers: { authorization: `Bearer ${loginToken(app)}` } })).statusCode).toBe(401);
  });
});

describe("Checkouts a node reports", () => {
  it("keeps the machine's list so the console can offer it instead of a path field", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "claude_code", [
      { path: "/Users/dev/Projects/missiongo", name: "missiongo", lastUsedAt: "2026-09-13T10:00:00.000Z" },
      { path: "/Users/dev/Projects/hermes", name: "hermes" },
    ]);

    const nodes = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    const listed = nodes.json<{ nodes: Array<{ repoCandidates: Array<{ path: string; name: string }> }> }>().nodes[0]!;
    expect(listed.repoCandidates).toEqual([
      { path: "/Users/dev/Projects/missiongo", name: "missiongo", lastUsedAt: "2026-09-13T10:00:00.000Z" },
      { path: "/Users/dev/Projects/hermes", name: "hermes" },
    ]);
  });

  it("drops relative paths and caps how many a node can report", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "claude_code", [
      { path: "../escape", name: "escape" },
      ...Array.from({ length: 60 }, (_value, index) => ({
        path: `/Users/dev/Projects/repo-${index}`,
        name: `repo-${index}`,
      })),
    ]);

    const nodes = await app.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie } });
    const candidates = nodes.json<{ nodes: Array<{ repoCandidates: Array<{ path: string }> }> }>().nodes[0]!.repoCandidates;
    expect(candidates).toHaveLength(50);
    expect(candidates.some((candidate) => candidate.path.startsWith(".."))).toBe(false);
  });

  it("still dispatches to a path that was never reported, because the list is a convenience", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/typed-by-hand" }] },
    });
    const dispatched = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(dispatched.statusCode).toBe(201);
  });
});

describe("Dispatching a batch", () => {
  it("keeps work queued until the node reports the expected Skill as ready", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "POST",
      url: "/api/v1/node/heartbeat",
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        agents: [{
          kind: "codex", version: "0.155.1", ready: false,
          unavailableReason: "MissionGo Skill is not synchronized.",
          skill: { localVersion: "5.9.0", expectedVersion: MISSIONGO_SKILL_VERSION, syncState: "stale" },
        }],
      },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const dispatched = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(dispatched.statusCode).toBe(409);
    expect(dispatched.json()).toMatchObject({ code: "agent_not_ready" });
  });

  it("queues one session for the batch and records it on every item's timeline", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const first = await readyItem(app, cookie, "Mission GO", "AND");
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId: first.productId,
        status: "ready",
        type: "task",
        priority: "normal",
        title: "second",
        description: "also dispatch me",
        environment: { platform: "web" },
      },
    });
    const secondKey = second.json<{ key: string }>().key;

    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: first.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "claude_code",
        mode: "plan",
        itemKeys: [first.itemKey, secondKey],
      },
    });
    expect(dispatched.statusCode).toBe(201);
    expect(dispatched.json()).toMatchObject({ status: "queued", itemKeys: [first.itemKey, secondKey] });

    // A dispatch is not a status change: the session still has to claim.
    const item = await app.inject({ method: "GET", url: `/api/v1/items/${first.itemKey}`, headers: { cookie } });
    expect(item.json<{ status: string }>().status).toBe("ready");

    const timeline = await app.inject({ method: "GET", url: `/api/v1/items/${first.itemKey}/timeline`, headers: { cookie } });
    const events = timeline.json<{ events: Array<{ eventType: string; actorKind: string }> }>().events;
    expect(events.some((event) => event.eventType === "dispatched" && event.actorKind === "system")).toBe(true);
  });

  it("refuses items that are not ready, unmapped products and cross-repository batches", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    const hermes = await readyItem(app, cookie, "Hermes Go", "HG");

    const unmapped = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(unmapped.statusCode).toBe(409);
    expect(unmapped.json()).toMatchObject({ code: "repo_unmapped" });

    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: {
        repos: [
          { productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" },
          { productId: hermes.productId, repoPath: "/Users/dev/Projects/hermes" },
        ],
      },
    });

    const mixed = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "claude_code",
        mode: "plan",
        itemKeys: [mission.itemKey, hermes.itemKey],
      },
    });
    expect(mixed.statusCode).toBe(409);
    expect(mixed.json()).toMatchObject({ code: "repo_conflict" });

    const inbox = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId: mission.productId,
        type: "task",
        priority: "normal",
        title: "not accepted yet",
        description: "still inbox",
      },
    });
    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "claude_code",
        mode: "plan",
        itemKeys: [inbox.json<{ key: string }>().key],
      },
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ code: "item_not_dispatchable" });

    const badMode = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "claude_code",
        mode: "dontAsk",
        itemKeys: [mission.itemKey],
      },
    });
    expect(badMode.statusCode).toBe(400);
  });

  it("refuses a node that never checked in, and an agent it did not report", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });

    const offline = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ code: "node_offline" });

    await heartbeat(app, node.token, "hermes");
    const wrongAgent = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(wrongAgent.statusCode).toBe(409);
    expect(wrongAgent.json()).toMatchObject({ code: "agent_unavailable" });
  });
});

describe("Claiming a dispatch on the node", () => {
  async function queuedDispatch(aiProviderFetch?: typeof fetch) {
    const { app, cookie, databasePath } = await signedInApp(adminAccount(), aiProviderFetch);
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    return { app, cookie, databasePath, node, mission, dispatchId: dispatch.json<{ id: string }>().id };
  }

  it("hands the batch over once and then reports the session back", async () => {
    const { app, cookie, node, mission, dispatchId } = await queuedDispatch();
    const claim = () => app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });

    const first = await claim();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      dispatchId,
      itemKeys: [mission.itemKey],
      repoPath: "/Users/dev/Projects/missiongo",
      agentKind: "claude_code",
      mode: "plan",
    });

    // A second poll must not start the same batch again.
    expect((await claim()).statusCode).toBe(204);

    const result = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `MissionGo ${mission.itemKey}`,
        sessionUrl: "https://claude.ai/code/session_016Jhieb3iHbCW5ymeG2kns6",
      },
    });
    expect(result.statusCode).toBe(204);

    const dispatches = await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    });
    expect(dispatches.json<{ dispatches: Array<{ status: string; sessionUrl: string }> }>().dispatches[0])
      .toMatchObject({ status: "launched", sessionUrl: "https://claude.ai/code/session_016Jhieb3iHbCW5ymeG2kns6" });
  });

  it("leaves work queued when its agent is temporarily unavailable", async () => {
    const { app, node, dispatchId } = await queuedDispatch();
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { availableAgentKinds: ["codex"] },
    });
    expect(blocked.statusCode).toBe(204);

    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { availableAgentKinds: ["claude_code"] },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ dispatchId, agentKind: "claude_code" });
  });

  it("rejects unknown locally available agent kinds", async () => {
    const { app, node } = await queuedDispatch();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { availableAgentKinds: ["shell"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("shares a ten-session execution cap across Claude and Codex", async () => {
    const { app, node, dispatchId } = await queuedDispatch();
    const now = new Date().toISOString();
    const insertDispatch = app.missionGoStore.database.connection.prepare(
      `INSERT INTO dispatches
        (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
       VALUES (?, ?, ?, ?, 'plan', 'launched', '/repo', ?)`,
    );
    const insertSession = app.missionGoStore.database.connection.prepare(
      `INSERT INTO agent_sessions
        (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at, activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 10; index += 1) {
      const fakeDispatchId = `busy-dispatch-${index}`;
      const kind = index % 2 === 0 ? "claude_code" : "codex";
      insertDispatch.run(fakeDispatchId, "account-test-1", node.nodeId, kind, now);
      insertSession.run(
        `busy-session-${index}`, fakeDispatchId, node.nodeId, kind, `session-${index}`,
        index === 9 ? "stalled" : "active", now, now, now,
      );
    }

    const claim = () => app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect((await claim()).statusCode).toBe(204);
    expect(app.missionGoStore.database.connection.prepare(
      "SELECT status FROM dispatches WHERE id = ?",
    ).get(dispatchId)).toMatchObject({ status: "queued" });

    app.missionGoStore.database.connection.prepare(
      "UPDATE agent_sessions SET status = 'idle' WHERE id = 'busy-session-0'",
    ).run();
    expect((await claim()).json()).toMatchObject({ dispatchId });
  });

  it("classifies only ambiguous latest Agent replies and caches the result by message", async () => {
    const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const source = body.messages.at(-1)?.content ?? "";
      if (source.includes("无法判断")) throw new Error("provider unavailable");
      const needsAttention = source.includes("请批准");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          needsAttention,
          kind: needsAttention ? "approval" : "none",
          reason: needsAttention ? "需要用户批准后继续。" : "仅陈述发布结果，无需后续处理。",
        }) } }],
      }), { status: 200 });
    });
    const { app, cookie, node, mission, dispatchId } = await queuedDispatch(provider as typeof fetch);
    expect((await app.inject({
      method: "PUT",
      url: "/api/v1/ai/title-settings",
      headers: { cookie },
      payload: { apiKey: "secret-deepseek-key" },
    })).json()).toEqual({ configured: true, agentAttentionEnabled: true });
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionUrl: "https://claude.ai/code/session_attention",
        sessionRef: "11111111-2222-4333-8444-555555555555",
      },
    });
    const sessionId = (await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json<{ sessions: Array<{ id: string }> }>().sessions[0]!.id;
    const snapshot = (messages: unknown[]) => app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages },
    });
    const base = [{ sourceId: "u1", turnId: "t1", role: "user", text: "处理并发布。" }];

    expect((await snapshot([
      ...base,
      { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "已经发包并发布。" },
    ])).statusCode).toBe(204);
    await vi.waitFor(async () => {
      const listed = (await app.inject({
        method: "GET",
        url: `/api/v1/agent-sessions?productId=${mission.productId}`,
        headers: { cookie },
      })).json<{ sessions: Array<Record<string, unknown>> }>();
      expect(listed.sessions[0]).toMatchObject({
        needsAttention: false,
        waitingForReply: false,
        attention: { state: "not_needed", reason: "仅陈述发布结果，无需后续处理。", model: "deepseek-flash" },
      });
    });
    expect(provider).toHaveBeenCalledTimes(1);
    const sent = String(provider.mock.calls[0]?.[1]?.body);
    expect(sent).toContain("已经发包并发布");
    expect(sent).not.toContain("dispatch me");
    expect(sent).not.toContain("AND work");
    const staleHash = (app.missionGoStore.database.connection.prepare(
      "SELECT message_hash FROM agent_session_attention WHERE session_id = ?",
    ).get(sessionId) as { message_hash: string }).message_hash;

    await snapshot([
      ...base,
      { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "已经发包并发布。" },
    ]);
    expect(provider).toHaveBeenCalledTimes(1);

    await snapshot([
      ...base,
      {
        sourceId: "a2",
        turnId: "t2",
        role: "agent",
        phase: "final_answer",
        text: "请明确回复‘批准计划’后，我再开始任何写入和实施。",
      },
    ]);
    const explicitApproval = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<Record<string, unknown>> }>();
    expect(explicitApproval.sessions[0]).toMatchObject({
      needsAttention: true,
      waitingForReply: true,
      attention: { state: "needed", kind: "approval", reason: "AI 明确要求批准或确认后再继续。" },
    });
    expect(provider).toHaveBeenCalledTimes(1);

    app.missionGoStore.database.connection.prepare(
      `UPDATE agent_session_attention
       SET state = 'not_needed', kind = NULL, reason = '旧模型误判', model = 'deepseek-flash'
       WHERE session_id = ?`,
    ).run(sessionId);
    const cachedFalse = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<Record<string, unknown>> }>();
    expect(cachedFalse.sessions[0]).toMatchObject({
      needsAttention: true,
      attention: { state: "needed", kind: "approval", reason: "AI 明确要求批准或确认后再继续。" },
    });

    app.missionGoStore.database.connection.prepare(
      `UPDATE agent_session_attention
       SET state = 'not_needed', kind = NULL, reason = NULL, model = NULL
       WHERE session_id = ?`,
    ).run(sessionId);
    const answered = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<Record<string, unknown>> }>();
    expect(answered.sessions[0]).toMatchObject({
      needsAttention: false,
      attention: { state: "not_needed" },
    });
    expect(new AgentSessionStore(app.missionGoStore.database).completeAttention(sessionId, staleHash, {
      needsAttention: false,
      kind: "none",
      reason: "过期结果不应覆盖新消息。",
      model: "deepseek-flash",
    })).toBe(false);

    await snapshot([
      ...base,
      { sourceId: "a3", turnId: "t3", role: "agent", phase: "final_answer", text: "这条内容让模型无法判断。" },
    ]);
    await vi.waitFor(async () => {
      const listed = (await app.inject({
        method: "GET",
        url: `/api/v1/agent-sessions?productId=${mission.productId}`,
        headers: { cookie },
      })).json<{ sessions: Array<Record<string, unknown>> }>();
      expect(listed.sessions[0]).toMatchObject({
        needsAttention: true,
        attention: {
          state: "needed",
          kind: "uncertain",
          reason: "AI 判断暂时不可用，请人工确认是否需要处理。",
        },
      });
    });
    expect(provider).toHaveBeenCalledTimes(2);

    await snapshot([
      ...base,
      {
        sourceId: "a4", turnId: "t4", role: "agent", text: "选择范围。",
        questions: [{ title: "选择范围", options: ["小", "完整"] }],
      },
    ]);
    const explicit = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<Record<string, unknown>> }>();
    expect(explicit.sessions[0]).toMatchObject({
      needsAttention: true,
      attention: { state: "needed", kind: "answer", reason: "AI 提出了需要回答的问题。" },
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("dismisses attention for unchanged content and reopens it for new content or a stall", async () => {
    const { app, cookie, node, mission, dispatchId } = await queuedDispatch();
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionUrl: "https://claude.ai/code/session_attention_dismiss",
        sessionRef: "21111111-2222-4333-8444-555555555555",
      },
    });
    const sessionId = (await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json<{ sessions: Array<{ id: string }> }>().sessions[0]!.id;
    const messages = [
      { sourceId: "u1", turnId: "t1", role: "user", text: "处理它。" },
      {
        sourceId: "a1", turnId: "t1", role: "agent", text: "选择范围。",
        questions: [{ title: "选择范围", options: ["小", "完整"] }],
      },
    ];
    const snapshot = (status: string, nextMessages = messages) => app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status, messages: nextMessages },
    });
    const list = async () => (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{
      needsAttention: boolean;
      attention: { revision: string; dismissed?: boolean; reason?: string };
    }> }>().sessions[0]!;

    expect((await snapshot("idle")).statusCode).toBe(204);
    const before = await list();
    expect(before.needsAttention).toBe(true);
    expect(before.attention.revision).toBeTruthy();

    const dismissed = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${sessionId}/attention/dismiss`,
      headers: { cookie },
      payload: { revision: before.attention.revision },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(await list()).toMatchObject({
      needsAttention: false,
      attention: { dismissed: true, reason: "已由用户标记为无需处理。" },
    });

    expect((await snapshot("active")).statusCode).toBe(204);
    expect(await list()).toMatchObject({ needsAttention: false, attention: { dismissed: true } });

    expect((await snapshot("stalled")).statusCode).toBe(204);
    expect((await list()).needsAttention).toBe(true);

    const newMessages = [
      ...messages,
      {
        sourceId: "a2", turnId: "t2", role: "agent", text: "请确认新的方案。",
        questions: [{ title: "是否继续", options: ["继续", "停止"] }],
      },
    ];
    expect((await snapshot("idle", newMessages)).statusCode).toBe(204);
    const staleDismissal = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${sessionId}/attention/dismiss`,
      headers: { cookie },
      payload: { revision: before.attention.revision },
    });
    expect(staleDismissal.statusCode).toBe(409);
    expect(staleDismissal.json()).toMatchObject({ code: "agent_attention_changed" });
    const after = await list();
    expect(after.needsAttention).toBe(true);
    expect(after.attention.revision).not.toBe(before.attention.revision);
  });

  it("hands a dispatch to a machine already waiting on a long poll", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });

    // The machine asks first and is still waiting when the dispatch is created,
    // which is the case that makes hand-off immediate instead of one poll late.
    const waiting = app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { waitMs: 5_000 },
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(dispatched.statusCode).toBe(201);

    const claimed = await waiting;
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ itemKeys: [mission.itemKey], mode: "plan" });
  });

  it("keeps failed Claude dispatches in the Agent console and can retry then cancel them", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "claude_code");
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    const dispatchId = created.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "failed",
        error: "Claude remote control did not start",
        failureCode: "mcp_timeout",
        failureStage: "mcp",
      },
    });

    const health = await app.inject({
      method: "GET",
      url: "/api/v1/dispatches/health?days=7",
      headers: { cookie },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      total: 1,
      failed: 1,
      failureRate: 1,
      groups: {
        nodes: [{ key: "Mac mini", total: 1, failed: 1 }],
        agents: [{ key: "claude_code", total: 1, failed: 1 }],
        codes: [{ key: "mcp_timeout", total: 1, failed: 1 }],
      },
      recentFailures: [{
        id: dispatchId,
        failureCode: "mcp_timeout",
        failureStage: "mcp",
        diagnosticSnapshot: { nodeClientVersion: "1.2.3", agentVersion: "2.1.232" },
      }],
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(listed.json()).toMatchObject({
      sessions: [{
        id: `dispatch:${dispatchId}`,
        dispatchId,
        agentKind: "claude_code",
        status: "failed",
        lastError: "Claude remote control did not start",
        canReply: false,
        canRetry: true,
        canStop: false,
        canArchive: true,
      }],
    });

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/v1/dispatches/${dispatchId}/archive`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ archivedAt?: string }>().archivedAt).toBeTypeOf("string");
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json()).toMatchObject({
      sessions: [{
        id: `dispatch:${dispatchId}`,
        archivedAt: archived.json<{ archivedAt: string }>().archivedAt,
        archivedSource: "missiongo",
        canRetry: false,
        canArchive: true,
      }],
    });
    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/dispatches/${dispatchId}/archive`,
      headers: { cookie },
      payload: { archived: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ archivedAt?: string }>().archivedAt).toBeUndefined();

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ agentKind: "claude_code", mode: "plan", status: "queued" });
    const retryId = retried.json<{ id: string }>().id;

    const duplicateRetry = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/retry`,
      headers: { cookie },
    });
    expect(duplicateRetry.statusCode).toBe(409);
    expect(duplicateRetry.json()).toMatchObject({ code: "item_already_dispatched" });

    const stopped = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${retryId}/stop`,
      headers: { cookie },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ dispatch: { id: retryId, status: "cancelled" } });
  });

  it("mirrors, replies to and interrupts a launched Claude Remote Control session", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "claude_code");
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId: mission.productId,
        status: "ready",
        type: "task",
        priority: "normal",
        title: "Second linked work item",
        description: "Keep the shared session open until both items are done",
        environment: { platform: "web" },
      },
    });
    expect(second.statusCode).toBe(201);
    const secondKey = second.json<{ key: string }>().key;
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "claude_code",
        mode: "plan",
        itemKeys: [mission.itemKey, secondKey],
      },
    });
    const dispatchId = created.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    const sessionRef = "11111111-2222-4333-8444-555555555555";
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionRef,
      },
    })).statusCode).toBe(204);

    const nodeSessions = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    const mirrored = nodeSessions.json<{ sessions: Array<{ id: string }> }>().sessions[0]!;
    expect(nodeSessions.json()).toMatchObject({
      sessions: [{
        dispatchId, agentKind: "claude_code", sessionRef, status: "active",
        lifecycle: "keep", occupiesExecutionSlot: true,
      }],
    });
    const initialDispatches = (await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    })).json<{ dispatches: Array<{ sessionUrl?: string; agentSessionId?: string }> }>().dispatches;
    expect(initialDispatches[0]?.sessionUrl).toBeUndefined();
    expect(initialDispatches[0]?.agentSessionId).toBe(mirrored.id);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${mirrored.id}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "stalled",
        sessionUrl: "https://claude.ai/code/session_resumed",
        messages: [
          { sourceId: "u1", turnId: "turn-1", role: "user", text: "Inspect this." },
          {
            sourceId: "a1", turnId: "turn-1", role: "agent", text: "Working on it.",
            questions: [{ header: "Scope", title: "Which scope?", options: ["Small", "Complete"], multiSelect: false }],
          },
        ],
        activities: [{ id: "task-1", title: "Inspect synchronization", detail: "运行中" }],
      },
    })).statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(listed.json()).toMatchObject({
      sessions: [{
        agentKind: "claude_code", canReply: true, canStop: true,
        activities: [{ id: "task-1", title: "Inspect synchronization", detail: "运行中" }],
      }],
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${mirrored.id}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      status: "stalled",
      canReply: true,
      activities: [{ id: "task-1", title: "Inspect synchronization", detail: "运行中" }],
      messages: [{ sourceId: "u1" }, {
        sourceId: "a1",
        questions: [{ header: "Scope", title: "Which scope?", options: ["Small", "Complete"], multiSelect: false }],
      }],
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    })).json()).toMatchObject({
      dispatches: [{ sessionUrl: "https://claude.ai/code/session_resumed" }],
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${mirrored.id}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", clearSessionUrl: true, messages: [] },
    })).statusCode).toBe(204);
    const localDispatches = (await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    })).json<{ dispatches: Array<{ sessionUrl?: string }> }>().dispatches;
    expect(localDispatches[0]?.sessionUrl).toBeUndefined();
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${mirrored.id}/commands`,
      headers: { cookie },
      payload: { text: "Continue." },
    });
    const replyId = reply.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${mirrored.id}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "active", messages: [], commandId: replyId, commandStatus: "delivered" },
    });
    const stop = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/stop`,
      headers: { cookie },
    });
    expect(stop.statusCode).toBe(202);
    expect(stop.json()).toMatchObject({ command: { kind: "interrupt", turnId: "turn-1", status: "queued" } });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "in_progress", reason: "claim" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "development_complete", reason: "resolution_submitted" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "pending_verification", reason: "release_verified" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${secondKey}/transitions`,
      headers: { cookie },
      payload: { to: "in_progress", reason: "claim" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${secondKey}/transitions`,
      headers: { cookie },
      payload: { to: "development_complete", reason: "resolution_submitted" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${secondKey}/transitions`,
      headers: { cookie },
      payload: { to: "pending_verification", reason: "release_verified" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${mission.itemKey}/transitions`,
      headers: { cookie },
      payload: { to: "done", reason: "verification_passed" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json()).toMatchObject({
      sessions: [{ id: mirrored.id, canReply: true }],
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${mirrored.id}`,
      headers: { cookie },
    })).json()).toMatchObject({
      id: mirrored.id, canReply: true,
    });
    const awaitingVerification = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(awaitingVerification.json()).toMatchObject({
      sessions: [{ id: mirrored.id, lifecycle: "keep", occupiesExecutionSlot: true }],
    });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/items/${secondKey}/transitions`,
      headers: { cookie },
      payload: { to: "done", reason: "verification_passed" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json()).toMatchObject({
      sessions: [{ id: mirrored.id, canReply: false, replyBlockedReason: "work_finished" }],
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${mirrored.id}`,
      headers: { cookie },
    })).json()).toMatchObject({
      id: mirrored.id, canReply: false, replyBlockedReason: "work_finished",
    });
    const closing = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(closing.json()).toMatchObject({
      sessions: [{ id: mirrored.id, lifecycle: "close", occupiesExecutionSlot: true }],
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${mirrored.id}/commands`,
      headers: { cookie },
      payload: { text: "Continue after completion." },
    })).statusCode).toBe(409);
  });

  it("accepts a contract-valid snapshot larger than Fastify's 1 MiB default (AND-181)", async () => {
    const { app, cookie, node, mission, dispatchId } = await queuedDispatch();
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionRef: "31111111-2222-4333-8444-555555555555",
      },
    })).statusCode).toBe(204);
    const sessionId = (await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json<{ sessions: Array<{ id: string }> }>().sessions[0]!.id;

    // Sixteen messages of the per-message maximum put the JSON body well past
    // Fastify's 1 MiB default while staying inside the store's contract. The
    // 413 the default used to answer is indistinguishable from a network blip
    // to the node, so a large session silently stopped syncing.
    const longConversation = Array.from({ length: 16 }, (_unused, index) => ({
      sourceId: `u${index}`, turnId: `t${index}`, role: "user", text: "x".repeat(100_000),
    }));
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: longConversation },
    })).statusCode).toBe(204);
    const mirroredDetail = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
    })).json<{ messages: Array<{ sourceId: string; text: string }> }>();
    expect(mirroredDetail.messages).toHaveLength(16);
    expect(mirroredDetail.messages[0]).toMatchObject({ sourceId: "u0" });
    expect(mirroredDetail.messages[0]!.text).toHaveLength(100_000);

    // Past the route's own bound the 413 stays, so a hostile node cannot make
    // the server buffer an unbounded body.
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "idle",
        messages: [{ sourceId: "hostile", turnId: "t", role: "user", text: "x".repeat(33 * 1_024 * 1_024) }],
      },
    })).statusCode).toBe(413);
  });

  it("ends an idle long poll with 204 rather than holding it open", async () => {
    const { app } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);

    const started = Date.now();
    const idle = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
      payload: { waitMs: 150 },
    });
    expect(idle.statusCode).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("runs a Codex dispatch and keeps its thread link", async () => {
    const { app, cookie, databasePath } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "codex");
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });

    // A Claude Code mode is not offered to Codex.
    const claudeOnly = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "codex", mode: "acceptEdits", itemKeys: [mission.itemKey] },
    });
    expect(claudeOnly.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(created.statusCode).toBe(201);
    const dispatchId = created.json<{ id: string }>().id;

    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(claim.json()).toMatchObject({ dispatchId, agentKind: "codex", mode: "plan" });

    const link = "codex://threads/01a09f35-d6fa-7eb2-9d90-1352cf2fb661";
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionUrl: link,
        sessionRef: "01a09f35-d6fa-7eb2-9d90-1352cf2fb661",
      },
    });
    expect(result.statusCode).toBe(204);

    const dispatches = await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    });
    const launched = dispatches.json<{ dispatches: Array<{ sessionUrl: string; agentSessionId: string }> }>().dispatches[0]!;
    expect(launched).toMatchObject({ sessionUrl: link });
    expect(launched.agentSessionId).toBeTruthy();

    const nodeSessions = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(nodeSessions.json()).toMatchObject({
      sessions: [{ id: launched.agentSessionId, sessionRef: "01a09f35-d6fa-7eb2-9d90-1352cf2fb661" }],
    });

    const snapshot = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${launched.agentSessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "idle",
        activityAt: "2026-09-19T01:30:00.000Z",
        messages: [
          {
            sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it.",
            occurredAt: "2026-09-19T01:28:00.000Z",
          },
          {
            sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "I found the cause.",
            occurredAt: "2026-09-19T01:29:00.000Z",
          },
        ],
      },
    });
    expect(snapshot.statusCode).toBe(204);

    const sessionList = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(sessionList.statusCode).toBe(200);
    expect(sessionList.json()).toMatchObject({
      sessions: [{
        id: launched.agentSessionId,
        status: "idle",
        nodeName: "Mac mini",
        items: [{ key: mission.itemKey, title: "AND work", productId: mission.productId }],
        latestMessage: { role: "agent", text: "I found the cause." },
        canReply: true,
      }],
    });

    const webSession = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}`,
      headers: { cookie },
    });
    expect(webSession.json()).toMatchObject({
      status: "idle",
      messages: [
        { sourceId: "u1", role: "user", text: "Please inspect it.", occurredAt: "2026-09-19T01:28:00.000Z" },
        { sourceId: "a1", role: "agent", text: "I found the cause.", occurredAt: "2026-09-19T01:29:00.000Z" },
      ],
    });

    const fixedActivityAt = "2026-09-19T00:00:00.000Z";
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE agent_sessions SET updated_at = ?, activity_at = ? WHERE id = ?")
      .run(fixedActivityAt, fixedActivityAt, launched.agentSessionId);
    database.close();
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${launched.agentSessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "idle",
        messages: [
          { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
          { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "I found the cause." },
        ],
      },
    })).statusCode).toBe(204);
    const unchanged = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{ updatedAt: string; activityAt: string }> }>().sessions[0]!;
    expect(unchanged.activityAt).toBe(fixedActivityAt);
    expect(unchanged.updatedAt).not.toBe(fixedActivityAt);
    const unchangedDetail = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}`,
      headers: { cookie },
    })).json<{ messages: Array<{ sourceId: string; occurredAt: string }> }>();
    expect(unchangedDetail.messages).toMatchObject([
      { sourceId: "u1", occurredAt: "2026-09-19T01:28:00.000Z" },
      { sourceId: "a1", occurredAt: "2026-09-19T01:29:00.000Z" },
    ]);

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${launched.agentSessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "idle",
        activityAt: "2026-09-19T01:30:00.000Z",
        messages: [
          { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
          { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "I found another cause." },
        ],
      },
    })).statusCode).toBe(204);
    const changed = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{ activityAt: string }> }>().sessions[0]!;
    expect(changed.activityAt).toBe("2026-09-19T01:30:00.000Z");

    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands`,
      headers: { cookie },
      payload: { text: "Continue with the fix." },
    });
    expect(reply.statusCode).toBe(201);
    const commandId = reply.json<{ id: string }>().id;

    const commandPoll = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(commandPoll.json()).toMatchObject({
      sessions: [{ command: { id: commandId, status: "queued", text: "Continue with the fix." } }],
    });

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands/${commandId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: commandId, status: "cancelled" });
    expect(cancelled.json<{ cancelledAt: string }>().cancelledAt).toBeTruthy();

    const cancelledAgain = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands/${commandId}/cancel`,
      headers: { cookie },
    });
    expect(cancelledAgain.statusCode).toBe(200);
    expect(cancelledAgain.json()).toMatchObject({ id: commandId, status: "cancelled" });

    const replacement = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands`,
      headers: { cookie },
      payload: { text: "Continue with the corrected fix." },
    });
    expect(replacement.statusCode).toBe(201);
    const replacementId = replacement.json<{ id: string }>().id;

    const replacementPoll = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(replacementPoll.json()).toMatchObject({
      sessions: [{ command: { id: replacementId, status: "queued", text: "Continue with the corrected fix." } }],
    });

    const reserved = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${launched.agentSessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "idle",
        messages: [],
        commandId: replacementId,
        commandStatus: "delivering",
      },
    });
    expect(reserved.statusCode).toBe(204);

    const reservedCannotBeCancelled = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands/${replacementId}/cancel`,
      headers: { cookie },
    });
    expect(reservedCannotBeCancelled.statusCode).toBe(409);
    expect(reservedCannotBeCancelled.json()).toMatchObject({ code: "agent_reply_not_pending" });

    const duplicateWhileDelivering = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands`,
      headers: { cookie },
      payload: { text: "Do not send two replies." },
    });
    expect(duplicateWhileDelivering.statusCode).toBe(409);
    expect(duplicateWhileDelivering.json()).toMatchObject({ code: "agent_reply_pending" });

    const deliveringPoll = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(deliveringPoll.json()).toMatchObject({
      sessions: [{ command: { id: replacementId, status: "delivering" } }],
    });

    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${launched.agentSessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "active",
        messages: [],
        commandId: replacementId,
        commandStatus: "delivered",
      },
    });
    expect(acknowledged.statusCode).toBe(204);
    const afterReply = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}`,
      headers: { cookie },
    });
    expect(afterReply.json()).toMatchObject({ command: { id: replacementId, status: "delivered" } });

    const tooLate = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands/${replacementId}/cancel`,
      headers: { cookie },
    });
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json()).toMatchObject({ code: "agent_reply_not_pending" });

    const pendingReply = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${launched.agentSessionId}/commands`,
      headers: { cookie },
      payload: { text: "One more instruction before stopping." },
    });
    expect(pendingReply.statusCode).toBe(201);

    const stop = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/stop`,
      headers: { cookie },
    });
    expect(stop.statusCode).toBe(202);
    const interruptId = stop.json<{ command: { id: string } }>().command.id;
    const interruptPoll = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(interruptPoll.json()).toMatchObject({
      sessions: [{ command: { id: interruptId, kind: "interrupt", turnId: "t1", status: "queued" } }],
    });
  });

  it("dispatches OpenCode plan work and records its shared-service session", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "opencode");
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "opencode", mode: "plan", itemKeys: [mission.itemKey] },
    });
    expect(created.statusCode).toBe(201);
    const dispatchId = created.json<{ id: string }>().id;
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(claim.json()).toMatchObject({ dispatchId, agentKind: "opencode", mode: "plan" });
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "launched", sessionName: `Mac mini-${mission.itemKey}`, sessionRef: "ses_opencode_test" },
    });
    expect(result.statusCode).toBe(204);
    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(sessions.json()).toMatchObject({
      sessions: [{ agentKind: "opencode", sessionRef: "ses_opencode_test" }],
    });
  });

  it("reports Mac heartbeat health and stops then restores a manually archived Claude session", async () => {
    const { app, cookie, databasePath, node, mission, dispatchId } = await queuedDispatch();
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    const sessionRef = "11111111-2222-4333-8444-555555555555";
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: {
        status: "launched",
        sessionName: `Mac mini-${mission.itemKey}`,
        sessionUrl: "https://claude.ai/code/session_test",
        sessionRef,
      },
    })).statusCode).toBe(204);

    const listedOnline = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    const sessionId = listedOnline.json<{ sessions: Array<{ id: string }> }>().sessions[0]!.id;
    expect(listedOnline.json()).toMatchObject({
      sessions: [{ nodeConnectionState: "online", canReply: true, canArchive: true }],
    });
    const wrongArchivePath = await app.inject({
      method: "PATCH",
      url: `/api/v1/dispatches/${dispatchId}/archive`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(wrongArchivePath.statusCode).toBe(409);
    expect(wrongArchivePath.json()).toMatchObject({ code: "dispatch_has_agent_session" });

    const database = new DatabaseSync(databasePath);
    const unstableAt = new Date(Date.now() - 75_000).toISOString();
    database.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(unstableAt, node.nodeId);
    const listedUnstable = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(listedUnstable.json()).toMatchObject({
      sessions: [{ nodeConnectionState: "unstable", nodeLastSeenAt: unstableAt }],
    });

    const offlineAt = new Date(Date.now() - 100_000).toISOString();
    database.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(offlineAt, node.nodeId);
    database.close();
    const listedOffline = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(listedOffline.json()).toMatchObject({
      sessions: [{ nodeConnectionState: "offline", nodeLastSeenAt: offlineAt, canReply: true }],
    });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], sourceArchived: false },
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json()).toEqual({ sessions: [] });

    const staleSessionAt = new Date(Date.now() - 31_000).toISOString();
    const staleDatabase = new DatabaseSync(databasePath);
    staleDatabase.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(staleSessionAt, sessionId);
    staleDatabase.close();
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json()).toMatchObject({ sessions: [{ id: sessionId, status: "idle" }] });

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ archivedAt?: string }>().archivedAt).toBeTypeOf("string");

    const archivedList = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    });
    expect(archivedList.json()).toMatchObject({
      sessions: [{
        archivedAt: archived.json<{ archivedAt: string }>().archivedAt,
        canReply: false,
        replyBlockedReason: "archived",
        canStop: false,
      }],
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json()).toMatchObject({ sessions: [{ id: sessionId, lifecycle: "close" }] });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "suspended", messages: [], sourceArchived: true },
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json()).toEqual({ sessions: [] });
    const replyWhileArchived = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${sessionId}/commands`,
      headers: { cookie },
      payload: { text: "Do not send this yet." },
    });
    expect(replyWhileArchived.statusCode).toBe(409);
    expect(replyWhileArchived.json()).toMatchObject({ code: "agent_session_archived" });

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
      payload: { archived: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ archivedAt?: string }>().archivedAt).toBeUndefined();
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json()).toMatchObject({ sessions: [{ id: sessionId, lifecycle: "keep", restoreInSource: true }] });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "active", messages: [], sourceRestored: true },
    })).statusCode).toBe(204);

    const queuedOffline = await app.inject({
      method: "POST",
      url: `/api/v1/agent-sessions/${sessionId}/commands`,
      headers: { cookie },
      payload: { text: "Send when the Mac reconnects." },
    });
    expect(queuedOffline.statusCode).toBe(201);
    expect(queuedOffline.json()).toMatchObject({ status: "queued" });
  });

  it("refuses a Codex link that carries more than a thread id", async () => {
    const { app, node, dispatchId } = await queuedDispatch();
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "launched", sessionUrl: "codex://threads/abc?prompt=rm" },
    });
    expect(result.statusCode).toBe(400);
  });

  it("refuses a session URL that is not an https link", async () => {
    const { app, node, dispatchId } = await queuedDispatch();
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "launched", sessionUrl: "javascript:alert(1)" },
    });
    expect(result.statusCode).toBe(400);
  });

  it("keeps one node from reading or answering another node's dispatch", async () => {
    const { app, dispatchId } = await queuedDispatch();
    const other = await registeredNode(app, "Laptop");
    await heartbeat(app, other.token);

    expect((await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${other.token}` },
    })).statusCode).toBe(204);

    const stolen = await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { status: "launched" },
    });
    expect(stolen.statusCode).toBe(404);
  });


  describe("Gzip snapshot uploads (AND-182)", () => {
    /** A claimed, launched dispatch with one mirrored session to report into. */
    async function launchedSession() {
      const { app, cookie, node, mission, dispatchId } = await queuedDispatch();
      await app.inject({
        method: "POST",
        url: "/api/v1/node/dispatches/claim-next",
        headers: { authorization: `Bearer ${node.token}` },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/node/dispatches/${dispatchId}/result`,
        headers: { authorization: `Bearer ${node.token}` },
        payload: {
          status: "launched",
          sessionName: `Mac mini-${mission.itemKey}`,
          sessionRef: "11111111-2222-4333-8444-555555555555",
        },
      });
      const sessionId = (await app.inject({
        method: "GET",
        url: "/api/v1/node/agent-sessions",
        headers: { authorization: `Bearer ${node.token}` },
      })).json<{ sessions: Array<{ id: string }> }>().sessions[0]!.id;
      return { app, cookie, node, sessionId };
    }

    function snapshotPayload(messageCount: number, messageSize: number): string {
      return JSON.stringify({
        status: "idle",
        messages: Array.from({ length: messageCount }, (_, index) => ({
          sourceId: `u${index}`,
          turnId: "t1",
          role: "user",
          text: "x".repeat(messageSize),
        })),
      });
    }

    it("accepts a gzip-compressed snapshot and stores the decoded messages", async () => {
      const { app, cookie, node, sessionId } = await launchedSession();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
        headers: { authorization: `Bearer ${node.token}`, "content-encoding": "gzip", "content-type": "application/json" },
        payload: gzipSync(Buffer.from(snapshotPayload(3, 20_000), "utf8")),
      });
      expect(response.statusCode).toBe(204);

      const detail = (await app.inject({
        method: "GET",
        url: `/api/v1/agent-sessions/${sessionId}`,
        headers: { cookie },
      })).json<{ messages: Array<{ text: string }> }>();
      expect(detail.messages).toHaveLength(3);
      expect(detail.messages.every((message) => message.text.length === 20_000)).toBe(true);
    });

    it("refuses a corrupt gzip body", async () => {
      const { app, node, sessionId } = await launchedSession();
      // Random bytes, so the compressed stream really is a third of the body:
      // repeated text would compress below the cut and still decode whole.
      const whole = gzipSync(Buffer.from(JSON.stringify({
        status: "idle",
        messages: [0, 1].map((index) => ({
          sourceId: `u${index}`, turnId: "t1", role: "user", text: randomBytes(30_000).toString("base64"),
        })),
      }), "utf8"));
      const truncated = whole.subarray(0, Math.floor(whole.length / 3));
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
        headers: { authorization: `Bearer ${node.token}`, "content-encoding": "gzip", "content-type": "application/json" },
        payload: truncated,
      });
      if (response.statusCode !== 400) console.log("DBGA", response.statusCode, response.body.slice(0, 600));
      expect(response.statusCode).toBe(400);
    });

    it("carries a decoded body past the framework's default limit", async () => {
      const { app, node, sessionId } = await launchedSession();
      // ~2.1 MB decoded, over the 1 MiB default the route no longer inherits.
      const payload = Buffer.from(snapshotPayload(30, 70_000), "utf8");
      expect(payload.length).toBeGreaterThan(1024 * 1024);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
        headers: { authorization: `Bearer ${node.token}`, "content-encoding": "gzip", "content-type": "application/json" },
        payload: gzipSync(payload),
      });
      expect(response.statusCode).toBe(204);
    });

    it("still refuses a decoded body larger than the snapshot limit", async () => {
      const { app, node, sessionId } = await launchedSession();
      // ~32.3 MB decoded: over the route's 32 MiB bound even though the gzipped
      // wire body stays small -- the limit counts decoded bytes.
      const payload = Buffer.from(snapshotPayload(470, 72_000), "utf8");
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
        headers: { authorization: `Bearer ${node.token}`, "content-encoding": "gzip", "content-type": "application/json" },
        payload: gzipSync(payload),
      });
      if (response.statusCode !== 413) console.log("DGBB", response.statusCode, response.body.slice(0, 600));
      expect(response.statusCode).toBe(413);
    });
  });
});

describe("Account scoping", () => {
  it("hides another account's nodes and refuses to dispatch to them", async () => {
    const { app } = await signedInApp();
    const node = await registeredNode(app);
    await heartbeat(app, node.token);

    const { app: otherApp, cookie: otherCookie } = await signedInApp(adminAccount("account-test-2"));
    const visible = await otherApp.inject({ method: "GET", url: "/api/v1/nodes", headers: { cookie: otherCookie } });
    expect(visible.json<{ nodes: unknown[] }>().nodes).toEqual([]);

    // Same database would be the sharper test, but each app gets its own; what
    // this proves is that a node id from elsewhere is not addressable.
    const foreign = await otherApp.inject({
      method: "DELETE",
      url: `/api/v1/nodes/${node.nodeId}`,
      headers: { cookie: otherCookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

/** A launched Codex dispatch with a mirrored session, as the Mac reports one. */
async function launchedCodexSession(
  app: FastifyInstance, cookie: string, productName = "Mission GO", keyPrefix = "AND",
) {
  const node = await registeredNode(app);
  await heartbeat(app, node.token, "codex");
  const mission = await readyItem(app, cookie, productName, keyPrefix);
  await app.inject({
    method: "PUT",
    url: `/api/v1/nodes/${node.nodeId}/repos`,
    headers: { cookie },
    payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/dispatches",
    headers: { cookie },
    payload: { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey] },
  });
  const dispatchId = created.json<{ id: string }>().id;
  await app.inject({
    method: "POST",
    url: "/api/v1/node/dispatches/claim-next",
    headers: { authorization: `Bearer ${node.token}` },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/node/dispatches/${dispatchId}/result`,
    headers: { authorization: `Bearer ${node.token}` },
    payload: { status: "launched", sessionRef: randomUUID() },
  });
  const sessionId = (await app.inject({
    method: "GET",
    url: `/api/v1/items/${mission.itemKey}/dispatches`,
    headers: { cookie },
  })).json<{ dispatches: Array<{ agentSessionId: string }> }>().dispatches[0]!.agentSessionId;
  return { node, mission, dispatchId, sessionId };
}

describe("Unread conversations (AND-135)", () => {
  type Row = { id: string; unread: boolean; unreadAt?: string };

  async function row(app: FastifyInstance, cookie: string, productId: string): Promise<Row> {
    return (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${productId}`,
      headers: { cookie },
    })).json<{ sessions: Row[] }>().sessions[0]!;
  }

  async function snapshot(
    app: FastifyInstance,
    token: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(response.statusCode).toBe(204);
  }

  it("turns unread for a new Agent message and stays read through connectivity and sync noise", async () => {
    const { app, cookie, databasePath } = await signedInApp();
    const { node, mission, dispatchId, sessionId } = await launchedCodexSession(app, cookie);
    const answered = [
      { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
      { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "I found the cause." },
    ];

    // A launch that has said nothing yet is not something to come back for.
    expect((await row(app, cookie, mission.productId)).unread).toBe(false);

    await snapshot(app, node.token, sessionId, { status: "idle", messages: answered });
    const fresh = await row(app, cookie, mission.productId);
    expect(fresh).toMatchObject({ unread: true });
    expect(fresh.unreadAt).toBeTruthy();

    const read = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/read`,
      headers: { cookie },
      payload: { through: fresh.unreadAt },
    });
    expect(read.statusCode).toBe(204);
    expect((await row(app, cookie, mission.productId)).unread).toBe(false);

    // A sync error, its recovery, a plain re-read and the Mac dropping off the
    // network all used to relight old conversations.
    await snapshot(app, node.token, sessionId, {
      status: "unavailable", error: "Codex app-server is not running.", messages: answered,
    });
    await snapshot(app, node.token, sessionId, { status: "idle", messages: answered });
    await snapshot(app, node.token, sessionId, { status: "idle", messages: answered });
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", node.nodeId);
    database.close();
    expect((await row(app, cookie, mission.productId)).unread).toBe(false);

    // Streamed text growing on a message already seen is not a new message.
    await snapshot(app, node.token, sessionId, {
      status: "idle",
      messages: [answered[0], { ...answered[1], text: "I found the cause, and the fix." }],
    });
    expect((await row(app, cookie, mission.productId)).unread).toBe(false);

    await snapshot(app, node.token, sessionId, {
      status: "idle",
      messages: [...answered, { sourceId: "a2", turnId: "t2", role: "agent", text: "Here is a follow-up." }],
    });
    expect((await row(app, cookie, mission.productId)).unread).toBe(true);
  });

  it("keeps a message that lands after the displayed list unread", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, dispatchId, sessionId } = await launchedCodexSession(app, cookie);
    await snapshot(app, node.token, sessionId, {
      status: "active",
      messages: [{ sourceId: "a1", turnId: "t1", role: "agent", text: "Working on it." }],
    });
    const displayed = await row(app, cookie, mission.productId);
    // The turn ends between the list poll and the read call.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await snapshot(app, node.token, sessionId, {
      status: "idle",
      messages: [{ sourceId: "a1", turnId: "t1", role: "agent", text: "Working on it." }],
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/read`,
      headers: { cookie },
      payload: { through: displayed.unreadAt },
    });
    expect((await row(app, cookie, mission.productId)).unread).toBe(true);
  });

  it("refuses to mark another account's hand-off read", async () => {
    const { app, cookie } = await signedInApp();
    const { dispatchId } = await launchedCodexSession(app, cookie);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${randomUUID()}/read`,
      headers: { cookie },
      payload: { through: new Date().toISOString() },
    });
    expect(foreign.statusCode).toBe(404);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/dispatches/${dispatchId}/read`,
      headers: { cookie },
      payload: { through: "yesterday" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("Archiving a finished hand-off (AND-129)", () => {
  async function move(app: FastifyInstance, cookie: string, itemKey: string, steps: Array<[string, string]>) {
    for (const [to, reason] of steps) {
      const moved = await app.inject({
        method: "POST",
        url: `/api/v1/items/${itemKey}/transitions`,
        headers: { cookie },
        payload: { to, reason, note: `Moved to ${to} by the AND-129 test.` },
      });
      if (moved.statusCode !== 200) throw new Error(`${itemKey} → ${to}: ${moved.statusCode} ${moved.body}`);
    }
  }
  const toDone: Array<[string, string]> = [
    ["in_progress", "claim"],
    ["development_complete", "resolution_submitted"],
    ["pending_verification", "release_verified"],
    ["done", "verification_passed"],
  ];

  async function secondItem(app: FastifyInstance, cookie: string, productId: string) {
    const item = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId, status: "ready", type: "task", priority: "normal",
        title: "Second", description: "also dispatched", environment: { platform: "web" },
      },
    });
    return item.json<{ key: string }>().key;
  }

  async function batchSession(app: FastifyInstance, cookie: string) {
    const node = await registeredNode(app);
    await heartbeat(app, node.token, "codex");
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    const second = await secondItem(app, cookie, mission.productId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${node.nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    const dispatchId = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey, second] },
    })).json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/node/dispatches/${dispatchId}/result`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "launched", sessionRef: "thread-and-129" },
    });
    const sessionId = (await app.inject({
      method: "GET",
      url: `/api/v1/items/${mission.itemKey}/dispatches`,
      headers: { cookie },
    })).json<{ dispatches: Array<{ agentSessionId: string }> }>().dispatches[0]!.agentSessionId;
    return { node, mission, second, dispatchId, sessionId };
  }

  async function listed(app: FastifyInstance, cookie: string, productId: string) {
    return (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{ id: string; archivedAt?: string; activityAt: string; unread: boolean }> }>()
      .sessions[0]!;
  }

  async function nodeSessions(app: FastifyInstance, token: string) {
    return (await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${token}` },
    })).json<{ sessions: Array<{ id: string; archiveInSource?: boolean; lifecycle: string }> }>().sessions;
  }

  it("archives once every item is done or cancelled, asks the Mac to archive the Codex thread, and lets a restore stick", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, second, sessionId } = await batchSession(app, cookie);

    await move(app, cookie, mission.itemKey, toDone);
    const halfway = await listed(app, cookie, mission.productId);
    expect(halfway.archivedAt).toBeUndefined();

    await move(app, cookie, second, [["cancelled", "cancelled"]]);
    const finished = await listed(app, cookie, mission.productId);
    expect(finished.archivedAt).toBeTruthy();
    // Quiet: an automatic archive neither reorders the list nor makes it unread.
    expect(finished.activityAt).toBe(halfway.activityAt);
    expect(finished.unread).toBe(false);

    const asked = (await nodeSessions(app, node.token)).find((session) => session.id === sessionId);
    expect(asked).toMatchObject({ archiveInSource: true });

    const reported = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], sourceArchived: true },
    });
    expect(reported.statusCode).toBe(204);
    expect((await nodeSessions(app, node.token)).some((session) => session.id === sessionId)).toBe(false);
    const detail = (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
    })).json<{ archivedSource: string }>();
    // Still MissionGo's archive, so a person can restore it here.
    expect(detail.archivedSource).toBe("missiongo");

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
      payload: { archived: false },
    });
    expect(restored.statusCode).toBe(200);
    await move(app, cookie, mission.itemKey, [["ready", "reopened"], ...toDone]);
    expect((await listed(app, cookie, mission.productId)).archivedAt).toBeUndefined();
  });

  it("archives the Codex thread when a person archives in MissionGo, and restores it when they restore", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, sessionId } = await batchSession(app, cookie);
    const setArchived = (archived: boolean) => app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}`,
      headers: { cookie },
      payload: { archived },
    });
    const snapshot = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], ...payload },
    });

    // An idle session the Mac just reported on would otherwise wait out the
    // idle cool-down before the archive request reaches it.
    await snapshot({});
    expect((await setArchived(true)).statusCode).toBe(200);
    expect((await nodeSessions(app, node.token)).find((session) => session.id === sessionId))
      .toMatchObject({ archiveInSource: true });
    await snapshot({ sourceArchived: true });
    expect((await nodeSessions(app, node.token)).some((session) => session.id === sessionId)).toBe(false);

    expect((await setArchived(false)).statusCode).toBe(200);
    expect((await nodeSessions(app, node.token)).find((session) => session.id === sessionId))
      .toMatchObject({ restoreInSource: true });
    // A snapshot taken before the Mac restored the thread still reads it as
    // archived; that must not archive the conversation again.
    await snapshot({ sourceArchived: true });
    expect((await listed(app, cookie, mission.productId)).archivedAt).toBeUndefined();

    await snapshot({ sourceArchived: false, sourceRestored: true });
    expect((await nodeSessions(app, node.token)).find((session) => session.id === sessionId)?.restoreInSource)
      .toBeUndefined();
    expect((await listed(app, cookie, mission.productId)).archivedAt).toBeUndefined();
  });

  it("leaves a batch where everything was cancelled for a person", async () => {
    const { app, cookie } = await signedInApp();
    const { mission, second } = await batchSession(app, cookie);
    await move(app, cookie, mission.itemKey, [["cancelled", "cancelled"]]);
    await move(app, cookie, second, [["cancelled", "cancelled"]]);
    expect((await listed(app, cookie, mission.productId)).archivedAt).toBeUndefined();
  });

  it("stops asking for a source archive the Mac could not perform", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, second, sessionId } = await batchSession(app, cookie);
    await move(app, cookie, mission.itemKey, toDone);
    await move(app, cookie, second, toDone);
    await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], sourceArchiveError: "thread not found" },
    });
    expect((await nodeSessions(app, node.token)).some((session) => session.id === sessionId)).toBe(false);
    expect((await listed(app, cookie, mission.productId)).archivedAt).toBeTruthy();
  });
});

describe("Model, effort and running-session settings (AND-130)", () => {
  const codexModels = [
    { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
    { id: "gpt-5.5-mini", label: "GPT-5.5 mini", efforts: ["low", "medium"] },
  ];

  async function modelHeartbeat(app: FastifyInstance, token: string, models?: unknown) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/node/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agents: [{
          kind: "codex", version: "0.155.1", ...(models ? { models } : {}), ready: true,
          skill: { localVersion: MISSIONGO_SKILL_VERSION, expectedVersion: MISSIONGO_SKILL_VERSION, syncState: "ready" },
        }],
        repoCandidates: [],
      },
    });
    expect(response.statusCode).toBe(200);
  }

  async function mappedProduct(app: FastifyInstance, cookie: string, nodeId: string) {
    const mission = await readyItem(app, cookie, "Mission GO", "AND");
    await app.inject({
      method: "PUT",
      url: `/api/v1/nodes/${nodeId}/repos`,
      headers: { cookie },
      payload: { repos: [{ productId: mission.productId, repoPath: "/Users/dev/Projects/missiongo" }] },
    });
    return mission;
  }

  function dispatch(app: FastifyInstance, cookie: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/v1/dispatches", headers: { cookie }, payload });
  }

  it("dispatches with a model and effort the Mac offers and hands them to the Mac", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await modelHeartbeat(app, node.token, codexModels);
    const mission = await mappedProduct(app, cookie, node.nodeId);
    const base = { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey] };

    expect((await dispatch(app, cookie, { ...base, model: "gpt-9" })).statusCode).toBe(400);
    expect((await dispatch(app, cookie, { ...base, model: "gpt-5.5-mini", effort: "high" })).statusCode).toBe(400);
    const created = await dispatch(app, cookie, { ...base, model: "gpt-5.5", effort: "high" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ model: "gpt-5.5", effort: "high" });

    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/node/dispatches/claim-next",
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(claim.json()).toMatchObject({ mode: "plan", model: "gpt-5.5", effort: "high" });
  });

  it("refuses a model choice for a Mac whose client cannot make one, and still dispatches without", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    await modelHeartbeat(app, node.token);
    const mission = await mappedProduct(app, cookie, node.nodeId);
    const base = { nodeId: node.nodeId, agentKind: "codex", mode: "plan", itemKeys: [mission.itemKey] };
    const refused = await dispatch(app, cookie, { ...base, effort: "high" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "node_upgrade_required" });
    expect((await dispatch(app, cookie, base)).statusCode).toBe(201);
  });

  it("reports what the agent uses and carries a running change to the Mac once", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, sessionId } = await launchedCodexSession(app, cookie);
    await modelHeartbeat(app, node.token, codexModels);
    const listSettings = async () => (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{ settings: Record<string, unknown> }> }>().sessions[0]!.settings;
    const nodeSession = async () => (await app.inject({
      method: "GET",
      url: "/api/v1/node/agent-sessions",
      headers: { authorization: `Bearer ${node.token}` },
    })).json<{ sessions: Array<Record<string, unknown>> }>().sessions.find((session) => session.id === sessionId)!;
    const report = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], ...payload },
    });

    await report({ model: "gpt-5.5", effort: "medium" });
    expect(await listSettings()).toMatchObject({ mode: "plan", model: "gpt-5.5", effort: "medium", adjustable: true });

    const change = (payload: Record<string, unknown>) => app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}/settings`,
      headers: { cookie },
      payload,
    });
    expect((await change({ model: "gpt-9" })).statusCode).toBe(400);
    expect((await change({ mode: "acceptEdits" })).statusCode).toBe(400);
    const requested = await change({ mode: "default", effort: "high" });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ pending: { mode: "default", effort: "high", revision: 1 } });
    expect(await nodeSession()).toMatchObject({
      desiredSettings: { mode: "default", effort: "high", revision: 1 },
      appliedSettingsRevision: 0,
    });

    expect((await report({ model: "gpt-5.5", effort: "high", settingsRevision: 1 })).statusCode).toBe(204);
    const applied = await listSettings();
    expect(applied).toMatchObject({ mode: "default", effort: "high" });
    expect(applied.pending).toBeUndefined();
    // Nothing left to deliver, so the idle session drops out of the Mac's next poll.
    expect(await nodeSession()).toBeUndefined();

    // A change the Mac cannot apply is reported once and not sent again.
    await change({ model: "gpt-5.5-mini", effort: "low" });
    await report({ settingsRevision: 2, settingsError: "set_model failed" });
    const failed = await listSettings();
    expect(failed).toMatchObject({ error: "set_model failed", mode: "default" });
    expect(failed.pending).toBeUndefined();
    expect(await nodeSession()).toBeUndefined();
  });

  it("refuses to change a running session on a Mac whose client cannot", async () => {
    const { app, cookie } = await signedInApp();
    const { sessionId } = await launchedCodexSession(app, cookie);
    const refused = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent-sessions/${sessionId}/settings`,
      headers: { cookie },
      payload: { mode: "default" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "node_upgrade_required" });
  });

  it("keeps the custom endpoint a snapshot reports beside the model name (AND-161)", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, sessionId } = await launchedCodexSession(app, cookie);
    const listSettings = async () => (await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions?productId=${mission.productId}`,
      headers: { cookie },
    })).json<{ sessions: Array<{ settings: Record<string, unknown> }> }>().sessions[0]!.settings;
    const report = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${node.token}` },
      payload: { status: "idle", messages: [], ...payload },
    });

    // A proxy answering under the official model ids leaves `model` looking
    // official; the endpoint host is what says where the answers came from.
    await report({ model: "claude-opus-4-5", modelEndpoint: "proxy.internal.example" });
    expect(await listSettings()).toMatchObject({ model: "claude-opus-4-5", modelEndpoint: "proxy.internal.example" });

    // A later snapshot without one keeps the last known endpoint, the same way
    // it keeps the last known model.
    await report({ model: "claude-opus-4-5" });
    expect(await listSettings()).toMatchObject({ modelEndpoint: "proxy.internal.example" });
  });

  it("keeps an account's dispatch defaults", async () => {
    const { app, cookie } = await signedInApp();
    const node = await registeredNode(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/dispatch-defaults", headers: { cookie } })).json())
      .toEqual({ agents: { claude_code: { mode: "bypassPermissions" } } });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/dispatch-defaults",
      headers: { cookie },
      payload: {
        nodeId: node.nodeId,
        agentKind: "codex",
        agents: { codex: { mode: "default", model: "gpt-5.5", effort: "high" }, claude_code: { mode: "plan" } },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/dispatch-defaults", headers: { cookie } })).json())
      .toEqual({
        nodeId: node.nodeId,
        agentKind: "codex",
        agents: { codex: { mode: "default", model: "gpt-5.5", effort: "high" }, claude_code: { mode: "plan" } },
      });
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/dispatch-defaults",
      headers: { cookie },
      payload: { agents: { codex: { mode: "acceptEdits" } } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("Widget summary (AND-149)", () => {
  async function snapshot(app: FastifyInstance, token: string, sessionId: string, messages: unknown[]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/node/agent-sessions/${sessionId}/snapshot`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "idle", messages },
    });
    expect(response.statusCode).toBe(204);
  }

  async function summary(app: FastifyInstance, cookie: string) {
    const response = await app.inject({ method: "GET", url: "/api/v1/widget/summary", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<Record<string, Record<string, unknown>>>();
  }

  it("counts what the console and the ready list would show, across products", async () => {
    const { app, cookie } = await signedInApp();
    const { node, mission, sessionId } = await launchedCodexSession(app, cookie);
    await snapshot(app, node.token, sessionId, [
      { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
      {
        sourceId: "a1", turnId: "t1", role: "agent", text: "Pick a scope.",
        questions: [{ title: "Scope", options: ["Small", "Full"] }],
      },
    ]);
    const other = await readyItem(app, cookie, "Hermes GO", "HG");
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { cookie },
      payload: {
        productId: other.productId, status: "ready", type: "task", priority: "normal",
        title: "HG second", description: "more", environment: { platform: "web" },
      },
    });

    expect(await summary(app, cookie)).toMatchObject({
      agent: {
        attention: 1,
        active: 0,
        failed: 0,
        attentionProductId: mission.productId,
        attentionSessionId: sessionId,
      },
      items: { ready: 3, readyProductId: other.productId },
    });
  });

  it("gives every Mac the account's current cross-product attention count (AND-176)", async () => {
    const { app, cookie } = await signedInApp();
    const first = await launchedCodexSession(app, cookie);
    const second = await launchedCodexSession(app, cookie, "Another GO", "OTH");
    const count = (token: string) => app.inject({
      method: "GET", url: "/api/v1/node/attention-summary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await count(first.node.token)).json()).toEqual({ attention: 0 });

    for (const entry of [first, second]) {
      await snapshot(app, entry.node.token, entry.sessionId, [
        { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
        {
          sourceId: "a1", turnId: "t1", role: "agent", text: "Pick a scope.",
          questions: [{ title: "Scope", options: ["Small", "Full"] }],
        },
      ]);
    }
    const counted = await count(first.node.token);
    expect(counted.statusCode).toBe(200);
    expect(counted.headers["cache-control"]).toBe("no-store");
    expect(counted.json()).toEqual({ attention: 2 });
    expect((await count(second.node.token)).json()).toEqual({ attention: 2 });
    expect((await summary(app, cookie)).agent.attention).toBe(2);

    for (const [entry, remaining] of [[first, 1], [second, 0]] as const) {
      const archived = await app.inject({
        method: "PATCH", url: `/api/v1/agent-sessions/${entry.sessionId}`,
        headers: { cookie }, payload: { archived: true },
      });
      expect(archived.statusCode).toBe(200);
      expect((await count(first.node.token)).json()).toEqual({ attention: remaining });
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/node/attention-summary", headers: { cookie } })).statusCode).toBe(401);
    expect((await count(loginToken(app))).statusCode).toBe(401);
  });

  it("does not spend an AI call on a conversation still waiting to be classified", async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ needsAttention: false, kind: "none", reason: "Done." }) } }],
    }), { status: 200 }));
    const { app, cookie } = await signedInApp(adminAccount(), provider as typeof fetch);
    const { node, mission, sessionId } = await launchedCodexSession(app, cookie);
    // No key yet, so the snapshot leaves the reply pending instead of classifying it.
    await snapshot(app, node.token, sessionId, [
      { sourceId: "u1", turnId: "t1", role: "user", text: "Please inspect it." },
      { sourceId: "a1", turnId: "t1", role: "agent", phase: "final_answer", text: "I shipped it." },
    ]);
    await app.inject({
      method: "PUT",
      url: "/api/v1/ai/title-settings",
      headers: { cookie },
      payload: { apiKey: "secret-deepseek-key" },
    });

    await summary(app, cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider).not.toHaveBeenCalled();

    // The console's own list still classifies, which is what keeps this test honest.
    await app.inject({ method: "GET", url: `/api/v1/agent-sessions?productId=${mission.productId}`, headers: { cookie } });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
  });

  it("asks for a signed-in account", async () => {
    const { app } = await signedInApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/widget/summary" })).statusCode).toBe(401);
  });
});
