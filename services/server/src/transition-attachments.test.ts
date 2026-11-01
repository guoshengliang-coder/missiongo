import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-transition-files-"));
  directories.push(directory);
  const app = buildApp({ databasePath: join(directory, "test.sqlite"), attachmentsPath: join(directory, "files") });
  apps.push(app);
  const store = app.missionGoStore;
  const product = store.createProduct({ name: "Transitions", keyPrefix: "TR" });
  const create = () => store.createWorkItem({ productId: product.id, title: "Reason files", description: "", type: "requirement", priority: "normal", status: "ready", environment: { platform: "web" } });
  const item = create();
  store.transitionWorkItem({ itemKey: item.key, to: "pending_verification", actor: "human", reason: "manual_override" });
  const upload = async (key = item.key) => {
    const response = await app.inject({ method: "POST", url: `/api/v1/items/${key}/attachments`, payload: Buffer.from("Evidence"),
      headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": "text/plain", "x-missiongo-filename": "reason.log" } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };
  const transition = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/items/${item.key}/transitions`,
    payload: { to: "ready", reason: "verification_failed", note: "Please fix this", ...payload } });
  return { app, store, item, create, upload, transition };
}

describe("attachments in human transition reasons", () => {
  it("associates mixed evidence with the status write, without adding a comment or treating it as report diagnostics", async () => {
    const { store, item, upload, transition } = await seed();
    const id = await upload();
    const response = await transition({ attachmentIds: [id], idempotencyKey: "write-once", expectedStatus: "pending_verification" });
    expect(response.statusCode, response.body).toBe(200);
    const event = store.getTimeline(item.key).at(-1)!;
    expect(event).toMatchObject({ eventType: "status_changed", fromStatus: "pending_verification", toStatus: "ready", payload: { note: "Please fix this", attachmentIds: [id] } });
    expect(response.json().attachments[0]).toMatchObject({ id, transitionEventId: event.id });
    expect(response.json().diagnosticSummary.logFileCount).toBe(0);
    expect(store.listComments(item.key)).toHaveLength(0);
    expect(store.getTimeline(item.key).filter(event => event.eventType === "attachment_added")).toHaveLength(1);
  });

  it("retries a lost response once, rejects a changed payload, and returns the current snapshot on a late retry", async () => {
    const { store, item, upload, transition } = await seed();
    const id = await upload();
    const input = { attachmentIds: [id], idempotencyKey: "lost-response", expectedStatus: "pending_verification" };
    expect((await transition(input)).statusCode).toBe(200);
    expect((await transition(input)).statusCode).toBe(200);
    expect(store.getTimeline(item.key).filter(event => event.payload.attachmentIds)).toHaveLength(1);
    expect((await transition({ ...input, note: "Changed reason" })).statusCode).toBe(409);
    store.transitionWorkItem({ itemKey: item.key, to: "on_hold", actor: "human", reason: "request_human_input" });
    expect((await transition(input)).json().status).toBe("on_hold");
  });

  it("rejects duplicates, foreign files, missing reasons and stale status without changing state or binding files", async () => {
    const { store, item, create, upload, transition } = await seed();
    const own = await upload();
    const foreign = await upload(create().key);
    for (const input of [{ attachmentIds: [own, own] }, { attachmentIds: [own, foreign] }, { attachmentIds: [own], note: " " },
      { attachmentIds: [own], expectedStatus: "in_progress" }, { attachmentIds: Array(11).fill(own) }]) {
      expect((await transition(input)).statusCode).toBeGreaterThanOrEqual(400);
      expect(store.getWorkItem(item.key).status).toBe("pending_verification");
      expect(store.getWorkItem(item.key).attachments[0]?.transitionEventId).toBeUndefined();
    }
  });

  it("does not steal files from comments, another status operation or another author", async () => {
    const { store, item, upload, transition } = await seed();
    const commented = await upload();
    store.createComment({ itemKey: item.key, actorKind: "human", bodyKind: "free", body: { text: "Existing", attachmentIds: [commented] } });
    expect((await transition({ attachmentIds: [commented] })).statusCode).toBe(400);
    const owned = store.createAttachmentMetadata({ itemKey: item.key, kind: "document", filename: "owned.txt", storageFilename: "unused", contentType: "text/plain", sizeBytes: 1, attribution: { accountId: "someone-else" } });
    expect((await transition({ attachmentIds: [owned.id] })).statusCode).toBe(400);
    const free = await upload();
    expect((await transition({ attachmentIds: [free] })).statusCode).toBe(200);
    store.transitionWorkItem({ itemKey: item.key, to: "pending_verification", actor: "human", reason: "manual_override" });
    expect((await transition({ attachmentIds: [free] })).statusCode).toBe(400);
    expect(() => store.createComment({ itemKey: item.key, actorKind: "human", bodyKind: "free", body: { text: "Steal", attachmentIds: [free] } })).toThrow("transition");
  });

  it("supports cancellation while preserving human-only state rules", async () => {
    const { store, item, upload, transition } = await seed();
    const id = await upload();
    expect(() => store.transitionWorkItem({ itemKey: item.key, actor: "agent", to: "cancelled", reason: "cancelled", note: "Reason", attachmentIds: [id] })).toThrow();
    expect((await transition({ to: "cancelled", reason: "cancelled", attachmentIds: [id] })).statusCode).toBe(200);
    expect(store.getWorkItem(item.key).status).toBe("cancelled");
  });
});
