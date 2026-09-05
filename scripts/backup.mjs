#!/usr/bin/env node

// Create a consistent MissionGo backup: a SQLite snapshot plus the attachment
// directory the database rows point at.
//
// The database runs in WAL mode, so copying missiongo.sqlite with `cp` can
// capture a torn snapshot that is missing everything still in the -wal file.
// `VACUUM INTO` instead writes a fully checkpointed copy from a single read
// transaction, which is safe while the server is running.
//
// The snapshot is taken before the attachments are copied. An attachment
// uploaded between the two steps then becomes a file with no row, which is
// harmless, rather than a row with no file, which breaks the item detail view.
// Attachments deleted mid-run can still leave a row without its file, so stop
// the server first when you need a guaranteed-consistent archive.

import { loadEnvFile } from "node:process";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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

const databasePath = resolve(option("database") ?? process.env.DATABASE_PATH ?? "./data/missiongo.sqlite");
const attachmentsPath = resolve(option("attachments") ?? process.env.ATTACHMENTS_PATH ?? "./data/attachments");
const outputRoot = option("out");

if (!outputRoot) {
  console.error("Usage: node scripts/backup.mjs --out <directory> [--database <file>] [--attachments <directory>]");
  process.exit(1);
}

if (!existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exit(1);
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const target = resolve(outputRoot, `missiongo-${stamp}`);

if (existsSync(target)) {
  console.error(`Backup directory already exists: ${target}`);
  process.exit(1);
}

await mkdir(target, { recursive: true, mode: 0o700 });

const snapshotPath = join(target, basename(databasePath));
const source = new DatabaseSync(databasePath, { readOnly: true });
let manifest;

try {
  source.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
} finally {
  source.close();
}

// Copy attachments after the snapshot so a concurrent upload cannot produce a
// row whose file is missing from the archive.
if (existsSync(attachmentsPath)) {
  await cp(attachmentsPath, join(target, "attachments"), { recursive: true });
} else {
  await mkdir(join(target, "attachments"), { recursive: true });
}

const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });

try {
  const integrity = snapshot.prepare("PRAGMA integrity_check").get();
  const result = integrity.integrity_check ?? Object.values(integrity)[0];
  if (result !== "ok") throw new Error(`Snapshot failed integrity_check: ${result}`);

  const schemaVersion = snapshot.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
  const counts = {
    products: snapshot.prepare("SELECT count(*) AS n FROM products").get().n,
    workItems: snapshot.prepare("SELECT count(*) AS n FROM work_items").get().n,
    attachments: snapshot.prepare("SELECT count(*) AS n FROM work_item_attachments").get().n,
  };

  // Cross-check the two halves of the backup against each other. A row without
  // its file cannot be restored, so surface it here rather than at restore time.
  const stored = snapshot.prepare("SELECT storage_filename FROM work_item_attachments").all();
  const present = new Set(
    existsSync(join(target, "attachments")) ? await readdir(join(target, "attachments")) : [],
  );
  const missingFiles = stored.map((row) => row.storage_filename).filter((name) => !present.has(name));
  const orphanFiles = [...present].filter(
    (name) => !stored.some((row) => row.storage_filename === name),
  );

  manifest = {
    tool: "missiongo-backup",
    formatVersion: 1,
    createdAt: startedAt.toISOString(),
    source: { databasePath, attachmentsPath },
    database: {
      filename: basename(snapshotPath),
      sizeBytes: statSync(snapshotPath).size,
      sha256: createHash("sha256").update(readFileSync(snapshotPath)).digest("hex"),
      schemaVersion,
    },
    counts: { ...counts, attachmentFiles: present.size },
    consistency: { missingFiles, orphanFiles },
  };

  if (missingFiles.length > 0) {
    console.warn(`Warning: ${missingFiles.length} attachment row(s) have no file in this backup.`);
  }
  if (orphanFiles.length > 0) {
    console.warn(`Note: ${orphanFiles.length} attachment file(s) have no database row. They are kept as-is.`);
  }
} finally {
  snapshot.close();
}

await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

console.log(`Backup written to ${target}`);
console.log(
  `  schema v${manifest.database.schemaVersion}, ${manifest.counts.workItems} work item(s), `
  + `${manifest.counts.attachments} attachment row(s), ${manifest.counts.attachmentFiles} file(s)`,
);
