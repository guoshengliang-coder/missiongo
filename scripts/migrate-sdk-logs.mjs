#!/usr/bin/env node

// Move SDK diagnostics out of the work item's creation event and into a .log
// attachment.
//
// This is a script rather than a schema migration because it writes a file: the
// database layer knows nothing about the attachment directory, and giving it a
// path just to run this once would tie storage to the schema permanently.
//
// Safe to run twice. An item whose creation event no longer carries `logs` is
// already done and is skipped.

import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { formatFeedbackLog } from "@missiongo/domain";

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
const dryRun = process.argv.includes("--dry-run");

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON;");

const candidates = db
  .prepare(
    `SELECT e.id AS event_id, e.item_id, e.payload_json, w.item_key
     FROM work_item_events e JOIN work_items w ON w.id = e.item_id
     WHERE e.event_type = 'item_created' AND e.payload_json LIKE '%"logs"%'`,
  )
  .all();

let moved = 0;
for (const row of candidates) {
  const payload = JSON.parse(row.payload_json);
  if (!Array.isArray(payload.logs) || payload.logs.length === 0) continue;

  const text = formatFeedbackLog(payload.logs);
  const bytes = Buffer.from(text, "utf8");
  const filename = `${row.item_key}-diagnostics.log`;
  const storageFilename = `${randomUUID()}.log`;
  console.log(`${row.item_key}: ${payload.logs.length} 条 → ${filename} (${bytes.length} 字节)`);
  if (dryRun) continue;

  const now = new Date().toISOString();
  // Files sit flat under the attachments root, named by their storage filename.
  await mkdir(attachmentsPath, { recursive: true, mode: 0o700 });
  await writeFile(join(attachmentsPath, storageFilename), bytes);

  // The counter table hands out the per-kind display number the UI and the MCP
  // context both cite, so take one from it rather than inventing a number.
  db.exec("BEGIN IMMEDIATE;");
  try {
    const counter = db
      .prepare("SELECT next_number FROM work_item_attachment_counters WHERE item_id = ? AND kind = 'log'")
      .get(row.item_id);
    const displayNumber = counter?.next_number ?? 1;
    db.prepare(
      `INSERT INTO work_item_attachment_counters (item_id, kind, next_number) VALUES (?, 'log', ?)
       ON CONFLICT(item_id, kind) DO UPDATE SET next_number = ?`,
    ).run(row.item_id, displayNumber + 1, displayNumber + 1);
    db.prepare(
      `INSERT INTO work_item_attachments
         (id, item_id, kind, display_number, original_filename, storage_filename, content_type,
          size_bytes, created_at)
       VALUES (?, ?, 'log', ?, ?, ?, 'text/plain', ?, ?)`,
    ).run(randomUUID(), row.item_id, displayNumber, filename, storageFilename, bytes.length, now);

    const { logs, ...rest } = payload;
    db.prepare("UPDATE work_item_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...rest, logEntryCount: logs.length }), row.event_id);
    db.exec("COMMIT;");
    moved += 1;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

console.log(dryRun ? `\n试运行：${candidates.length} 条待处理，未改动任何内容。` : `\n完成：搬移 ${moved} 条。`);
db.close();
