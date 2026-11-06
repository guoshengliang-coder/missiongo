#!/usr/bin/env node
// Read live GitHub evidence for an explicitly selected delivery. Does not merge.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function inspectDelivery(delivery, run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim()) {
  delivery = { ...delivery, head: delivery.executionHead ?? delivery.head };
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
  const targetRef = `refs/heads/${delivery.targetBranch}`;
  const targetLines = run("git", ["ls-remote", "--refs", delivery.repository, targetRef]).split("\n").filter(Boolean);
  const target = targetLines.length === 1 ? targetLines[0].split(/\s+/) : [];
  if (target[1] !== targetRef || !/^[a-f0-9]{40}$/.test(target[0] ?? "")) throw new Error("Target branch reference is missing or ambiguous");
  const targetHead = target[0];
  if (pr.state !== "MERGED" && pr.baseRefOid !== targetHead) throw new Error("PR base differs from actual target branch; repeat validation");
  if (pr.state !== "MERGED" && delivery.expectedBase && delivery.expectedBase !== targetHead) throw new Error("Target base changed; repeat validation");
  const checks = pr.statusCheckRollup ?? [];
  const passed = checks.length > 0 && checks.every(c => "conclusion" in c
    ? c.status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion)
    : c.state === "SUCCESS");
  const failed = checks.some(c => ["FAILURE", "ERROR"].includes(c.state) || ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion));
  const evidence = { head: delivery.head, base: targetHead, checkedAt: new Date().toISOString(),
    checks: passed ? "passed" : failed ? "failed" : checks.length ? "pending" : "unknown",
    mergeable: pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" ? "clean" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    source: pr.url };
  if (pr.state === "MERGED") {
    if (!pr.mergedAt || !/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid)) throw new Error("Missing merge receipt");
    // Fetch the current target branch; prove the reported merge is integrated.
    run("git", ["fetch", delivery.repository, delivery.targetBranch]);
    const fetched = run("git", ["rev-parse", "FETCH_HEAD"]);
    if (fetched !== targetHead) throw new Error("Target branch changed while collecting merge evidence; retry");
    run("git", ["merge-base", "--is-ancestor", pr.mergeCommit.oid, fetched]);
    return { evidence, result: { status: "merged", head: delivery.head, commit: pr.mergeCommit.oid,
      detail: `Verified ${pr.url} merged at ${pr.mergedAt}; merge commit is included in ${delivery.targetBranch}.` } };
  }
  return { evidence, ready: delivery.mergeReady !== false && evidence.checks === "passed" && evidence.mergeable === "clean",
    mergeArguments: ["pr", "merge", String(delivery.pullRequest), "--repo", repository, "--merge", "--match-head-commit", delivery.head] };
}

/** Collect an external merge observation; does not authorize or apply recovery. */
export function inspectMergedReconciliation(delivery, run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim()) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(delivery.repository)
    || !Number.isSafeInteger(delivery.pullRequest) || delivery.pullRequest < 1
    || !/^[a-f0-9]{40}$/.test(delivery.head) || typeof delivery.validation !== "string" || !delivery.validation.trim()) throw new Error("Explicit delivery and completed local validation are required");
  const repository = delivery.repository.slice("https://github.com/".length);
  const pr = JSON.parse(run("gh", ["pr", "view", String(delivery.pullRequest), "--repo", repository, "--json", "state,headRefOid"]));
  if (pr.state !== "MERGED" || !/^[a-f0-9]{40}$/.test(pr.headRefOid)) throw new Error("External outcome is not a verified merge");
  const inspected = inspectDelivery({ ...delivery, executionHead: pr.headRefOid }, run);
  if (!inspected.result || inspected.evidence.checks !== "passed") throw new Error("Merged result and passing checks are required");
  run("git", ["fetch", delivery.repository, `refs/pull/${delivery.pullRequest}/head`]);
  if (run("git", ["rev-parse", "FETCH_HEAD"]) !== pr.headRefOid) throw new Error("PR changed during reconciliation");
  run("git", ["merge-base", "--is-ancestor", delivery.head, pr.headRefOid]);
  return {head:pr.headRefOid,commit:inspected.result.commit,targetHead:inspected.evidence.base,
    checkedAt:inspected.evidence.checkedAt,source:inspected.evidence.source,checks:"passed",local:"passed",
    originalIncluded:true,targetIncludesMerge:true,validation:delivery.validation.trim()};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const reconcile = process.argv[2] === "--reconcile";
    if (process.argv.length !== (reconcile ? 4 : 3)) throw new Error("Usage: node scripts/merge-delivery.mjs <delivery-json-file>");
    console.log(JSON.stringify((reconcile ? inspectMergedReconciliation : inspectDelivery)(JSON.parse(readFileSync(process.argv[reconcile ? 3 : 2], "utf8")))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
