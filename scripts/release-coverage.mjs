#!/usr/bin/env node
// No MissionGo token is needed: the authenticated MCP client supplies all pages.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { candidateIdentity, readReleaseSelection, releaseCandidatesFromPages } from "./release-candidates.mjs";
import { repositoryIdentity } from "./handover-evidence.mjs";

const SHA = /^[a-f0-9]{40}$/;
export const COVERAGE_ARTIFACTS = ["web", "androidApp", "androidSdk", "macosApp", "linuxCli"];

export function releaseScope(onlyArtifacts, reason) {
  if (onlyArtifacts === undefined) {
    if (reason !== undefined) throw new Error("A scope reason requires --only-artifacts");
    return { mode: "all" };
  }
  const artifacts = onlyArtifacts.split(",").map(value => value.trim());
  if (!artifacts.length || new Set(artifacts).size !== artifacts.length || artifacts.some(value => !COVERAGE_ARTIFACTS.includes(value)) || typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
    throw new Error("Partial releases require valid --only-artifacts and a nonempty --scope-reason recording the user's explicit scope");
  }
  return { mode: "selected", artifacts: artifacts.sort(), reason: reason.trim() };
}

function git(root, ...args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
export function commitContains(root, older, newer) {
  if (!SHA.test(older ?? "") || !SHA.test(newer ?? "")) return false;
  const result = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", older, newer], { stdio: "pipe" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Required Git objects are unavailable; fetch the integration and artifact sources before release");
}

/** Resolve only this repository's integration references, never URLs from another project. */
export function integrationFacts(candidate, repository, root) {
  const completion = candidate.completion ?? (candidate.pullRequestUrl ? { kind: "github", url: candidate.pullRequestUrl } : undefined);
  if (!completion) throw new Error("Integration reference is missing");
  if (["commit", "manual"].includes(completion.kind)) {
    if (!SHA.test(completion.commit ?? "")) throw new Error("Invalid integration commit");
    // Existence alone does not establish integration: the plan checks HEAD ancestry.
    git(root, "cat-file", "-e", `${completion.commit}^{commit}`);
    return { state: "merged", mergeCommit: completion.commit };
  }
  const parsed = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(completion.url ?? "");
  if (completion.kind !== "github" || !parsed || repositoryIdentity(`https://github.com/${parsed[1]}/${parsed[2]}`).toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Integration reference does not belong to this GitHub repository");
  }
  let view;
  try { view = JSON.parse(execFileSync("gh", ["pr", "view", completion.url, "--json", "state,mergedAt,mergeCommit"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })); }
  catch { throw new Error("Cannot verify PR integration; check repository access and retry"); }
  if (["OPEN", "CLOSED"].includes(view.state)) return { state: "unmerged" };
  if (view.state !== "MERGED" || !view.mergedAt || !SHA.test(view.mergeCommit?.oid ?? "")) throw new Error("PR integration evidence is incomplete");
  return { state: "merged", mergeCommit: view.mergeCommit.oid };
}

