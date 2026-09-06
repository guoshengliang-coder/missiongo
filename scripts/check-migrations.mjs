#!/usr/bin/env node
//
// Fail the build when two migrations claim the same version number.
//
// Migrations are guarded by `SELECT version FROM schema_migrations WHERE
// version = N` and closed by an INSERT of the same N, so a number is a
// migration's identity. Two branches working in parallel both reach for the
// next integer, and the collision only shows up after a merge: the second
// migration reads the first one's row, decides it has already run, and silently
// never applies. That happened -- one branch took 13 and 14 while another was
// writing its own 13 -- and it was caught by hand, not by anything here.
//
// New migrations take a UTC timestamp (YYYYMMDDHHMM) rather than the next
// integer, which two branches cannot collide on. The small numbers below are
// the ones that already shipped and keep their identity forever.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "services/server/src/storage/database.ts"), "utf8");

/** Versions already released as plain integers, before timestamps were adopted. */
const LEGACY_LIMIT = 100;

const failures = [];

// Comments talk about version numbers too, so read only from code.
const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const guards = [...code.matchAll(/schema_migrations WHERE version = (\d+)/g)].map((m) => Number(m[1]));
const inserts = [...code.matchAll(/INSERT(?: OR IGNORE)? INTO schema_migrations[\s\S]{0,160}?\.run\((\d+),/g)]
  .map((m) => Number(m[1]));

if (inserts.length === 0) failures.push("No migration INSERTs found; this check is looking at the wrong file.");

const counted = new Map();
for (const version of inserts) counted.set(version, (counted.get(version) ?? 0) + 1);
for (const [version, count] of counted) {
  if (count > 1) {
    failures.push(
      `Migration ${version} is recorded ${count} times. Two migrations sharing a number means the second never runs.`,
    );
  }
}

for (const version of new Set(guards)) {
  if (!counted.has(version)) {
    failures.push(`Migration ${version} is guarded but never recorded, so it would run on every start.`);
  }
}

// A new migration numbered like the old ones is exactly how the collision
// happened, so the rule is enforced rather than written down and hoped for.
const newest = Math.max(...inserts);
for (const version of counted.keys()) {
  if (version >= LEGACY_LIMIT && !/^20\d{10}$/.test(String(version))) {
    failures.push(`Migration ${version} is neither a legacy integer nor a YYYYMMDDHHMM timestamp.`);
  }
}

if (failures.length > 0) {
  console.error("Migration numbering is broken:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nNumber a new migration with a UTC timestamp, e.g. 202609062245.");
  process.exit(1);
}

console.log(`Migrations: ${counted.size} versions, none repeated (newest ${newest}).`);
