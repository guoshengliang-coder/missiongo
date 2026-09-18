#!/usr/bin/env node
// Match a verified release receipt to MissionGo's PR-backed candidates. This
// prints proposed comments; the OAuth-connected AI client performs the final
// full item read and append_comment calls. No credential is passed to a script.

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

export function proposedComment(candidate, change) {
  const name = ARTIFACT_NAMES[change.artifact];
  const version = change.build ? `${change.version}（构建 ${change.build}）` : change.version;
  const key = createHash("sha256")
    .update(`${candidate.itemKey}\n${change.artifact}\n${change.version}\n${change.toCommit}`)
    .digest("hex");
  return {
    itemKey: candidate.itemKey,
    bodyKind: "free",
    summary: `${name} ${version} 已正式发布，可开始验证`,
    text: `${name} ${version} 已正式发布。来源提交：${change.toCommit}。关联 PR：${candidate.pullRequestUrl}。请在此版本中验证本条目的行为；这条通知不代表验收通过。`,
    idempotencyKey: `release-notice:${key}`,
    artifact: change.artifact,
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
    let matched = false;
    for (const change of receipt.changes ?? []) {
      if (!change.eligibleForMatching) continue;
      if (!inReleasedRange(pr.mergeCommit, change.fromCommit, change.toCommit, ancestor)) continue;
      if (!pr.files.some((path) => affectsArtifact(path, change.artifact))) continue;
      comments.push(proposedComment(candidate, change));
      matched = true;
    }
    if (!matched) skipped.push({ itemKey: candidate.itemKey, reason: "no verified published artifact contains this PR" });
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
