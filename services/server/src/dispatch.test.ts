import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID, scryptSync } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createAiAccessToken, type AdminAccountConfig } from "./admin-auth.js";

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

async function signedInApp(account: AdminAccountConfig = adminAccount()) {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-dispatch-"));
  temporaryDirectories.push(directory);
  const app = buildApp({
    databasePath: join(directory, "missiongo.sqlite"),
    attachmentsPath: join(directory, "attachments"),
    adminAccount: account,
  });
  apps.push(app);
  accountsByApp.set(app, account);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: account.username, password: "correct horse" },
  });
  const cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;
  return { app, cookie };
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
  return createAiAccessToken(accountsByApp.get(app)!, "mgc_macos_test", scopes).token;
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
    payload: { agents: [{ kind, version: "2.1.232" }], repoCandidates },
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
    expect(authorize.body).toContain("把这台 Mac 登记为执行机器");
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
        mode: "bypassPermissions",
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
  async function queuedDispatch() {
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
    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/dispatches",
      headers: { cookie },
      payload: { nodeId: node.nodeId, agentKind: "claude_code", mode: "plan", itemKeys: [mission.itemKey] },
    });
    return { app, cookie, node, mission, dispatchId: dispatch.json<{ id: string }>().id };
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
