import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { afterEach, expect, it } from "vitest";

import { buildApp } from "./app.js";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ADMIN_TOKEN = "backup-drill-token";
const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function open(databasePath: string, attachmentsPath: string): FastifyInstance {
  const app = buildApp({ databasePath, attachmentsPath, adminToken: ADMIN_TOKEN });
  apps.push(app);
  return app;
}

// The product plan requires a restore drill before release, so run one on every
// test run instead of trusting that the scripts still work.
it("backs up and restores the database together with its attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-backup-"));
  directories.push(directory);
  const databasePath = join(directory, "data", "missiongo.sqlite");
  const attachmentsPath = join(directory, "data", "attachments");
  const backupRoot = join(directory, "backups");
  const paths = ["--database", databasePath, "--attachments", attachmentsPath];

  const seeded = open(databasePath, attachmentsPath);
  const product = (
    await seeded.inject({ method: "POST", url: "/api/v1/products", headers, payload: { name: "Hermes Go", keyPrefix: "HG" } })
  ).json<{ id: string }>();
  for (const title of ["Crash on launch", "Add dark mode"]) {
    await seeded.inject({
      method: "POST",
      url: "/api/v1/items",
      headers,
      payload: {
        productId: product.id,
        type: "bug",
        priority: "high",
        title,
        description: "seeded by the restore drill",
        environment: { platform: "android" },
      },
    });
  }
  const uploaded = await seeded.inject({
    method: "POST",
    url: "/api/v1/items/HG-1/attachments",
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "x-missiongo-content-type": "text/plain",
      "x-missiongo-filename": "launch.log",
    },
    payload: "Fatal exception at launch\n",
  });
  const attachmentId = uploaded.json<{ id: string }>().id;
  await seeded.close();
  apps.splice(apps.indexOf(seeded), 1);

  await run("node", ["scripts/backup.mjs", "--out", backupRoot, ...paths], { cwd: repositoryRoot });
  const backupDirectory = join(backupRoot, (await readdir(backupRoot))[0]!);

  // A backup must never overwrite live data by accident.
  await expect(run("node", ["scripts/restore.mjs", "--from", backupDirectory, ...paths], { cwd: repositoryRoot }))
    .rejects.toThrow(/Refusing to overwrite existing data/);

  await rm(join(directory, "data"), { recursive: true, force: true });
  expect(existsSync(databasePath)).toBe(false);

  const { stdout } = await run("node", ["scripts/restore.mjs", "--from", backupDirectory, ...paths], { cwd: repositoryRoot });
  expect(stdout).toContain("Every attachment row has its file.");

  const restored = open(databasePath, attachmentsPath);
  const items = (
    await restored.inject({ method: "GET", url: `/api/v1/items?productId=${product.id}`, headers })
  ).json<{ items: readonly { title: string }[] }>();
  expect(items.items.map((item) => item.title).sort()).toEqual(["Add dark mode", "Crash on launch"]);

  // The attachment bytes have to survive too, not just the metadata rows.
  const content = await restored.inject({
    method: "GET",
    url: `/api/v1/items/HG-1/attachments/${attachmentId}/content`,
    headers,
  });
  expect(content.statusCode).toBe(200);
  expect(content.body).toBe("Fatal exception at launch\n");
}, 30_000);
