#!/usr/bin/env node
// Match a verified release receipt to development-complete PRs. Print proposed
// comments and constrained status handoffs; the OAuth client reads each item
// before writing. No MissionGo credential is passed to this script.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ARTIFACT_NAMES = {
  web: "Web/Server",
  androidApp: "Android App",
  androidSdk: "Android SDK",
  macosApp: "macOS App",
};

export function affectsArtifact(path, artifact) {
  if (path.includes("/test/") || path.includes("/tests/") || /(?:\.test\.|\.spec\.|Tests\/)/.test(path)) return false;
  if (artifact === "web") return /^(apps\/web\/|services\/|packages\/|deploy\/)/.test(path);
  if (artifact === "androidApp") return /^(apps\/android\/|sdks\/android-feedback\/missiongo-feedback\/|sdks\/android-feedback\/gradle\.properties$|product\.json$)/.test(path);
  if (artifact === "androidSdk") return /^(sdks\/android-feedback\/missiongo-feedback\/|sdks\/android-feedback\/gradle\.properties$)/.test(path);
  if (artifact === "macosApp") return /^(apps\/macos\/|product\.json$)/.test(path);
  return false;
}

export function inReleasedRange(mergeCommit, fromCommit, toCommit, isAncestor) {
  if (![mergeCommit, fromCommit, toCommit].every((value) => /^[0-9a-f]{40}$/.test(value ?? ""))) return false;
  return isAncestor(fromCommit, toCommit)
    && isAncestor(mergeCommit, toCommit)
    && !isAncestor(mergeCommit, fromCommit);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isAncestor(older, newer) {
  return spawnSync("git", ["merge-base", "--is-ancestor", older, newer]).status === 0;
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function parsePullRequest(url, repository) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url);
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function pullRequestFacts(url, repository) {
  const parsed = parsePullRequest(url, repository);
  if (!parsed) return null;
  const view = JSON.parse(gh("pr", "view", url, "--json", "state,mergedAt,mergeCommit"));
  if (view.state !== "MERGED" || !view.mergedAt || !view.mergeCommit?.oid) return null;
  const files = gh("api", `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files`, "--paginate", "--jq", ".[].filename")
    .split("\n").filter(Boolean);
  return { mergeCommit: view.mergeCommit.oid, files };
}

export function requiredArtifactsForFiles(files) {
  return Object.keys(ARTIFACT_NAMES).filter((artifact) => files.some((path) => affectsArtifact(path, artifact))).sort();
}

function currentRelease(receipt, artifact) {
  const current = receipt.current?.[artifact];
  if (!current || receipt.publicEvidence?.checks?.web !== true
    || receipt.publicEvidence?.checks?.[artifact] !== true) return null;
  const sourceCommit = artifact === "web" ? current.commit : current.sourceCommit;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) return null;
  if (artifact === "web" && (current.clean !== true || current.ciPassed !== true)) return null;
  const version = current.version;
  if (typeof version !== "string" || !version) return null;
  return { artifact, version: current.build ? `${version}（构建 ${current.build}）` : version, sourceCommit };
}

export function proposedComment(candidate, releases, receipt) {
  const version = releases.map((release) => `${ARTIFACT_NAMES[release.artifact]} ${release.version}`).join("、");
  const key = createHash("sha256")
    .update(`${candidate.itemKey}\n${candidate.pullRequestUrl}\n${JSON.stringify(releases)}`)
    .digest("hex");
  const receiptDigest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return {
    itemKey: candidate.itemKey,
    bodyKind: "free",
    summary: `${version} 已正式发布，可开始验证`,
    text: `${version} 已正式发布。关联 PR：${candidate.pullRequestUrl}。各产物来源提交：${releases.map((release) => `${ARTIFACT_NAMES[release.artifact]} ${release.sourceCommit}`).join("；")}。请在这些版本验证本条目；这条通知不代表验收通过。`,
    idempotencyKey: `release-notice:${key}`,
    transitionIdempotencyKey: `release-handoff:${key}`,
    pullRequestUrl: candidate.pullRequestUrl,
    releases,
    deployedCommit: receipt.deployedCommit,
    receiptDigest,
  };
}

export function matchCandidates(receipt, candidates, resolvePr, ancestor = isAncestor) {
  const comments = [];
  const skipped = [];
  for (const candidate of candidates) {
    if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(candidate.itemKey ?? "")) {
      skipped.push({ itemKey: candidate.itemKey, reason: "invalid item key" });
      continue;
    }
    let pr;
    try { pr = resolvePr(candidate.pullRequestUrl); }
    catch (error) { skipped.push({ itemKey: candidate.itemKey, reason: `PR lookup failed: ${String(error)}` }); continue; }
    if (!pr) { skipped.push({ itemKey: candidate.itemKey, reason: "PR is not a verified merge in this repository" }); continue; }
    const required = requiredArtifactsForFiles(pr.files);
    const recorded = Array.isArray(candidate.requiredArtifacts) ? candidate.requiredArtifacts : [];
    if (required.length === 0 || recorded.some((artifact) => typeof artifact !== "string")
      || JSON.stringify(required) !== JSON.stringify([...recorded].sort())) {
      skipped.push({ itemKey: candidate.itemKey, reason: "required artifacts differ from the merged PR files" });
      continue;
    }
    const releases = required.map((artifact) => currentRelease(receipt, artifact));
    if (releases.some((release) => !release)
      || !/^[0-9a-f]{40}$/.test(receipt.deployedCommit ?? "")
      || releases.some((release) => !ancestor(pr.mergeCommit, release.sourceCommit))) {
      skipped.push({ itemKey: candidate.itemKey, reason: "not every required public artifact contains the PR" });
      continue;
    }
    const newlyPublished = (receipt.changes ?? []).some((change) =>
      required.includes(change.artifact) && change.eligibleForMatching
      && inReleasedRange(pr.mergeCommit, change.fromCommit, change.toCommit, ancestor));
    if (!newlyPublished) {
      skipped.push({ itemKey: candidate.itemKey, reason: "no newly published required artifact contains this PR" });
      continue;
    }
    comments.push(proposedComment(candidate, releases, receipt));
  }
  return { comments, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const receiptIndex = args.indexOf("--receipt");
  const candidatesIndex = args.indexOf("--candidates");
  if (receiptIndex < 0 || candidatesIndex < 0 || !args[receiptIndex + 1] || !args[candidatesIndex + 1]) {
    throw new Error("Usage: release-notices.mjs --receipt <JSON file> --candidates <MCP result JSON file>");
  }
  const receipt = JSON.parse(readFileSync(args[receiptIndex + 1], "utf8"));
  const candidateResult = JSON.parse(readFileSync(args[candidatesIndex + 1], "utf8"));
  const candidates = candidateResult.candidates;
  if (receipt.schemaVersion !== 1 || !Array.isArray(candidates)) throw new Error("Invalid release receipt or candidate result");
  if (!isAncestor(receipt.deployedCommit, git("rev-parse", "HEAD"))) {
    throw new Error("The deployed commit is not in this checkout; use the repository that was deployed");
  }
  const repository = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
  process.stdout.write(`${JSON.stringify(matchCandidates(receipt, candidates, (url) => pullRequestFacts(url, repository)), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
