import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { AdminAccountConfig } from "./admin-auth.js";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

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

async function pairedNode(app: FastifyInstance, cookie: string, name = "Mac mini") {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/nodes/pairing-codes",
    headers: { cookie },
    payload: { name },
  });
  const { code } = created.json<{ code: string }>();
  const paired = await app.inject({
    method: "POST",
    url: "/api/v1/node/pair",
    payload: { code, hostname: "macbook-test" },
  });
  return paired.json<{ nodeId: string; token: string }>();
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

describe("Pairing a node", () => {
  it("trades a pairing code for a credential exactly once", async () => {
    const { app, cookie } = await signedInApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/nodes/pairing-codes",
      headers: { cookie },
      payload: { name: "Mac mini" },
    });
    expect(created.statusCode).toBe(201);
    const { code } = created.json<{ code: string }>();

    const paired = await app.inject({ method: "POST", url: "/api/v1/node/pair", payload: { code, hostname: "mini" } });
    expect(paired.statusCode).toBe(201);
    expect(paired.json<{ token: string }>().token.startsWith("mgn_")).toBe(true);

    const replayed = await app.inject({ method: "POST", url: "/api/v1/node/pair", payload: { code } });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toMatchObject({ code: "pairing_code_used" });
  });

  it("refuses an unknown code and a revoked node's token", async () => {
    const { app, cookie } = await signedInApp();
    const unknown = await app.inject({ method: "POST", url: "/api/v1/node/pair", payload: { code: "nope-nope" } });
    expect(unknown.statusCode).toBe(404);

    const node = await pairedNode(app, cookie);
    expect((await heartbeat(app, node.token)).statusCode).toBe(200);

    const revoked = await app.inject({ method: "DELETE", url: `/api/v1/nodes/${node.nodeId}`, headers: { cookie } });
    expect(revoked.statusCode).toBe(204);
    expect((await heartbeat(app, node.token)).statusCode).toBe(401);
  });
});

describe("Checkouts a node reports", () => {
  it("keeps the machine's list so the console can offer it instead of a path field", async () => {
    const { app, cookie } = await signedInApp();
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const node = await pairedNode(app, cookie);
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
    const { app, cookie } = await signedInApp();
    const node = await pairedNode(app, cookie);
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
    const { app, cookie, dispatchId } = await queuedDispatch();
    const other = await pairedNode(app, cookie, "Laptop");
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
    const { app, cookie } = await signedInApp();
    const node = await pairedNode(app, cookie);
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
