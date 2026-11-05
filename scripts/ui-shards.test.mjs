import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDurations, balancedAuditShards } from "./ui-shards.mjs";
import { auditCatalog } from "./ui-test-plan.mjs";

test("duration-based allocation is deterministic and balances long files", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const durations = { a: 100, b: 90, c: 80, d: 70, e: 60, f: 50, g: 40, h: 30 };
  const buckets = balancedAuditShards(files, durations, 4);
  assert.deepEqual(buckets, [["a", "h"], ["b", "g"], ["c", "f"], ["d", "e"]]);
  assert.deepEqual(balancedAuditShards([...files].reverse(), durations, 4), buckets);
  assert.deepEqual(buckets.flat().sort(), files);
});

test("new and renamed files remain covered, while deleted duration entries are ignored", () => {
  const files = ["known", "new", "renamed", "other"];
  const buckets = balancedAuditShards(files, { known: 10, other: 5, deleted: 100 }, 2);
  assert.deepEqual(buckets.flat().sort(), [...files].sort());
  assert.equal(buckets[0].includes("new") && buckets[0].includes("renamed"), false);
  assert.throws(() => balancedAuditShards(["same", "same"], {}, 2));
  assert.throws(() => balancedAuditShards(["only"], {}, 2));
});

test("recorded estimates allocate the complete current catalog once with balanced loads", () => {
  const files = auditCatalog(), durations = auditDurations();
  const buckets = balancedAuditShards(files, durations);
  assert.equal(buckets.length, 8);
  assert.deepEqual(buckets.flat().sort(), files);
  const fallback = Math.max(...Object.values(durations));
  const loads = buckets.map(bucket => bucket.reduce((sum, file) => sum + (durations[file] ?? fallback), 0));
  assert(Math.max(...loads) - Math.min(...loads) <= fallback);
});
