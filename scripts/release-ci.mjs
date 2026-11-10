#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function assertReleaseCI(runs) {
  for (const name of ["web-and-server", "ui", "android", "macos"]) {
    const matches = runs.filter((run) => run.name === name);
    const latest = matches.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(`CI ${name} must complete successfully (found ${latest?.status ?? "missing"}/${latest?.conclusion ?? "pending"}).`);
    }
  }
  if (runs.some((run) => run.name !== "deploy" && (run.status !== "completed" || !["success", "skipped", "neutral"].includes(run.conclusion)))) {
    throw new Error("Other CI checks are still pending or failed.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const commit = process.argv[2];
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("A full release commit is required.");
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/:owner/:repo/commits/${commit}/check-runs?per_page=100`], { encoding: "utf8" }));
    assertReleaseCI(pages.flatMap((page) => page.check_runs));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
