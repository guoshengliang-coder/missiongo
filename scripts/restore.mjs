#!/usr/bin/env node

// Restore a MissionGo backup created by scripts/backup.mjs.
//
// Stop the server before restoring. The database and the attachment directory
// have to move together: restoring one without the other leaves item detail
// views pointing at files that are not there.

import { loadEnvFile } from "node:process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repositoryRoot = new URL("../", import.meta.url);

try {
  loadEnvFile(fileURLToPath(new URL(".env", repositoryRoot)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const from = option("from");
const force = process.argv.includes("--force");
const databasePath = resolve(option("database") ?? process.env.DATABASE_PATH ?? "./data/missiongo.sqlite");
const attachmentsPath = resolve(option("attachments") ?? process.env.ATTACHMENTS_PATH ?? "./data/attachments");

if (!from) {
  console.error("Usage: node scripts/restore.mjs --from <backup directory> [--force]");
  process.exit(1);
}

const backup = resolve(from);
const manifestPath = join(backup, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error(`Not a MissionGo backup (no manifest.json): ${backup}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.tool !== "missiongo-backup" || manifest.formatVersion !== 1) {
  console.error("Unsupported backup format.");
  process.exit(1);
}

const snapshotPath = join(backup, manifest.database.filename);
if (!existsSync(snapshotPath)) {
  console.error(`Backup is missing its database file: ${snapshotPath}`);
  process.exit(1);
}

const actualSha256 = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
if (actualSha256 !== manifest.database.sha256) {
  console.error("Backup database does not match the checksum recorded in manifest.json.");
  process.exit(1);
}

// Refuse to clobber live data unless the operator asks for it explicitly. The
// -wal and -shm sidecars belong to the database being replaced, so they have to
// go with it; leaving them behind would reapply the old write-ahead log.
const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
const existingTargets = [databasePath, ...sidecars, attachmentsPath].filter((path) => existsSync(path));

if (existingTargets.length > 0 && !force) {
  console.error("Refusing to overwrite existing data. Stop the server, then re-run with --force:");
  for (const path of existingTargets) console.error(`  ${path}`);
  process.exit(1);
}

for (const path of [databasePath, ...sidecars]) {
  await rm(path, { force: true });
}
await rm(attachmentsPath, { recursive: true, force: true });

await mkdir(dirname(databasePath), { recursive: true });
await cp(snapshotPath, databasePath);
await cp(join(backup, "attachments"), attachmentsPath, { recursive: true });

const restored = new DatabaseSync(databasePath, { readOnly: true });
let summary;

try {
  const integrity = restored.prepare("PRAGMA integrity_check").get();
  const result = integrity.integrity_check ?? Object.values(integrity)[0];
  if (result !== "ok") throw new Error(`Restored database failed integrity_check: ${result}`);

  const stored = restored.prepare("SELECT storage_filename FROM work_item_attachments").all();
  const present = new Set(await readdir(attachmentsPath));
  const missingFiles = stored.map((row) => row.storage_filename).filter((name) => !present.has(name));

  summary = {
    schemaVersion: restored.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    workItems: restored.prepare("SELECT count(*) AS n FROM work_items").get().n,
    attachments: stored.length,
    missingFiles,
  };
} finally {
  restored.close();
}

console.log(`Restored ${backup} (taken ${manifest.createdAt})`);
console.log(`  schema v${summary.schemaVersion}, ${summary.workItems} work item(s), ${summary.attachments} attachment row(s)`);

if (summary.missingFiles.length > 0) {
  console.error(`  ${summary.missingFiles.length} attachment row(s) have no file on disk.`);
  process.exitCode = 1;
} else {
  console.log("  Every attachment row has its file. Start the server.");
}
