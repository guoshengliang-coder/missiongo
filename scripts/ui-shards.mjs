import { readFileSync } from "node:fs";

export function auditDurations() {
  const data = JSON.parse(readFileSync(new URL("../tests/ui/audit-durations.json", import.meta.url), "utf8"));
  if (data.version !== 1 || !data.seconds || Object.values(data.seconds).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Invalid UI duration estimates");
  }
  return data.seconds;
}

// Longest files first, into the least-loaded runner. Unknown/new files use the
// largest recorded estimate, so they remain covered without assuming cheap work.
export function balancedAuditShards(files, durations, count = 8) {
  if (files.length < count || new Set(files).size !== files.length) throw new Error("Invalid UI shard catalog");
  const fallback = Math.max(1, ...Object.values(durations));
  const weight = file => durations[file] ?? fallback;
  const buckets = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const bucket = buckets.reduce((best, next) => next.seconds < best.seconds ? next : best);
    bucket.files.push(file);
    bucket.seconds += weight(file);
  }
  return buckets.map(bucket => bucket.files.sort());
}
