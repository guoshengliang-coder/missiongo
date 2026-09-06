import { createHash, scryptSync } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MISSIONGO_SKILL_DOWNLOAD_PATH, MISSIONGO_SKILL_VERSION } from "@missiongo/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createAiAccessToken, type AdminAccountConfig } from "./admin-auth.js";
import { buildApp } from "./app.js";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

function testAdminAccount(authorizedProductIds?: readonly string[]): AdminAccountConfig {
  const salt = Buffer.from("missiongo-test-salt");
  return {
    id: "account-test-1",
    username: "mission-owner",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
    sessionSecret: "test-session-secret-that-is-not-used-in-production",
    cookieSecure: true,
    ...(authorizedProductIds ? { authorizedProductIds } : {}),
  };
}

async function testApp(): Promise<{ app: FastifyInstance; databasePath: string; attachmentsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-server-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "missiongo.sqlite");
  const attachmentsPath = join(directory, "attachments");
  const app = buildApp({ databasePath, attachmentsPath });
  apps.push(app);
  return { app, databasePath, attachmentsPath };
}

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MissionGo REST API", () => {
  it("serves an authenticated, complete, read-only MCP item context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-mcp-"));
    temporaryDirectories.push(directory);
    const adminAccount = testAdminAccount();
    const mcpAccessToken = createAiAccessToken(adminAccount, "missiongo-test-client").token;
    const app = buildApp({
      databasePath: join(directory, "missiongo.sqlite"),
      attachmentsPath: join(directory, "attachments"),
      adminToken: "management-test-token",
      adminAccount,
      publicOrigin: "https://missiongo.test",
    });
    apps.push(app);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    });
    expect(unauthorized.statusCode).toBe(401);

    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", headers: { authorization: "Bearer management-test-token" }, payload: { name: "Hermes Go", keyPrefix: "HG" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      headers: { authorization: "Bearer management-test-token" },
      payload: { productId: product.id, type: "bug", priority: "high", title: "Crash", description: "Fails on launch", environment: { platform: "other" } },
    });
    const uploadedLog = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        authorization: "Bearer management-test-token",
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-filename": "launch.log",
      },
      payload: "Fatal exception at launch\n",
    });
    const attachmentId = uploadedLog.json<{ id: string }>().id;
    const uploadedImage = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        authorization: "Bearer management-test-token",
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/png",
        "x-missiongo-filename": "launch.png",
      },
      payload: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    expect(uploadedImage.statusCode).toBe(201);
    const imageAttachmentId = uploadedImage.json<{ id: string }>().id;
    const timelineCountBeforeRead = app.missionGoStore.getTimeline("HG-1").length;

    const call = async (id: number, method: string, params: Readonly<Record<string, unknown>> = {}) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${mcpAccessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id, method, params },
      });
      expect(response.statusCode, response.body).toBe(200);
      const payload = response.headers["content-type"]?.includes("text/event-stream")
        ? response.body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
        : response.body;
      if (!payload) throw new Error("MCP response did not contain a JSON payload.");
      return JSON.parse(payload) as { result?: Record<string, unknown>; error?: unknown };
    };

    const initialized = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "missiongo-test", version: "1.0.0" },
    });
    expect(initialized.result).toMatchObject({ serverInfo: { name: "missiongo" } });

    const tools = await call(2, "tools/list");
    const names = (tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "get_current_account",
      "list_products",
      "list_components",
      "list_items",
      "get_item_context",
      "get_item_timeline",
      "get_attachment",
    ]);
    expect(names.some((name) => name.toLowerCase().includes("sql"))).toBe(false);

    const context = await call(3, "tools/call", { name: "get_item_context", arguments: { itemKey: "HG-1" } });
    expect(context.error).toBeUndefined();
    expect(context.result?.structuredContent).toMatchObject({
      item: {
        key: "HG-1",
        status: "inbox",
        attachments: [
          { id: attachmentId, kind: "log", displayNumber: 1 },
          { id: imageAttachmentId, kind: "image", displayNumber: 1 },
        ],
      },
      product: { id: product.id, name: "Hermes Go", keyPrefix: "HG" },
      sourceComponent: null,
      affectedComponents: [],
      attachmentCount: 2,
      timelineEventCount: timelineCountBeforeRead,
    });

    const attachment = await call(4, "tools/call", {
      name: "get_attachment",
      arguments: { itemKey: "HG-1", attachmentId, maxBytes: 8 },
    });
    expect(attachment.result?.structuredContent).toMatchObject({ text: "Fatal ex", nextOffsetBytes: 8 });
    const finalLogChunk = await call(5, "tools/call", {
      name: "get_attachment",
      arguments: { itemKey: "HG-1", attachmentId, offsetBytes: 8, maxBytes: 64 },
    });
    expect(finalLogChunk.result?.structuredContent).toMatchObject({ text: "ception at launch\n" });
    expect(finalLogChunk.result?.structuredContent).not.toHaveProperty("nextOffsetBytes");

    const image = await call(6, "tools/call", {
      name: "get_attachment",
      arguments: { itemKey: "HG-1", attachmentId: imageAttachmentId },
    });
    expect(image.result?.structuredContent).toMatchObject({
      attachment: { id: imageAttachmentId, kind: "image" },
      inline: true,
      representation: "scaled_preview",
      preview: { contentType: "image/jpeg", width: 1, height: 1 },
    });
    expect(image.result?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));

    expect((await app.inject({ method: "GET", url: "/api/v1/items/HG-1", headers: { authorization: "Bearer management-test-token" } })).json()).toMatchObject({ status: "inbox" });
    expect(app.missionGoStore.getTimeline("HG-1")).toHaveLength(timelineCountBeforeRead);
  });

  it("uses first-time account login and limits AI reads to authorized products", async () => {
    const allowedProductIds: string[] = [];
    const adminAccount = testAdminAccount(allowedProductIds);
    const app = buildApp({ adminAccount, publicOrigin: "https://missiongo.test" });
    apps.push(app);

    const allowed = app.missionGoStore.createProduct({ name: "Allowed", keyPrefix: "OK" });
    const blocked = app.missionGoStore.createProduct({ name: "Blocked", keyPrefix: "NO" });
    allowedProductIds.push(allowed.id);
    app.missionGoStore.createWorkItem({
      productId: blocked.id,
      type: "bug",
      priority: "normal",
      title: "Must stay private",
      description: "Account cannot read this item",
    });

    const protectedMetadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(protectedMetadata.statusCode).toBe(200);
    expect(protectedMetadata.json()).toMatchObject({
      resource: "https://missiongo.test/mcp",
      authorization_servers: ["https://missiongo.test"],
      scopes_supported: ["missiongo:read"],
    });

    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Test AI",
        redirect_uris: ["http://127.0.0.1:49152/callback"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(registration.statusCode).toBe(201);
    const clientId = registration.json<{ client_id: string }>().client_id;
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:49152/callback",
        response_type: "code",
        state: "state-123",
        scope: "missiongo:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    });
    expect(authorize.statusCode).toBe(200);
    const requestToken = /name="request" value="([^"]+)"/.exec(authorize.body)?.[1];
    expect(requestToken).toBeTruthy();

    const invalidLogin = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ request: requestToken!, username: "mission-owner", password: "wrong" }).toString(),
    });
    expect(invalidLogin.statusCode).toBe(401);
    expect(invalidLogin.body).toContain("用户名或密码不正确");

    const login = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ request: requestToken!, username: "mission-owner", password: "correct horse" }).toString(),
    });
    expect(login.statusCode).toBe(302);
    const callback = new URL(login.headers.location!);
    expect(callback.searchParams.get("state")).toBe("state-123");

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:49152/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode, token.body).toBe(200);
    const accessToken = token.json<{ access_token: string }>().access_token;

    const call = async (id: number, name: string, args: Record<string, unknown> = {}) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      });
      expect(response.statusCode, response.body).toBe(200);
      const payload = response.headers["content-type"]?.includes("text/event-stream")
        ? response.body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
        : response.body;
      if (!payload) throw new Error("MCP response did not contain a JSON payload.");
      return (JSON.parse(payload) as { result: { structuredContent?: unknown; isError?: boolean; content?: unknown } }).result;
    };

    expect((await call(1, "get_current_account")).structuredContent).toMatchObject({
      account: { id: "account-test-1", username: "mission-owner" },
      permission: { allProducts: false, productIds: [allowed.id] },
      skill: {
        expectedVersion: MISSIONGO_SKILL_VERSION,
        updateUrl: `https://missiongo.test${MISSIONGO_SKILL_DOWNLOAD_PATH}`,
      },
    });
    expect((await call(2, "list_products")).structuredContent).toEqual({ products: [allowed] });
    const forbidden = await call(3, "get_item_context", { itemKey: "NO-1" });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).not.toContain("Must stay private");
  });

  it("runs an idempotent AI processing lease through pending human verification", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "MissionGo", keyPrefix: "MG" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "task",
        priority: "normal",
        title: "Add processing workflow",
        description: "Let an AI claim, report, and hand work back for verification.",
        environment: { platform: "other" },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/items/MG-1/transitions",
      payload: { to: "ready", reason: "triaged" },
    });

    const claimInput = {
      itemKey: "MG-1",
      agentId: "codex-test",
      mode: "process" as const,
      leaseSeconds: 900,
      idempotencyKey: "claim-mg-1",
    };
    const claim = app.missionGoStore.claimExecution(claimInput);
    const repeatedClaim = app.missionGoStore.claimExecution(claimInput);
    expect(repeatedClaim).toEqual(claim);
    expect(claim).toMatchObject({ itemKey: "MG-1", status: "running", activeLease: { id: expect.any(String) } });
    expect((await app.inject({ method: "GET", url: "/api/v1/items/MG-1" })).json()).toMatchObject({
      status: "in_progress",
    });

    const leaseId = claim.activeLease!.id;
    app.missionGoStore.appendExecutionProgress({
      executionId: claim.id,
      leaseId,
      message: "Implementation and tests are complete.",
      idempotencyKey: "progress-mg-1",
    });
    expect(() => app.missionGoStore.markExecutionPendingVerification({
      executionId: claim.id,
      leaseId,
      idempotencyKey: "pending-too-early-mg-1",
    })).toThrowError(/resolution report/);
    const resolved = app.missionGoStore.submitExecutionResolution({
      executionId: claim.id,
      leaseId,
      report: {
        conclusion: "The requested workflow is implemented.",
        changeSummary: "Added a lease-backed processing lifecycle.",
        affectedFiles: ["services/server/src/store.ts"],
        checks: [{ name: "tests", outcome: "passed", summary: "All tests passed." }],
        remainingRisks: [],
        manualVerificationSteps: ["Review the timeline and approve the item."],
      },
      idempotencyKey: "resolution-mg-1",
    });
    expect(resolved).toMatchObject({ status: "succeeded", report: { checks: [{ outcome: "passed" }] } });

    const pending = app.missionGoStore.markExecutionPendingVerification({
      executionId: claim.id,
      leaseId,
      idempotencyKey: "pending-mg-1",
    });
    expect(pending.activeLease).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/v1/items/MG-1" })).json()).toMatchObject({
      status: "pending_verification",
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/items/MG-1/transitions",
      payload: { to: "done", reason: "verification_passed", note: "Human verification passed." },
    });
    expect(accepted.json()).toMatchObject({ status: "done" });

    const events = (await app.inject({ method: "GET", url: "/api/v1/items/MG-1/timeline" })).json<{
      events: Array<{ eventType: string }>;
    }>().events;
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "execution_claimed",
      "execution_progress",
      "resolution_submitted",
    ]));
  });

  it("prevents concurrent claims and safely pauses, resumes, and releases an execution", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Hermes Go", keyPrefix: "HG" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "bug",
        priority: "high",
        title: "Needs a product decision",
        description: "The safe behavior is ambiguous.",
        environment: { platform: "other" },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/transitions",
      payload: { to: "ready", reason: "triaged" },
    });

    const claimed = app.missionGoStore.claimExecution({
      itemKey: "HG-1",
      agentId: "codex-one",
      mode: "process",
      leaseSeconds: 900,
      idempotencyKey: "claim-hg-1-one",
    });
    expect(() => app.missionGoStore.claimExecution({
      itemKey: "HG-1",
      agentId: "codex-two",
      mode: "process",
      leaseSeconds: 900,
      idempotencyKey: "claim-hg-1-two",
    })).toThrowError(/active AI lease/);

    const paused = app.missionGoStore.requestExecutionHumanInput({
      executionId: claimed.id,
      leaseId: claimed.activeLease!.id,
      question: "Should this preserve the existing fallback behavior?",
      idempotencyKey: "question-hg-1",
    });
    expect(paused).toMatchObject({ status: "waiting_for_human", humanQuestion: expect.any(String) });
    expect(paused.activeLease).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/v1/items/HG-1" })).json()).toMatchObject({ status: "on_hold" });

    const resumed = app.missionGoStore.resumeExecution({
      executionId: claimed.id,
      leaseSeconds: 900,
      idempotencyKey: "resume-hg-1",
    });
    expect(resumed).toMatchObject({ status: "running", activeLease: { id: expect.any(String) } });
    const released = app.missionGoStore.releaseExecution({
      executionId: claimed.id,
      leaseId: resumed.activeLease!.id,
      note: "The user asked to defer this change.",
      idempotencyKey: "release-hg-1",
    });
    expect(released).toMatchObject({ status: "aborted" });
    expect(released.activeLease).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/v1/items/HG-1" })).json()).toMatchObject({ status: "ready" });
  });

  it("protects management routes when an admin token is configured", async () => {
    const app = buildApp({ adminToken: "example-test-token" });
    apps.push(app);

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ code: "authentication_required" });

    const authorized = await app.inject({
      method: "GET",
      url: "/api/v1/products",
      headers: { authorization: "Bearer example-test-token" },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("replaces attachment content in place, keeping its number and recording the edit", async () => {
    const { app, attachmentsPath } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Mission GO", keyPrefix: "AND" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "requirement",
        priority: "normal",
        title: "Annotate screenshots",
        description: "Circle the problem area",
        environment: { platform: "android" },
      },
    });

    const upload = (kind: string, filename: string, contentType: string, payload: string | Buffer) => app.inject({
      method: "POST",
      url: "/api/v1/items/AND-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": contentType,
        "x-missiongo-filename": filename,
      },
      payload,
    });

    const first = (await upload("image", "before.png", "image/png", "original-bytes")).json<{ id: string; displayNumber: number }>();
    const second = (await upload("image", "other.png", "image/png", "second-bytes")).json<{ displayNumber: number }>();
    expect(first.displayNumber).toBe(1);
    expect(second.displayNumber).toBe(2);

    const storedBefore = await readdir(attachmentsPath);
    expect(storedBefore).toHaveLength(2);

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/v1/items/AND-1/attachments/${first.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/jpeg",
        "x-missiongo-filename": "before.jpg",
      },
      payload: "annotated-bytes",
    });
    expect(replaced.statusCode).toBe(200);

    // The identity a reader cites has to survive the edit: deleting and
    // re-uploading would have handed this image number 3.
    expect(replaced.json()).toMatchObject({
      id: first.id,
      displayNumber: 1,
      filename: "before.jpg",
      contentType: "image/jpeg",
    });

    const content = await app.inject({ method: "GET", url: `/api/v1/items/AND-1/attachments/${first.id}/content` });
    expect(content.body).toBe("annotated-bytes");

    // The superseded file must not linger in the attachment directory.
    expect(await readdir(attachmentsPath)).toHaveLength(2);

    const timeline = (await app.inject({ method: "GET", url: "/api/v1/items/AND-1/timeline" }))
      .json<{ events: readonly { eventType: string; payload: Record<string, unknown> }[] }>();
    const edit = timeline.events.find((event) => event.eventType === "attachment_replaced");
    expect(edit?.payload).toMatchObject({
      attachmentId: first.id,
      displayNumber: 1,
      filename: "before.jpg",
      previousFilename: "before.png",
    });
  });

  it("refuses a replacement that would change the attachment kind or break its rules", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Mission GO", keyPrefix: "AND" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "requirement",
        priority: "normal",
        title: "Annotate screenshots",
        description: "Circle the problem area",
        environment: { platform: "android" },
      },
    });
    const image = (
      await app.inject({
        method: "POST",
        url: "/api/v1/items/AND-1/attachments",
        headers: {
          "content-type": "application/octet-stream",
          "x-missiongo-content-type": "image/png",
          "x-missiongo-filename": "shot.png",
        },
        payload: "original-bytes",
      })
    ).json<{ id: string }>();

    const replace = (filename: string, contentType: string, payload: string) => app.inject({
      method: "PUT",
      url: `/api/v1/items/AND-1/attachments/${image.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": contentType,
        "x-missiongo-filename": filename,
      },
      payload,
    });

    // An image numbered "image 1" must not quietly become a log.
    expect((await replace("notes.log", "text/plain", "log-bytes")).statusCode).toBe(400);
    expect((await replace("shot.png", "image/jpeg", "mismatched")).statusCode).toBe(400);
    expect((await replace("shot.bmp", "image/bmp", "unsupported")).statusCode).toBe(400);

    // The original content survived every rejection.
    const content = await app.inject({ method: "GET", url: `/api/v1/items/AND-1/attachments/${image.id}/content` });
    expect(content.body).toBe("original-bytes");
  });

  it("sets baseline security headers without duplicating them", async () => {
    const { app } = await testApp();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
    expect(health.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Hermes Go", keyPrefix: "HG" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "bug",
        priority: "high",
        title: "Crash",
        description: "Fails on launch",
        environment: { platform: "other" },
      },
    });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-filename": "launch.log",
      },
      payload: "Fatal exception at launch\n",
    });

    // The attachment route sets nosniff itself; the global hook must not turn
    // that into a repeated header.
    const content = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${uploaded.json<{ id: string }>().id}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["x-frame-options"]).toBe("DENY");
  });

  it("keeps the sign-in rate limit effective when a client spoofs X-Forwarded-For", async () => {
    // buildApp defaults to trustProxy:false, so a forged X-Forwarded-For must not
    // give an attacker a fresh rate-limit bucket for every request.
    const app = buildApp({ adminAccount: testAdminAccount() });
    apps.push(app);

    const attempt = (index: number) => app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-for": `203.0.113.${index}` },
      payload: { username: "mission-owner", password: "wrong password" },
    });

    for (let index = 1; index <= 10; index += 1) {
      expect((await attempt(index)).statusCode).toBe(401);
    }

    const blocked = await attempt(11);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "login_rate_limited" });

    // The OAuth consent page shares the same limiter and must stay blocked too.
    const oauthBlocked = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: {
        "x-forwarded-for": "198.51.100.9",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "request=&username=mission-owner&password=wrong+password",
    });
    expect(oauthBlocked.statusCode).toBe(429);
  });

  it("signs in the configured administrator with a secure account session", async () => {
    const app = buildApp({
      adminAccount: testAdminAccount(),
    });
    apps.push(app);

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(unauthorized.statusCode).toBe(401);

    const invalidLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "mission-owner", password: "wrong password" },
    });
    expect(invalidLogin.statusCode).toBe(401);
    expect(invalidLogin.json()).toMatchObject({ code: "invalid_credentials" });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "mission-owner", password: "correct horse" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      user: { id: "account-test-1", username: "mission-owner", role: "admin" },
    });
    expect(login.headers["set-cookie"]).toContain("missiongo_session=");
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(login.headers["set-cookie"]).toContain("Secure");
    const cookie = login.headers["set-cookie"]!.split(";", 1)[0]!;

    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({
      user: { id: "account-test-1", username: "mission-owner", role: "admin" },
    });
    const authorized = await app.inject({ method: "GET", url: "/api/v1/products", headers: { cookie } });
    expect(authorized.statusCode).toBe(200);

    const tamperedSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `${cookie}tampered` },
    });
    expect(tamperedSession.statusCode).toBe(401);

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("flattens legacy component hierarchies without removing modules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-legacy-components-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "missiongo.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        key_prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        next_item_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_item_sequence > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE components (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        parent_component_id TEXT REFERENCES components(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (product_id, name)
      ) STRICT;
      CREATE INDEX idx_components_parent ON components(parent_component_id);
      INSERT INTO products (id, key_prefix, name, created_at, updated_at)
      VALUES ('product-1', 'HG', 'Hermes Go', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
      INSERT INTO components (id, product_id, parent_component_id, name, kind, created_at, updated_at)
      VALUES
        ('clients', 'product-1', NULL, 'Clients', 'shared', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z'),
        ('android', 'product-1', 'clients', 'Android', 'android', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
    `);
    legacyDatabase.close();

    const app = buildApp({ databasePath, attachmentsPath: join(directory, "attachments") });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/products/product-1/components" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: "android", name: "Android" }),
      expect.objectContaining({ id: "clients", name: "Clients" }),
    ]);
    expect(response.json().every((component: Record<string, unknown>) => !("parentComponentId" in component))).toBe(true);

    const columns = app.missionGoStore.database.connection
      .prepare("PRAGMA table_info(components)")
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("parent_component_id");
  });

  it("adds structured report storage when opening an existing database", async () => {
    const { app, databasePath, attachmentsPath } = await testApp();
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec("ALTER TABLE work_items DROP COLUMN report_json;");
    legacyDatabase.prepare("DELETE FROM schema_migrations WHERE version = ?").run(8);
    legacyDatabase.close();

    const restarted = buildApp({ databasePath, attachmentsPath });
    apps.push(restarted);
    const columns = restarted.missionGoStore.database.connection
      .prepare("PRAGMA table_info(work_items)")
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("report_json");
    const migration = restarted.missionGoStore.database.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(8) as unknown as { version: number };
    expect(migration.version).toBe(8);
  });

  it("adds stable attachment numbers when opening an existing database", async () => {
    const { app, databasePath, attachmentsPath } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Legacy media", keyPrefix: "LM" } })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: { productId: product.id, type: "bug", priority: "normal", title: "Legacy item", description: "Has media", environment: { platform: "web" } },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/items/LM-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/jpeg",
        "x-missiongo-filename": "legacy.jpg",
      },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec("DROP INDEX IF EXISTS idx_work_item_attachments_item_kind_number;");
    legacyDatabase.exec("DROP TABLE work_item_attachment_counters;");
    legacyDatabase.exec("ALTER TABLE work_item_attachments DROP COLUMN display_number;");
    legacyDatabase.prepare("DELETE FROM schema_migrations WHERE version = ?").run(11);
    legacyDatabase.close();

    const restarted = buildApp({ databasePath, attachmentsPath });
    apps.push(restarted);
    const detail = await restarted.inject({ method: "GET", url: "/api/v1/items/LM-1" });
    expect(detail.json()).toMatchObject({ attachments: [expect.objectContaining({ displayNumber: 1 })] });
    const nextImage = await restarted.inject({
      method: "POST",
      url: "/api/v1/items/LM-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/jpeg",
        "x-missiongo-filename": "next.jpg",
      },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(nextImage.json()).toMatchObject({ displayNumber: 2 });
    const migration = restarted.missionGoStore.database.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(11) as unknown as { version: number };
    expect(migration.version).toBe(11);
  });

  it("creates a product, components, and sequential work items", async () => {
    const { app } = await testApp();

    const productResponse = await app.inject({
      method: "POST",
      url: "/api/v1/products",
      payload: { name: "Hermes Go", keyPrefix: "hg" },
    });
    expect(productResponse.statusCode).toBe(201);
    const product = productResponse.json<{ id: string; keyPrefix: string }>();
    expect(product.keyPrefix).toBe("HG");

    const missingPlatformResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        status: "ready",
        type: "idea",
        priority: "normal",
        title: "Missing platform",
        description: "",
      },
    });
    expect(missingPlatformResponse.statusCode).toBe(400);

    const androidResponse = await app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/components`,
      payload: { name: "Android", kind: "android" },
    });
    const android = androidResponse.json<{ id: string }>();
    expect(androidResponse.statusCode).toBe(201);

    const clientsResponse = await app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/components`,
      payload: { name: "Clients", kind: "shared" },
    });
    const clients = clientsResponse.json<{ id: string }>();
    expect(clientsResponse.statusCode).toBe(201);

    const productUpdateResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}`,
      payload: { name: "Hermes Go Next" },
    });
    expect(productUpdateResponse.statusCode).toBe(200);
    expect(productUpdateResponse.json()).toMatchObject({ name: "Hermes Go Next", keyPrefix: "HG" });

    const componentUpdateResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}/components/${android.id}`,
      payload: { name: "Android client", kind: "android", parentComponentId: clients.id },
    });
    expect(componentUpdateResponse.statusCode).toBe(200);
    expect(componentUpdateResponse.json()).toMatchObject({
      id: android.id,
      name: "Android client",
      kind: "android",
    });
    expect(componentUpdateResponse.json()).not.toHaveProperty("parentComponentId");

    const componentsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/components`,
    });
    expect(componentsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: clients.id }),
      expect.objectContaining({ id: android.id }),
    ]));
    expect(componentsResponse.json().every((component: Record<string, unknown>) => !("parentComponentId" in component))).toBe(true);

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        sourceComponentId: android.id,
        affectedComponentIds: [android.id],
        type: "idea",
        priority: "normal",
        title: "Quick capture from the share sheet",
        description: "Create an item without opening the management screen.",
        environment: { platform: "android", appVersion: "0.1.0" },
      },
    });
    expect(firstResponse.statusCode).toBe(201);
    expect(firstResponse.json()).toMatchObject({ key: "HG-1", status: "inbox", type: "idea" });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        status: "ready",
        type: "requirement",
        priority: "high",
        title: "Read an item through MCP",
        description: "",
        environment: { platform: "shared" },
      },
    });
    expect(secondResponse.json()).toMatchObject({ key: "HG-2", status: "ready", type: "requirement" });

    const listResponse = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}` });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ items: Array<{ key: string }> }>().items.map((item) => item.key)).toEqual([
      "HG-2",
      "HG-1",
    ]);
  });

  it("creates incomplete drafts and only accepts complete items as ready", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "MissionGo", keyPrefix: "MG" },
      })
    ).json<{ id: string }>();

    const draftResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        status: "inbox",
        type: "idea",
        priority: "normal",
        title: "An incomplete thought",
        description: "",
      },
    });
    expect(draftResponse.statusCode).toBe(201);
    expect(draftResponse.json()).toMatchObject({ key: "MG-1", status: "inbox" });
    expect(draftResponse.json()).not.toHaveProperty("environment");

    const incompleteReadyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        status: "ready",
        type: "idea",
        priority: "normal",
        title: "Still incomplete",
        description: "",
      },
    });
    expect(incompleteReadyResponse.statusCode).toBe(400);

    const readyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        status: "ready",
        type: "idea",
        priority: "normal",
        title: "Ready to process",
        description: "Enough context",
        environment: { platform: "web" },
      },
    });
    expect(readyResponse.statusCode).toBe(201);
    expect(readyResponse.json()).toMatchObject({ key: "MG-2", status: "ready" });
  });

  it("updates an item, enforces transitions, and records its timeline", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "MissionGo", keyPrefix: "MG" },
      })
    ).json<{ id: string }>();
    const component = (
      await app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/components`,
        payload: { name: "Web client", kind: "web" },
      })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "note",
        priority: "low",
        title: "Initial note",
        description: "Draft",
        environment: { platform: "other" },
      },
    });

    const invalidTransition = await app.inject({
      method: "POST",
      url: "/api/v1/items/MG-1/transitions",
      payload: { to: "done", reason: "verification_passed" },
    });
    expect(invalidTransition.statusCode).toBe(409);
    expect(invalidTransition.json()).toMatchObject({ code: "invalid_state_transition" });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/items/MG-1",
      payload: {
        title: "Refined requirement",
        type: "requirement",
        priority: "normal",
        sourceComponentId: component.id,
        affectedComponentIds: [component.id],
      },
    });
    expect(updateResponse.json()).toMatchObject({
      title: "Refined requirement",
      type: "requirement",
      sourceComponentId: component.id,
      affectedComponentIds: [component.id],
    });

    const triageResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items/MG-1/transitions",
      payload: { to: "ready", reason: "triaged", note: "Ready for AI analysis." },
    });
    expect(triageResponse.json()).toMatchObject({ key: "MG-1", status: "ready" });

    const timelineResponse = await app.inject({ method: "GET", url: "/api/v1/items/MG-1/timeline" });
    expect(timelineResponse.statusCode).toBe(200);
    const events = timelineResponse.json<{ events: Array<{ eventType: string; toStatus?: string }> }>().events;
    expect(events.map((event) => event.eventType)).toEqual(["item_created", "item_updated", "status_changed"]);
    expect(events.at(-1)).toMatchObject({ toStatus: "ready" });
  });

  it("persists work items across server restarts", async () => {
    const { app, databasePath } = await testApp();
    const product = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Hermes Go", keyPrefix: "HG" },
      })
    ).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "bug",
        priority: "urgent",
        title: "Persist me",
        description: "Database smoke test",
        environment: { platform: "other" },
      },
    });
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    const restarted = buildApp({ databasePath });
    apps.push(restarted);
    const response = await restarted.inject({ method: "GET", url: "/api/v1/items/HG-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ key: "HG-1", title: "Persist me", status: "inbox" });

    const nextResponse = await restarted.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "task",
        priority: "normal",
        title: "Continue the sequence",
        description: "",
        environment: { platform: "other" },
      },
    });
    expect(nextResponse.json()).toMatchObject({ key: "HG-2" });
  });

  it("rejects an affected component from another product", async () => {
    const { app } = await testApp();
    const first = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "First", keyPrefix: "AA" },
      })
    ).json<{ id: string }>();
    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Second", keyPrefix: "BB" },
      })
    ).json<{ id: string }>();
    const component = (
      await app.inject({
        method: "POST",
        url: `/api/v1/products/${second.id}/components`,
        payload: { name: "macOS", kind: "macos" },
      })
    ).json<{ id: string }>();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: first.id,
        affectedComponentIds: [component.id],
        type: "task",
        priority: "normal",
        title: "Wrong component",
        description: "",
        environment: { platform: "other" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });

  it("stores environment context and authenticated attachment content", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Hermes Go", keyPrefix: "HG" },
      })
    ).json<{ id: string }>();
    const itemResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "bug",
        priority: "high",
        title: "Crash on launch",
        description: "Captured from Android",
        environment: {
          platform: "android",
          appVersion: "1.4.0",
          buildNumber: "10400",
          osVersion: "Android 16",
          deviceModel: "Pixel 9",
          sourceRevision: "abc123",
          metadata: { channel: "internal" },
        },
      },
    });
    expect(itemResponse.statusCode).toBe(201);
    expect(itemResponse.json()).toMatchObject({
      environment: { platform: "android", appVersion: "1.4.0", deviceModel: "Pixel 9" },
      attachments: [],
    });

    const updateEnvironmentResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/items/HG-1",
      payload: { environment: { platform: "macos", appVersion: "1.4.1", deviceModel: "Mac mini" } },
    });
    expect(updateEnvironmentResponse.statusCode).toBe(200);
    expect(updateEnvironmentResponse.json()).toMatchObject({
      environment: { platform: "macos", appVersion: "1.4.1", deviceModel: "Mac mini" },
    });

    const log = Buffer.from("Fatal exception\nMissionGo test log\n");
    const uploadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-filename": encodeURIComponent("launch.log"),
      },
      payload: log,
    });
    expect(uploadResponse.statusCode).toBe(201);
    const attachment = uploadResponse.json<{ id: string; filename: string; kind: string; sizeBytes: number }>();
    expect(attachment).toMatchObject({ filename: "launch.log", kind: "log", displayNumber: 1, sizeBytes: log.length });

    const detailResponse = await app.inject({ method: "GET", url: "/api/v1/items/HG-1" });
    expect(detailResponse.json()).toMatchObject({
      attachments: [{ id: attachment.id, filename: "launch.log", kind: "log", displayNumber: 1 }],
    });

    const contentResponse = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}/content`,
    });
    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.headers["content-type"]).toContain("text/plain");
    expect(contentResponse.headers["accept-ranges"]).toBe("bytes");
    expect(contentResponse.body).toBe(log.toString());

    const rangeResponse = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}/content`,
      headers: { range: "bytes=6-14" },
    });
    expect(rangeResponse.statusCode).toBe(206);
    expect(rangeResponse.headers["content-range"]).toBe(`bytes 6-14/${log.length}`);
    expect(rangeResponse.headers["content-length"]).toBe("9");
    expect(rangeResponse.body).toBe("exception");

    const invalidRangeResponse = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}/content`,
      headers: { range: "bytes=999-1000" },
    });
    expect(invalidRangeResponse.statusCode).toBe(416);
    expect(invalidRangeResponse.headers["content-range"]).toBe(`bytes */${log.length}`);

    const unsafeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-filename": encodeURIComponent("../unsafe.log"),
      },
      payload: "unsafe",
    });
    expect(unsafeResponse.statusCode).toBe(400);

    const imageUploadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/jpeg",
        "x-missiongo-filename": "evidence.jpg",
      },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(imageUploadResponse.statusCode).toBe(201);
    const imageAttachment = imageUploadResponse.json<{ id: string }>();
    const deleteImageResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/items/HG-1/attachments/${imageAttachment.id}`,
    });
    expect(deleteImageResponse.statusCode).toBe(204);
    const deletedImageContent = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${imageAttachment.id}/content`,
    });
    expect(deletedImageContent.statusCode).toBe(404);

    const replacementImageResponse = await app.inject({
      method: "POST",
      url: "/api/v1/items/HG-1/attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-missiongo-content-type": "image/jpeg",
        "x-missiongo-filename": "replacement.jpg",
      },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(replacementImageResponse.statusCode).toBe(201);
    const replacementImage = replacementImageResponse.json<{ id: string; displayNumber: number }>();
    expect(replacementImage.displayNumber).toBe(2);
    const deleteReplacementImage = await app.inject({
      method: "DELETE",
      url: `/api/v1/items/HG-1/attachments/${replacementImage.id}`,
    });
    expect(deleteReplacementImage.statusCode).toBe(204);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);
    const deletedContent = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}/content`,
    });
    expect(deletedContent.statusCode).toBe(404);
    const detailAfterDelete = await app.inject({ method: "GET", url: "/api/v1/items/HG-1" });
    expect(detailAfterDelete.json()).toMatchObject({ attachments: [], diagnosticSummary: { logCount: 0 } });
    const timelineAfterDelete = await app.inject({ method: "GET", url: "/api/v1/items/HG-1/timeline" });
    expect(timelineAfterDelete.json()).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ eventType: "attachment_removed" })]),
    });
  });

  it("stores, returns, edits, and searches structured report details", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Reports", keyPrefix: "RP" } })
    ).json<{ id: string }>();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "bug",
        priority: "high",
        title: "Search loses its filters",
        description: "Filters disappear after returning to the list.",
        report: {
          overview: "Filters disappear after returning to the list.",
          reproductionSteps: "Open search, select Recent, open a result, then go back.",
          expectedOutcome: "The Recent filter remains selected.",
          impact: "Users repeat the same filtering work.",
          occurrenceFrequency: "always",
        },
        environment: { platform: "web" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      report: {
        reproductionSteps: expect.stringContaining("select Recent"),
        expectedOutcome: "The Recent filter remains selected.",
        occurrenceFrequency: "always",
      },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/items/RP-1",
      payload: {
        description: "Filters and sorting disappear after returning.",
        report: {
          overview: "Filters and sorting disappear after returning.",
          reproductionSteps: "Open search, change sorting, open a result, then go back.",
          expectedOutcome: "Filters and sorting remain selected.",
          impact: "Repeated navigation becomes slow.",
          occurrenceFrequency: "frequent",
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      description: "Filters and sorting disappear after returning.",
      report: { impact: "Repeated navigation becomes slow.", occurrenceFrequency: "frequent" },
    });

    const searched = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&search=sorting` });
    expect(searched.json()).toMatchObject({ items: [{ key: "RP-1" }] });
  });

  it("retires a product and a module without touching the items that reference them", async () => {
    const { app } = await testApp();
    const keep = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Keep", keyPrefix: "KP" } })
    ).json<{ id: string }>();
    const retire = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Retire", keyPrefix: "RT" } })
    ).json<{ id: string }>();
    const module = (
      await app.inject({
        method: "POST",
        url: `/api/v1/products/${retire.id}/components`,
        payload: { name: "Sync", kind: "android" },
      })
    ).json<{ id: string }>();
    const item = (
      await app.inject({
        method: "POST",
        url: "/api/v1/items",
        payload: {
          productId: retire.id,
          type: "bug",
          priority: "normal",
          title: "Sync stalls",
          description: "Uploads never finish.",
          sourceComponentId: module.id,
          environment: { platform: "android" },
        },
      })
    ).json<{ key: string }>();

    const archivedModule = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${retire.id}/components/${module.id}`,
      payload: { archived: true },
    });
    expect(archivedModule.statusCode).toBe(200);
    expect(archivedModule.json()).toMatchObject({ name: "Sync", kind: "android" });
    expect(archivedModule.json<{ archivedAt?: string }>().archivedAt).toBeTypeOf("string");

    // Gone from the pickers, still there when the settings screen asks for it.
    expect((await app.inject({ method: "GET", url: `/api/v1/products/${retire.id}/components` })).json()).toEqual([]);
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/products/${retire.id}/components?includeArchived=true` }))
        .json<unknown[]>(),
    ).toHaveLength(1);
    // The item keeps pointing at it rather than losing where it came from.
    expect((await app.inject({ method: "GET", url: `/api/v1/items/${item.key}` })).json())
      .toMatchObject({ sourceComponentId: module.id });

    const archivedProduct = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${retire.id}`,
      payload: { archived: true },
    });
    expect(archivedProduct.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/products" })).json()).toEqual([
      expect.objectContaining({ id: keep.id }),
    ]);
    expect((await app.inject({ method: "GET", url: "/api/v1/products?includeArchived=true" })).json<unknown[]>())
      .toHaveLength(2);

    // Restoring puts it back, and the archive flag is the only thing that moved.
    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${retire.id}`,
      payload: { archived: false },
    });
    expect(restored.json()).toMatchObject({ name: "Retire", keyPrefix: "RT" });
    expect(restored.json<{ archivedAt?: string }>().archivedAt).toBeUndefined();
  });

  it("keeps cancelled items out of the unfiltered list but still counts them", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "MissionGo", keyPrefix: "MG" } })
    ).json<{ id: string }>();
    for (const title of ["Keep me", "Withdraw me"]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/items",
        payload: { productId: product.id, type: "task", priority: "normal", title, description: "x", environment: { platform: "web" } },
      });
    }
    await app.inject({ method: "POST", url: "/api/v1/items/MG-2/transitions", payload: { to: "cancelled", reason: "cancelled" } });

    // The default list is live work only.
    const unfiltered = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}` });
    expect(unfiltered.json<{ items: Array<{ key: string }> }>().items.map((item) => item.key)).toEqual(["MG-1"]);
    // The sidebar bucket has to keep showing how many there are.
    expect(unfiltered.json()).toMatchObject({ summary: { byStatus: { inbox: 1, cancelled: 1 }, productTotal: 2 } });

    // Asking for them by status still returns them, which is the way back.
    const cancelled = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&status=cancelled` });
    expect(cancelled.json<{ items: Array<{ key: string }> }>().items.map((item) => item.key)).toEqual(["MG-2"]);
  });

  it("refuses to archive the only product left to switch to", async () => {
    const { app } = await testApp();
    const only = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "Only", keyPrefix: "ON" } })
    ).json<{ id: string }>();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${only.id}`,
      payload: { archived: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });

  it("paginates items and narrows the status counts to the active filters", async () => {
    const { app } = await testApp();
    const product = (
      await app.inject({ method: "POST", url: "/api/v1/products", payload: { name: "MissionGo", keyPrefix: "MG" } })
    ).json<{ id: string }>();
    for (const title of ["Offline shell", "Mobile layout", "Attachment streaming"]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/items",
        payload: { productId: product.id, type: "task", priority: "normal", title, description: "H5 iteration", environment: { platform: "web" } },
      });
    }
    await app.inject({
      method: "POST",
      url: "/api/v1/items/MG-2/transitions",
      payload: { to: "ready", reason: "triaged" },
    });

    const firstPage = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&limit=2` });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      items: [{ key: "MG-3" }, { key: "MG-2" }],
      nextBeforeSequence: 2,
      summary: { total: 3, productTotal: 3, byStatus: { inbox: 2, ready: 1 } },
    });

    // Paging is not a filter, so the counts describe the whole product.
    const nextPage = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&limit=2&beforeSequence=2` });
    expect(nextPage.json()).toMatchObject({ items: [{ key: "MG-1" }], summary: { total: 3, productTotal: 3 } });
    expect(nextPage.json()).not.toHaveProperty("nextBeforeSequence");

    // Searching is: the sidebar counts have to agree with the list beside them.
    const searchResponse = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&search=mobile` });
    expect(searchResponse.json()).toMatchObject({
      items: [{ key: "MG-2", title: "Mobile layout" }],
      summary: { total: 1, productTotal: 3, byStatus: { inbox: 0, ready: 1 } },
    });

    // A status filter must not narrow the counts, or every sidebar entry but the
    // selected one would read zero.
    const statusFiltered = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&status=ready` });
    expect(statusFiltered.json()).toMatchObject({
      items: [{ key: "MG-2" }],
      summary: { total: 3, productTotal: 3, byStatus: { inbox: 2, ready: 1 } },
    });

    const typeFiltered = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}&type=bug` });
    expect(typeFiltered.json()).toMatchObject({ items: [], summary: { total: 0, productTotal: 3 } });
  });

  it("creates a scoped Android SDK token and submits an idempotent feedback draft", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-sdk-"));
    temporaryDirectories.push(directory);
    const app = buildApp({
      databasePath: join(directory, "missiongo.sqlite"),
      attachmentsPath: join(directory, "attachments"),
      adminToken: "admin-test-token",
    });
    apps.push(app);
    const adminHeaders = { authorization: "Bearer admin-test-token" };

    const product = (
      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: adminHeaders,
        payload: { name: "Search App", keyPrefix: "SA" },
      })
    ).json<{ id: string }>();
    const component = (
      await app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/components`,
        headers: adminHeaders,
        payload: { name: "Android search", kind: "android" },
      })
    ).json<{ id: string }>();
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sdk-tokens",
      headers: adminHeaders,
      payload: { name: "Search debug", productId: product.id, sourceComponentId: component.id },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const issued = tokenResponse.json<{ id: string; token: string }>();
    expect(issued.token).toMatch(/^mg_sdk_/);

    const listed = await app.inject({ method: "GET", url: "/api/v1/sdk-tokens", headers: adminHeaders });
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: issued.id, productId: product.id, sourceComponentId: component.id }),
    ]);
    expect(listed.body).not.toContain(issued.token);

    const payload = {
      clientDraftId: "search-app-draft-0001",
      type: "bug",
      priority: "high",
      title: "Search results are empty",
      description: "The cached result list disappears after retry.",
      environment: {
        platform: "android",
        appVersion: "1.2.0",
        buildNumber: "42",
        osVersion: "Android 16",
        deviceModel: "Example device",
      },
      context: { screen: "search_result", queryLength: "12" },
      logs: [{ timestamp: "2026-09-04T10:00:00.000Z", level: "error", message: "Search request timed out" }],
    };
    const unauthorized = await app.inject({ method: "POST", url: "/api/v1/sdk/drafts", payload });
    expect(unauthorized.statusCode).toBe(401);

    const sdkHeaders = { authorization: `Bearer ${issued.token}` };
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sdk/drafts",
      headers: sdkHeaders,
      payload,
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ id: string }>();

    const repeatedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sdk/drafts",
      headers: sdkHeaders,
      payload: { ...payload, description: "Updated before submission." },
    });
    expect(repeatedResponse.json()).toMatchObject({ id: created.id, description: "Updated before submission." });

    const otherDraftResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sdk/drafts",
      headers: sdkHeaders,
      payload: { ...payload, clientDraftId: "search-app-draft-0002" },
    });
    const otherDraft = otherDraftResponse.json<{ id: string }>();

    const preparedEditorResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sdk/editor-session",
      headers: sdkHeaders,
      payload: { ...payload, clientDraftId: "search-app-draft-0003" },
    });
    expect(preparedEditorResponse.statusCode).toBe(201);
    const preparedEditor = preparedEditorResponse.json<{ id: string; sessionToken: string }>();
    expect(preparedEditor.id).toBeTruthy();
    expect(preparedEditor.sessionToken).toMatch(/^mg_ws_/);
    const preparedEditorDraft = await app.inject({
      method: "GET",
      url: `/api/v1/sdk/drafts/${preparedEditor.id}`,
      headers: { cookie: `missiongo_feedback_session=${preparedEditor.sessionToken}` },
    });
    expect(preparedEditorDraft.statusCode).toBe(200);
    expect(preparedEditorDraft.json()).toMatchObject({ id: preparedEditor.id, title: payload.title });
    const preparedReady = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${preparedEditor.id}/finalize`,
      headers: { cookie: `missiongo_feedback_session=${preparedEditor.sessionToken}` },
      payload: { status: "ready" },
    });
    expect(preparedReady.statusCode).toBe(200);
    const preparedReadyKey = preparedReady.json<{ itemKey: string }>().itemKey;
    const preparedReadyItem = await app.inject({
      method: "GET",
      url: `/api/v1/items/${preparedReadyKey}`,
      headers: adminHeaders,
    });
    expect(preparedReadyItem.json()).toMatchObject({ key: preparedReadyKey, status: "ready" });

    const webSessionResponse = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/web-session`,
      headers: sdkHeaders,
    });
    expect(webSessionResponse.statusCode).toBe(200);
    const webSession = webSessionResponse.json<{ token: string }>();
    expect(webSession.token).toMatch(/^mg_ws_/);
    const sessionHeaders = { cookie: `missiongo_feedback_session=${webSession.token}` };
    const deniedOtherDraft = await app.inject({
      method: "GET",
      url: `/api/v1/sdk/drafts/${otherDraft.id}`,
      headers: sessionHeaders,
    });
    expect(deniedOtherDraft.statusCode).toBe(401);
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/sdk/drafts/${created.id}`,
      headers: sessionHeaders,
      payload: { title: "Search results disappear after retry" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: created.id, title: "Search results disappear after retry" });

    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/finalize`,
      headers: sessionHeaders,
    });
    expect(finalized.statusCode).toBe(200);
    const finalizedKey = finalized.json<{ itemKey: string }>().itemKey;
    expect(finalized.json()).toMatchObject({ status: "submitted", itemKey: finalizedKey });
    const defaultDraftItem = await app.inject({
      method: "GET",
      url: `/api/v1/items/${finalizedKey}`,
      headers: adminHeaders,
    });
    expect(defaultDraftItem.json()).toMatchObject({ key: finalizedKey, status: "inbox" });
    const repeatedFinalize = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/finalize`,
      headers: sdkHeaders,
    });
    expect(repeatedFinalize.json()).toMatchObject({ status: "submitted", itemKey: finalizedKey });

    const sdkAttachment = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/attachments`,
      headers: {
        ...sessionHeaders,
        "content-type": "application/octet-stream",
        "x-missiongo-filename": "search-retry.log",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-client-attachment-id": "search-retry-log-0001",
      },
      payload: Buffer.from("Search request timed out after retry."),
    });
    expect(sdkAttachment.statusCode).toBe(201);
    const uploadedAttachment = sdkAttachment.json<{ id: string; filename: string; kind: string }>();
    expect(uploadedAttachment).toMatchObject({ filename: "search-retry.log", kind: "log" });
    const repeatedAttachment = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/attachments`,
      headers: {
        ...sessionHeaders,
        "content-type": "application/octet-stream",
        "x-missiongo-filename": "search-retry.log",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-client-attachment-id": "search-retry-log-0001",
      },
      payload: Buffer.from("Search request timed out after retry."),
    });
    expect(repeatedAttachment.statusCode).toBe(201);
    expect(repeatedAttachment.json()).toMatchObject({ id: uploadedAttachment.id });
    const reusedAttachmentId = await app.inject({
      method: "POST",
      url: `/api/v1/sdk/drafts/${created.id}/attachments`,
      headers: {
        ...sessionHeaders,
        "content-type": "application/octet-stream",
        "x-missiongo-filename": "search-retry.log",
        "x-missiongo-content-type": "text/plain",
        "x-missiongo-client-attachment-id": "search-retry-log-0001",
      },
      payload: Buffer.from("X".repeat(37)),
    });
    expect(reusedAttachmentId.statusCode).toBe(400);

    const item = await app.inject({ method: "GET", url: `/api/v1/items/${finalizedKey}`, headers: adminHeaders });
    expect(item.json()).toMatchObject({
      productId: product.id,
      sourceComponentId: component.id,
      affectedComponentIds: [component.id],
      title: "Search results disappear after retry",
      report: { overview: "Updated before submission." },
      diagnosticSummary: { logCount: 2, contextEntryCount: 2 },
      environment: { platform: "android", appVersion: "1.2.0" },
      attachments: [expect.objectContaining({ filename: "search-retry.log", kind: "log" })],
    });
    const timeline = await app.inject({ method: "GET", url: `/api/v1/items/${finalizedKey}/timeline`, headers: adminHeaders });
    expect(timeline.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "item_created",
          payload: expect.objectContaining({ source: "android_sdk", context: payload.context, logs: payload.logs }),
        }),
        expect.objectContaining({ eventType: "attachment_added" }),
      ]),
    });

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/sdk-tokens/${issued.id}`,
      headers: adminHeaders,
    });
    expect(revoked.json()).toMatchObject({ id: issued.id, revokedAt: expect.any(String) });
    const rejectedAfterRevoke = await app.inject({
      method: "GET",
      url: `/api/v1/sdk/drafts/${created.id}`,
      headers: sdkHeaders,
    });
    expect(rejectedAfterRevoke.statusCode).toBe(401);
    const rejectedSessionAfterRevoke = await app.inject({
      method: "GET",
      url: `/api/v1/sdk/drafts/${created.id}`,
      headers: sessionHeaders,
    });
    expect(rejectedSessionAfterRevoke.statusCode).toBe(401);
  });

  it("rate limits SDK traffic per token and operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missiongo-sdk-limit-"));
    temporaryDirectories.push(directory);
    const app = buildApp({
      databasePath: join(directory, "missiongo.sqlite"),
      attachmentsPath: join(directory, "attachments"),
      adminToken: "admin-test-token",
      sdkRateLimits: { draft_read: { limit: 2, windowMilliseconds: 60_000 } },
    });
    apps.push(app);
    const adminHeaders = { authorization: "Bearer admin-test-token" };
    const product = (await app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: adminHeaders,
      payload: { name: "Rate limited app", keyPrefix: "RL" },
    })).json<{ id: string }>();
    const issued = (await app.inject({
      method: "POST",
      url: "/api/v1/sdk-tokens",
      headers: adminHeaders,
      payload: { name: "Rate limit test", productId: product.id },
    })).json<{ token: string }>();
    const sdkHeaders = { authorization: `Bearer ${issued.token}` };
    const draft = (await app.inject({
      method: "POST",
      url: "/api/v1/sdk/drafts",
      headers: sdkHeaders,
      payload: {
        clientDraftId: "rate-limit-draft-0001",
        title: "Rate limit",
        environment: { platform: "android" },
      },
    })).json<{ id: string }>();

    const first = await app.inject({ method: "GET", url: `/api/v1/sdk/drafts/${draft.id}`, headers: sdkHeaders });
    const second = await app.inject({ method: "GET", url: `/api/v1/sdk/drafts/${draft.id}`, headers: sdkHeaders });
    const limited = await app.inject({ method: "GET", url: `/api/v1/sdk/drafts/${draft.id}`, headers: sdkHeaders });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "rate_limit_exceeded" });
  });
});
