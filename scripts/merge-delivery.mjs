#!/usr/bin/env node
// Read live GitHub evidence for an explicitly selected delivery. Does not merge.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function inspectDelivery(delivery, run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim()) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(delivery.repository)
    || !Number.isSafeInteger(delivery.pullRequest) || delivery.pullRequest < 1
    || !/^[a-f0-9]{40}$/.test(delivery.head) || !/^[\w][\w./-]{0,150}$/.test(delivery.targetBranch)) throw new Error("Invalid delivery identity");
  const repository = delivery.repository.slice("https://github.com/".length);
  const local = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"]));
  if (local.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) throw new Error("Execution repository differs from the delivery");
  const pr = JSON.parse(run("gh", ["pr", "view", String(delivery.pullRequest), "--repo", repository,
    "--json", "url,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeable,statusCheckRollup,mergeCommit,mergedAt"]));
  if (pr.url !== `${delivery.repository}/pull/${delivery.pullRequest}` || pr.headRefOid !== delivery.head
    || pr.baseRefName !== delivery.targetBranch || !/^[a-f0-9]{40}$/.test(pr.baseRefOid)) throw new Error("PR identity or approved revision changed");
  const checks = pr.statusCheckRollup ?? [];
  const passed = checks.length > 0 && checks.every(c => "conclusion" in c
    ? c.status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion)
    : c.state === "SUCCESS");
  const failed = checks.some(c => ["FAILURE", "ERROR"].includes(c.state) || ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion));
  const evidence = { head: delivery.head, base: pr.baseRefOid, checkedAt: new Date().toISOString(),
    checks: passed ? "passed" : failed ? "failed" : checks.length ? "pending" : "unknown",
    mergeable: pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" ? "clean" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    source: pr.url };
  if (pr.state === "MERGED") {
    if (!pr.mergedAt || !/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid)) throw new Error("Missing merge receipt");
    // Fetch the current target branch; prove the reported merge is integrated.
    run("git", ["fetch", delivery.repository, delivery.targetBranch]);
    run("git", ["merge-base", "--is-ancestor", pr.mergeCommit.oid, "FETCH_HEAD"]);
    return { evidence, result: { status: "merged", head: delivery.head, commit: pr.mergeCommit.oid,
      detail: `Verified ${pr.url} merged at ${pr.mergedAt}; merge commit is included in ${delivery.targetBranch}.` } };
  }
  return { evidence, ready: evidence.checks === "passed" && evidence.mergeable === "clean",
    mergeArguments: ["pr", "merge", String(delivery.pullRequest), "--repo", repository, "--merge", "--match-head-commit", delivery.head] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/merge-delivery.mjs <delivery-json-file>");
    console.log(JSON.stringify(inspectDelivery(JSON.parse(readFileSync(process.argv[2], "utf8")))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
