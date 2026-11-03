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
  const directory = await mkdtemp(join(tmpdir(), "missiongo-attachment-limit-"));
  directories.push(directory);
  const app = buildApp({ databasePath: join(directory, "test.sqlite"), attachmentsPath: join(directory, "files") });
  apps.push(app);
  const store = app.missionGoStore;
  const product = store.createProduct({ name: "Attachment limit", keyPrefix: "AL" });
  const item = store.createWorkItem({ productId: product.id, title: "Many files", description: "", type: "task", priority: "normal", status: "ready", environment: { platform: "web" } });
  const upload = (index: number) => app.inject({ method: "POST", url: `/api/v1/items/${item.key}/attachments`, payload: Buffer.from(`evidence-${index}`),
    headers: { "content-type": "application/octet-stream", "x-missiongo-content-type": "text/plain", "x-missiongo-filename": `evidence-${index}.log` } });
  return { app, upload };
}

describe("per-item attachment budget", () => {
  it("accepts 100 attachments and rejects the 101st with attachment_limit_reached", async () => {
    const { upload } = await seed();
    for (let index = 0; index < 100; index += 1) {
      const response = await upload(index);
      expect(response.statusCode, `upload ${index + 1}`).toBe(201);
    }
    const rejected = await upload(100);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "attachment_limit_reached" });
  });
});
