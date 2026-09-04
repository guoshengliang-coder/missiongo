import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

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

    const androidResponse = await app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/components`,
      payload: { name: "Android", kind: "android" },
    });
    const android = androidResponse.json<{ id: string }>();
    expect(androidResponse.statusCode).toBe(201);

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
        type: "requirement",
        priority: "high",
        title: "Read an item through MCP",
        description: "",
      },
    });
    expect(secondResponse.json()).toMatchObject({ key: "HG-2", status: "inbox", type: "requirement" });

    const listResponse = await app.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}` });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ items: Array<{ key: string }> }>().items.map((item) => item.key)).toEqual([
      "HG-2",
      "HG-1",
    ]);
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
    await app.inject({
      method: "POST",
      url: "/api/v1/items",
      payload: {
        productId: product.id,
        type: "note",
        priority: "low",
        title: "Initial note",
        description: "Draft",
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
      payload: { title: "Refined requirement", type: "requirement", priority: "normal" },
    });
    expect(updateResponse.json()).toMatchObject({ title: "Refined requirement", type: "requirement" });

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
    expect(attachment).toMatchObject({ filename: "launch.log", kind: "log", sizeBytes: log.length });

    const detailResponse = await app.inject({ method: "GET", url: "/api/v1/items/HG-1" });
    expect(detailResponse.json()).toMatchObject({
      attachments: [{ id: attachment.id, filename: "launch.log", kind: "log" }],
    });

    const contentResponse = await app.inject({
      method: "GET",
      url: `/api/v1/items/HG-1/attachments/${attachment.id}/content`,
    });
    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.headers["content-type"]).toContain("text/plain");
    expect(contentResponse.body).toBe(log.toString());

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
  });
});
