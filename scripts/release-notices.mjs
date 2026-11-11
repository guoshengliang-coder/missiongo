#!/usr/bin/env node
// Match a verified release receipt to development-complete PRs. Print proposed
// comments and constrained status handoffs; the OAuth client reads each item
// before writing. No MissionGo credential is passed to this script.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { candidateIdentity, readReleaseSelection, releaseCandidatesFromPages } from "./release-candidates.mjs";
export { releaseCandidatesFromPages } from "./release-candidates.mjs";

const ARTIFACT_NAMES = {
  web: "Web/Server",
  androidApp: "Android App",
  androidSdk: "Android SDK",
  macosApp: "macOS App",
  linuxCli: "Linux CLI",
};

/** Display name for an artifact; a product-specific identifier stands for itself. */
function artifactName(artifact) {
  return ARTIFACT_NAMES[artifact] ?? artifact;
}

export function affectsArtifact(path, artifact) {
  if (path.includes("/test/") || path.includes("/tests/") || /(?:\.test\.|\.spec\.|Tests\/)/.test(path)) return false;
  if (artifact === "web") return /^(apps\/web\/|services\/|packages\/|deploy\/)/.test(path);
  if (artifact === "androidApp") return /^(apps\/android\/|sdks\/android-feedback\/missiongo-feedback\/|sdks\/android-feedback\/gradle\.properties$|product\.json$)/.test(path);
  if (artifact === "androidSdk") return /^(sdks\/android-feedback\/missiongo-feedback\/|sdks\/android-feedback\/gradle\.properties$)/.test(path);
  if (artifact === "macosApp") return /^(apps\/macos\/|product\.json$)/.test(path);
  if (artifact === "linuxCli") return /^(apps\/node\/|packages\/domain\/|scripts\/(?:build-node|publish-linux)\.mjs$)/.test(path);
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
  return { mergeCommit: view.mergeCommit.oid };
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
  const version = releases.map((release) => `${artifactName(release.artifact)} ${release.version}`).join("、");
  const key = createHash("sha256")
    .update(`${candidate.itemKey}\n${candidate.developmentEventId ?? "legacy"}\n${JSON.stringify(candidate.completion)}\n${candidate.pullRequestUrl}\n${JSON.stringify(releases)}`)
    .digest("hex");
  const receiptDigest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return {
    itemKey: candidate.itemKey,
    ...(candidate.developmentEventId ? {developmentEventId:candidate.developmentEventId} : {}),
    bodyKind: "free",
    summary: `${version} 已正式发布，可开始验证`,
    text: `${version} 已正式发布。关联集成：${candidate.pullRequestUrl ?? candidate.completion?.url ?? candidate.completion?.commit ?? "未提供"}。各产物来源提交：${releases.map((release) => `${artifactName(release.artifact)} ${release.sourceCommit}`).join("；")}。请在这些版本验证本条目；这条通知不代表验收通过。`,
    idempotencyKey: `release-notice:${key}`,
    transitionIdempotencyKey: `release-handoff:${key}`,
    pullRequestUrl: candidate.pullRequestUrl,
    releases,
    deployedCommit: receipt.deployedCommit,
    receiptDigest,
  };
}

/** Build deterministic, bounded MCP requests; never invent concurrency tokens for old servers. */
export function releaseBatches(productId, candidates, matched) {
  const batches = [], skipped = [...matched.skipped], items = [];
  for (const comment of matched.comments) {
    const candidate = candidates.find(row => row.itemKey === comment.itemKey && (!comment.developmentEventId || row.developmentEventId===comment.developmentEventId));
    if (!Number.isSafeInteger(candidate?.expectedRevision) || candidate.expectedRevision < 1
      || !/^[0-9a-f-]{36}$/.test(candidate.developmentEventId ?? "") || !/^[0-9a-f-]{36}$/.test(candidate.roundKey ?? "")) {
      skipped.push({ itemKey: comment.itemKey, reason: "candidate snapshot missing; refresh from a server supporting release batches" });
      continue;
    }
    items.push({ itemKey: candidate.itemKey, expectedRevision: candidate.expectedRevision,
      developmentEventId: candidate.developmentEventId, roundKey: candidate.roundKey,
      ...(candidate.completion ? { completion: candidate.completion } : { pullRequestUrl: candidate.pullRequestUrl }), releases: comment.releases });
  }
  items.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  for (let offset = 0; offset < items.length; offset += 100) {
    const request = { productId, deployedCommit: matched.comments[0].deployedCommit,
      receiptDigest: matched.comments[0].receiptDigest, items: items.slice(offset, offset + 100) };
    batches.push({ ...request, idempotencyKey: `release-batch:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}` });
  }
  const deliveries=(matched.deliveries ?? []).map(row=>({deliveryId:row.deliveryId,expectedRevision:row.expectedRevision,releases:row.releases}));
  for(let offset=0;offset<deliveries.length;offset+=100) {
    const request={productId,deployedCommit:matched.deliveries[0].deployedCommit,receiptDigest:matched.deliveries[0].receiptDigest,items:[],deliveries:deliveries.slice(offset,offset+100)};
    batches.push({...request,idempotencyKey:`release-deliveries:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`});
  }
  return { batches, skipped };
}

