import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "missiongo-operations-"));
  directories.push(directory);
  const attachmentsPath = join(directory, "attachments");
  const app = buildApp({ databasePath: join(directory, "test.sqlite"), attachmentsPath });
  apps.push(app);
  const product = app.missionGoStore.createProduct({ name: "Operations", keyPrefix: "OP" });
  const creationUploadId = randomUUID();
  const item = (await app.inject({ method: "POST", url: "/api/v1/items", payload: {
    productId: product.id, title: "Files", description: "", type: "note", priority: "normal", creationUploadId,
  } })).json<{ key: string }>();
  const upload = (filename: string, creationId?: string, requestId?: string, bytes = Buffer.from("file")) => app.inject({
    method: "POST", url: `/api/v1/items/${item.key}/attachments`, payload: bytes,
    headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": "application/octet-stream",
      "x-missiongo-filename": filename,
      ...(creationId === undefined ? {} : { "x-missiongo-creation-upload-id": creationId }),
      ...(requestId ? { "x-missiongo-upload-id": requestId } : {}),
    },
  });
  return { app, product, item, upload, creationUploadId, attachmentsPath };
}

describe("creation attachment ownership", () => {
  it("records all file types against the creation event and preserves standalone uploads", async () => {
    const { app, item, upload, creationUploadId } = await seed();
    for (const filename of ["image.png", "movie.mp4", "log.log", "notes.txt", "archive.zip"]) {
      const response = await upload(filename, creationUploadId, undefined,
        filename.endsWith(".zip") ? Buffer.from([0x50, 0x4b, 0x05, 0x06]) : Buffer.from("file"));
      expect(response.statusCode, response.body).toBe(201);
    }
    expect((await upload("later.txt")).statusCode).toBe(201);
    const events = app.missionGoStore.getTimeline(item.key);
    const creation = events.find(event => event.eventType === "item_created")!;
    const uploads = events.filter(event => event.eventType === "attachment_added");
    expect(uploads).toHaveLength(6);
    expect(uploads.slice(0, 5).map(event => event.payload.creationEventId)).toEqual(Array(5).fill(creation.id));
    expect(uploads[5]?.payload).not.toHaveProperty("creationEventId");
    expect(creation.payload).toMatchObject({ creationUploadId });
  });

  it("keeps successful uploads after a failed file and makes retries idempotent", async () => {
    const { app, item, upload, creationUploadId } = await seed();
    expect((await upload("bad.exe", creationUploadId)).statusCode).toBe(400);
    const first = await upload("notes.txt", creationUploadId, "retry-file");
    expect(first.statusCode).toBe(201);
    const retried = await upload("notes.txt", creationUploadId, "retry-file");
    expect(retried.json().id).toBe(first.json().id);
    expect((await upload("notes.txt", undefined, "retry-file")).statusCode).toBe(400);
    expect(app.missionGoStore.getWorkItem(item.key).attachments).toHaveLength(1);
    expect(app.missionGoStore.getTimeline(item.key).filter(event => event.eventType === "attachment_added")).toHaveLength(1);
  });

  it("rejects forged creation links without leaving metadata or file bytes", async () => {
    const { app, product, item, upload, attachmentsPath } = await seed();
    const otherId = randomUUID();
    app.missionGoStore.createWorkItem({ productId: product.id, type: "note", priority: "normal", title: "Other", description: "", creationUploadId: otherId });
    expect((await upload("wrong.txt", otherId)).statusCode).toBe(400);
    expect(app.missionGoStore.getWorkItem(item.key).attachments).toHaveLength(0);
    expect(await readdir(attachmentsPath)).toEqual([]);
    const invalid = await app.inject({ method: "POST", url: "/api/v1/items", payload: {
      productId: product.id, title: "Invalid", description: "", type: "note", priority: "normal", creationUploadId: "not-a-uuid",
    } });
    expect(invalid.statusCode).toBe(400);
  });

  it("requires the same creator identity even when the marker is known", async () => {
    const { app, product, creationUploadId } = await seed();
    const item = app.missionGoStore.createWorkItem({ productId: product.id, type: "note", priority: "normal",
      title: "Owned", description: "", creationUploadId, attribution: { accountId: "creator" } });
    expect(() => app.missionGoStore.createAttachmentMetadata({ itemKey: item.key, kind: "document", filename: "file.txt",
      storageFilename: "unused", contentType: "text/plain", sizeBytes: 1, creationUploadId, attribution: { accountId: "another" },
    })).toThrow("does not belong");
    expect(app.missionGoStore.getWorkItem(item.key).attachments).toHaveLength(0);
  });
});