/** artifacts must come from the existing hash/provenance preflight, or verified public receipt. */
export function planReleaseCoverage(input, { productId, repository, head, artifacts, scope = { mode: "all" }, now = Date.now(), receipt = false, selection }, resolve, ancestor) {
  const snapshot = releaseCandidatesFromPages(input, { coverage: true, now, ...(receipt ? { maxAgeMs: Number.MAX_SAFE_INTEGER } : {}) });
  if (!productId || snapshot.productId !== productId) throw new Error("Candidate product differs from the configured release product");
  if (!SHA.test(head ?? "")) throw new Error("A full planned release commit is required");
  if (!Array.isArray(artifacts)) throw new Error("Validated artifact provenance is required");
  if (scope.mode !== "all" && scope.mode !== "selected") throw new Error("Invalid release scope");
  if (scope.mode === "selected") scope = releaseScope(scope.artifacts?.join(","), scope.reason);
  const ledger=readReleaseSelection(selection,snapshot,repository,head);
  const dispositions=new Map(ledger?.entries.map(e=>[e.identity,e]) ?? []);
  const available = new Map(artifacts.map(artifact => [artifact.artifact, artifact]));
  const facts = new Map();
  const items = [];
  const required = new Set();
  for (const candidate of snapshot.candidates) {
    if (candidate.kind!=="delivery" && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(candidate?.itemKey ?? "")) throw new Error("Invalid candidate item key");
    const row = { ...(candidate.kind==="delivery" ? {kind:"delivery",deliveryId:candidate.deliveryId,title:candidate.title,pullRequestUrl:candidate.pullRequestUrl} : {itemKey:candidate.itemKey,developmentEventId:candidate.developmentEventId,expectedRevision:candidate.expectedRevision,roundKey:candidate.roundKey}), requiredArtifacts: candidate.requiredArtifacts ?? null };
    const disposition=dispositions.get(candidateIdentity(candidate));
    if(disposition && ["historical_gap","deferred"].includes(disposition.disposition)) {
      items.push({...row,status:"excluded",disposition,warning:disposition.disposition==="historical_gap" ? "Historical evidence remains missing; no publication or acceptance is implied" : "User deferred this delivery; merged code may still be in deployed artifacts"});continue;
    }
    let integration;
    try {
      const key = JSON.stringify(candidate.completion ?? candidate.pullRequestUrl ?? candidate.itemKey);
      if (!facts.has(key)) facts.set(key, resolve(candidate));
      integration = facts.get(key);
    } catch (error) { items.push({ ...row, status: "integration_unverified", reason: error.message }); continue; }
    if (integration?.state === "unmerged") { items.push({ ...row, status: "waiting_merge", ...(disposition ? {disposition} : {}) }); continue; }
    if(disposition?.disposition==="unmerged") throw new Error("Excluded unmerged candidate changed; review the release selection again");
    if (integration?.state !== "merged" || !SHA.test(integration.mergeCommit ?? "")) { items.push({ ...row, status: "integration_unverified", reason: "Integration evidence is incomplete" }); continue; }
    row.mergeCommit = integration.mergeCommit;
    if (!Array.isArray(row.requiredArtifacts) || !row.requiredArtifacts.length || new Set(row.requiredArtifacts).size !== row.requiredArtifacts.length || row.requiredArtifacts.some(a => typeof a !== "string" || !/^[a-z][A-Za-z0-9_-]{0,49}$/.test(a))) {
      items.push({ ...row, status: "scope_unknown", reason: "Record the required artifacts or an explicit no-release decision before deploying" }); continue;
    }
    const selected = row.requiredArtifacts.filter(a => scope.mode === "all" || scope.artifacts.includes(a)).sort();
    const excluded = row.requiredArtifacts.filter(a => !selected.includes(a)).sort();
    for (const a of selected) required.add(a);
    const base = { ...row, selectedArtifacts: selected, excludedArtifacts: excluded };
    if (!selected.length) { items.push({ ...base, status: "excluded" }); continue; }
    try {
      if (!ancestor(integration.mergeCommit, head)) { items.push({ ...base, status: "integration_unverified", reason: "Merged work is not in the planned checkout; synchronize origin/main" }); continue; }
      const missing = selected.flatMap(a => {
        const artifact = available.get(a);
        if (!artifact?.version || !SHA.test(artifact.sourceCommit ?? "")) return [{ artifact: a, reason: "verified artifact provenance is missing" }];
        if (!ancestor(integration.mergeCommit, artifact.sourceCommit)) return [{ artifact: a, reason: "artifact source does not contain the integration", version: artifact.version, sourceCommit: artifact.sourceCommit }];
        return [];
      });
      items.push({ ...base, status: missing.length ? "missing_artifacts" : excluded.length ? "partial" : "ready", missing });
    } catch (error) { items.push({ ...base, status: "integration_unverified", reason: error.message }); }
  }
  const blocked = items.filter(item => ["missing_artifacts", "scope_unknown", "integration_unverified"].includes(item.status));
  return { schemaVersion: 1, productId, repository, plannedCommit: head, snapshotAt: snapshot.snapshotAt, scope, ...(ledger ? {selection:ledger} : {}),
    requiredArtifacts: [...required].sort(), items, noReleaseItems: snapshot.noReleaseItems, noReleaseDeliveries:snapshot.noReleaseDeliveries,
    ready: blocked.length === 0, fullCoverage: blocked.length === 0 && items.every(item => ["ready", "waiting_merge"].includes(item.status)) };
}