export function matchCandidates(receipt, candidates, resolvePr, ancestor = isAncestor) {
  const comments = [];
  const deliveries = [];
  const skipped = [];
  const facts = new Map();
  for (const candidate of candidates) {
    if (candidate.kind!=="delivery" && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(candidate.itemKey ?? "")) {
      skipped.push({ ...(candidate.kind==="delivery" ? {deliveryId:candidate.deliveryId,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey}), reason: "invalid item key" });
      continue;
    }
    let pr;
    try {
      if(candidate.completion?.kind==="commit" && /^[0-9a-f]{40}$/.test(candidate.completion.commit ?? "")) pr={mergeCommit:candidate.completion.commit};
      else {
        if (!facts.has(candidate.pullRequestUrl)) facts.set(candidate.pullRequestUrl,resolvePr(candidate.pullRequestUrl));
        pr = facts.get(candidate.pullRequestUrl);
      }
    }
    catch (error) { skipped.push({ ...(candidate.kind==="delivery" ? {deliveryId:candidate.deliveryId,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey}), reason: `PR lookup failed: ${String(error)}` }); continue; }
    if (!pr) { skipped.push({ ...(candidate.kind==="delivery" ? {deliveryId:candidate.deliveryId,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey}), reason: "PR is not a verified merge in this repository" }); continue; }
    // The explicitly registered scope is authoritative. File paths remain a
    // suggestion at development time, not a second competing release contract.
    const recorded = candidate.requiredArtifacts;
    if (!Array.isArray(recorded) || !recorded.length || new Set(recorded).size !== recorded.length
      || recorded.some(artifact => typeof artifact !== "string" || !/^[a-z][A-Za-z0-9_-]{0,49}$/.test(artifact))) {
      skipped.push({...(candidate.kind==="delivery" ? {deliveryId:candidate.deliveryId,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey}),reason:"release scope is missing or invalid"}); continue;
    }
    const required = [...recorded].sort();
    const releases = required.map((artifact) => currentRelease(receipt, artifact));
    if (releases.some((release) => !release)
      || !/^[0-9a-f]{40}$/.test(receipt.deployedCommit ?? "")
      || releases.some((release) => !ancestor(pr.mergeCommit, release.sourceCommit))) {
      skipped.push({ ...(candidate.kind==="delivery" ? {deliveryId:candidate.deliveryId,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey}), reason: "not every required public artifact contains the PR" });
      continue;
    }
    // A currently verified release containing the PR can repair a missed
    // handoff even when nothing new was published in this particular receipt.
    if(candidate.kind==="delivery") deliveries.push({deliveryId:candidate.deliveryId,expectedRevision:candidate.expectedRevision,pullRequestUrl:candidate.pullRequestUrl,
      releases,deployedCommit:receipt.deployedCommit,receiptDigest:createHash("sha256").update(JSON.stringify(receipt)).digest("hex")});
    else comments.push(proposedComment(candidate, releases, receipt));
  }
  return { comments, skipped, ...(deliveries.length ? {deliveries} : {}) };
}


/** Keep service pages immutable; verified local supplements are explicit and snapshot-bound. */
export function withVerifiedEvidence(productId, candidates, evidence) {
  if (!evidence || evidence.productId !== productId || !Array.isArray(evidence.items) || !evidence.items.length
    || evidence.items.length > 100 || new Set(evidence.items.map(row => `${row.itemKey}:${row.developmentEventId}`)).size !== evidence.items.length) throw new Error("Invalid verified evidence product/items");
  const result = candidates.map(row => ({...row}));
  for (const row of evidence.items) {
    const candidate = result.find(c => c.itemKey === row.itemKey && c.developmentEventId===row.developmentEventId);
    if (!candidate || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1
      || ["expectedRevision", "developmentEventId", "roundKey"].some(key => !row[key] || candidate[key] !== row[key])) throw new Error("Verified evidence candidate changed");
    if (typeof row.verification !== "string" || !row.verification.trim() || row.verification.length > 4000
      || row.completion?.kind !== "github" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(row.completion.url ?? "")
      || !Array.isArray(row.requiredArtifacts) || !row.requiredArtifacts.length || row.requiredArtifacts.length > 20
      || new Set(row.requiredArtifacts).size !== row.requiredArtifacts.length
      || row.requiredArtifacts.some(a => typeof a !== "string" || !/^[a-z][A-Za-z0-9_-]{0,49}$/.test(a))) throw new Error("Explicit verified integration, complete artifact scope and verification record required");
    if (candidate.completion && JSON.stringify(candidate.completion) !== JSON.stringify(row.completion)
      || candidate.pullRequestUrl && candidate.pullRequestUrl !== row.completion.url
      || candidate.requiredArtifacts && JSON.stringify([...candidate.requiredArtifacts].sort()) !== JSON.stringify([...row.requiredArtifacts].sort())) throw new Error("Verified evidence conflicts with service evidence");
    candidate.completion = row.completion;
    candidate.pullRequestUrl = row.completion.url;
    candidate.requiredArtifacts = [...row.requiredArtifacts];
  }
  return result;
}


/** Reconciliation consumes exactly the same frozen dispositions as deployment. */
export function matchReleaseSelection(receipt,snapshot,selection,repository,resolvePr,ancestor=isAncestor) {
  const ledger=readReleaseSelection(selection,snapshot,repository,receipt.deployedCommit);
  const included=new Set(ledger?.entries.filter(e=>e.disposition==="include").map(e=>e.identity));
  const selected=ledger ? snapshot.candidates.filter(c=>included.has(candidateIdentity(c))) : snapshot.candidates;
  return {...matchCandidates(receipt,selected,resolvePr,ancestor),...(ledger ? {selection:ledger} : {})};
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
  if (receipt.schemaVersion !== 1) throw new Error("Invalid release receipt");
  const selectionIndex=args.indexOf("--selection");
  if(selectionIndex>=0 && !args[selectionIndex+1])throw new Error("Missing release selection file");
  const selection=selectionIndex>=0 ? JSON.parse(readFileSync(args[selectionIndex+1],"utf8")) : undefined;
  const snapshot=releaseCandidatesFromPages(candidateResult,selection ? {coverage:true,maxAgeMs:Number.MAX_SAFE_INTEGER} : {});
  const {productId,candidates:originalCandidates}=snapshot;
  const evidenceIndex = args.indexOf("--verified-evidence");
  if (evidenceIndex >= 0 && !args[evidenceIndex + 1]) throw new Error("Missing verified evidence file");
  const evidence = evidenceIndex >= 0 ? JSON.parse(readFileSync(args[evidenceIndex + 1], "utf8")) : undefined;
  if(selection && evidence)throw new Error("Refresh service evidence and review selection before combining historical supplements with a frozen release");
  const candidates = evidence ? withVerifiedEvidence(productId, originalCandidates, evidence) : originalCandidates;
  if (!isAncestor(receipt.deployedCommit, git("rev-parse", "HEAD"))) {
    throw new Error("The deployed commit is not in this checkout; use the repository that was deployed");
  }
  const repository = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
  const {selection:ledger,...matched}=matchReleaseSelection(receipt,{...snapshot,candidates},selection,`https://github.com/${repository}`,(url)=>pullRequestFacts(url,repository));
  process.stdout.write(`${JSON.stringify({ ...(ledger ? {selection:ledger,receiptDigest:createHash("sha256").update(JSON.stringify(receipt)).digest("hex")} : {}), comments: matched.comments, ...(matched.deliveries ? {deliveries:matched.deliveries} : {}), ...releaseBatches(productId, candidates, matched), ...(evidence ? { verifiedEvidence: evidence } : {}) }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