export function assertReleaseCoverage(plan) {
  if (plan.ready) return;
  const failures = plan.items.filter(item => ["missing_artifacts", "scope_unknown", "integration_unverified"].includes(item.status));
  const details = failures.map(item => `${item.itemKey ?? item.pullRequestUrl ?? item.deliveryId}: ${item.missing?.map(m => `${m.artifact} (${m.reason})`).join(", ") || item.reason}`);
  for (const conflict of plan.scopeConflicts ?? []) details.push(`${conflict.artifact}: deployment would change an artifact outside the user's explicit scope`);
  throw new Error(`Release coverage incomplete: ${details.join("; ")}`);
}

export function coverageForCheckout({ root, config, candidates, artifacts, live, onlyArtifacts, scopeReason, receipt, now, selection }) {
  const repository = repositoryIdentity(git(root, "config", "--get", "remote.origin.url"));
  if (config?.schemaVersion !== 1 || typeof config.productId !== "string" || repository.toLowerCase() !== config.repository?.toLowerCase()) throw new Error("Release coverage configuration must bind this repository to its MissionGo product");
  const head = receipt?.deployedCommit ?? git(root, "rev-parse", "HEAD");
  const scope = releaseScope(onlyArtifacts, scopeReason);
  const plan = planReleaseCoverage(candidates, { productId: config.productId, repository, head, artifacts, scope, selection, ...(now ? { now } : {}), receipt: !!receipt },
    candidate => integrationFacts(candidate, repository, root), (older, newer) => commitContains(root, older, newer));
  if(receipt) plan.receiptDigest=createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  plan.scopeConflicts = [];
  if (scope.mode === "selected") {
    const previous = receipt?.previous ?? live;
    if (!previous) throw new Error("Partial release needs the actual previous artifact snapshot to check scope side effects");
    for (const artifact of artifacts.filter(a => !scope.artifacts.includes(a.artifact))) {
      const old = previous[artifact.artifact];
      const source = artifact.artifact === "web" ? old?.commit : old?.sourceCommit;
      const bytesChanged = ["sha256", "pomSha256", "aarSha256"].some(key => (old?.[key] ?? null) !== (artifact[key] ?? null));
      if (!old || old.version !== artifact.version || (source ?? null) !== (artifact.sourceCommit ?? null) || bytesChanged) {
        plan.scopeConflicts.push({ artifact: artifact.artifact, reason: "outside explicit scope", previousVersion: old?.version ?? null, plannedVersion: artifact.version });
      }
    }
    if (plan.scopeConflicts.length) { plan.ready = false; plan.fullCoverage = false; }
  }
  return plan;
}

// Public receipts provide the complete observed snapshot; missing proof is never filled from a ledger.
export function receiptArtifacts(receipt) {
  return Object.entries(receipt.current ?? {}).flatMap(([artifact, value]) => value && receipt.publicEvidence?.checks?.[artifact] === true
    && (artifact !== "web" || value.clean === true && value.ciPassed === true)
    ? [{ ...value, artifact, sourceCommit: artifact === "web" ? value.commit : value.sourceCommit }] : []);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const receipt = JSON.parse(value("--receipt-json") ?? readFileSync(value("--receipt"), "utf8"));
    if (receipt.schemaVersion !== 1) throw new Error("Invalid public release receipt");
    const options = { root: value("--root") ?? process.cwd(), config: JSON.parse(readFileSync(value("--coverage-config"), "utf8")),
      candidates: JSON.parse(readFileSync(value("--candidates"), "utf8")), selection: value("--selection") ? JSON.parse(readFileSync(value("--selection"),"utf8")) : undefined, artifacts: receiptArtifacts(receipt), receipt };
    const actual = coverageForCheckout(options);
    const selected = value("--only-artifacts") === undefined ? actual : coverageForCheckout({ ...options, onlyArtifacts: value("--only-artifacts"), scopeReason: value("--scope-reason") });
    console.log(JSON.stringify({ ...actual, requestedScope: selected.scope, selectedScopeReady: selected.ready }, null, 2));
    assertReleaseCoverage(selected);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
