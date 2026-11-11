import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function candidateIdentity(candidate) {
  if (candidate?.kind === "delivery") {
    if (!/^[a-f0-9-]{36}$/.test(candidate.deliveryId ?? "") || !/^[a-f0-9]{64}$/.test(candidate.expectedRevision ?? "")) throw new Error("Invalid standalone delivery identity");
    return `delivery:${candidate.deliveryId}`;
  }
  if (candidate?.kind !== undefined && candidate.kind !== "item") throw new Error("Unknown release candidate kind");
  return `${candidate?.itemKey}:${candidate?.developmentEventId ?? "legacy"}`;
}
/** Shared pagination contract for planning and post-release reconciliation. */
export function releaseCandidatesFromPages(input, { coverage = false, now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  if (!Array.isArray(input?.pages) || input.pages.length === 0) throw new Error("Release candidates need every list_release_candidates page");
  let productId;
  let expectedCursor = null;
  let snapshotAt = now;
  const candidates = [];
  const noReleaseItems = [];
  const noReleaseDeliveries = [];
  const seen = new Set();
  for (const [index, page] of input.pages.entries()) {
    if (!page || page.requestedBeforeSequence !== expectedCursor || typeof page.productId !== "string" || !page.productId || !Array.isArray(page.candidates)) {
      throw new Error("Release candidate pages have a missing or incorrect cursor");
    }
    productId ??= page.productId;
    if (page.productId !== productId) throw new Error("Release candidate pages span products");
    if (coverage) {
      if (![1,2].includes(page.coverageVersion) || !Array.isArray(page.noReleaseItems) || page.coverageVersion===2 && !Array.isArray(page.noReleaseDeliveries)) {
        throw new Error("Full release coverage needs list_release_candidates(includeUnscoped: true); upgrade the server if unsupported");
      }
      const generatedAt = Date.parse(page.generatedAt);
      if (!Number.isFinite(generatedAt) || generatedAt > now + 60_000 || now - generatedAt > maxAgeMs) {
        throw new Error("Release candidate snapshot is stale or invalid; refresh every page before deployment");
      }
      snapshotAt = Math.min(snapshotAt, generatedAt);
    }
    for (const candidate of page.candidates) {
      const identity=candidateIdentity(candidate);
      if(candidate?.kind==="delivery" && page.coverageVersion!==2) throw new Error("Standalone deliveries require coverageVersion=2");
      if (seen.has(identity)) throw new Error("Release candidate pages repeat an item");
      seen.add(identity); candidates.push(candidate);
    }
    if (coverage) for (const item of page.noReleaseItems) {
      if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(item?.itemKey ?? "") || typeof item.noReleaseReason !== "string" || !item.noReleaseReason.trim() || seen.has(`no-release:${item.itemKey}`)) {
        throw new Error("Invalid explicit no-release exclusion");
      }
      seen.add(`no-release:${item.itemKey}`); noReleaseItems.push(item);
    }
    if(coverage) for(const delivery of page.noReleaseDeliveries ?? []) {
      if(!/^[a-f0-9-]{36}$/.test(delivery?.deliveryId ?? "") || typeof delivery.noReleaseReason!=="string" || !delivery.noReleaseReason.trim()
        || seen.has(`delivery:${delivery.deliveryId}`)) throw new Error("Invalid standalone no-release exclusion");
      seen.add(`delivery:${delivery.deliveryId}`);noReleaseDeliveries.push(delivery);
    }
    const next = page.nextBeforeSequence ?? null;
    if (next !== null && (!Number.isSafeInteger(next) || next <= 0 || expectedCursor !== null && next >= expectedCursor)) throw new Error("Release candidate cursor is invalid");
    if (next === null && index !== input.pages.length - 1) throw new Error("Release candidate pages continue after the final page");
    expectedCursor = next;
  }
  if (expectedCursor !== null) throw new Error("Release candidate scan stopped before the final page");
  return { productId, candidates, ...(coverage ? { noReleaseItems, noReleaseDeliveries, snapshotAt: new Date(snapshotAt).toISOString() } : {}) };
}

// A separate, complete disposition ledger. Never edit the authenticated pages.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function releaseSelectionDigest(snapshot) {
  return digest({ productId:snapshot.productId,
    candidates:[...snapshot.candidates].sort((a,b)=>candidateIdentity(a).localeCompare(candidateIdentity(b))),
    noReleaseItems:[...snapshot.noReleaseItems].sort((a,b)=>a.itemKey.localeCompare(b.itemKey)),
    noReleaseDeliveries:[...snapshot.noReleaseDeliveries].sort((a,b)=>a.deliveryId.localeCompare(b.deliveryId)) });
}
export function createReleaseSelection(snapshot, repository, head) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("Selection requires an exact repository and planned commit");
  return {schemaVersion:1,productId:snapshot.productId,repository,plannedCommit:head,candidatesDigest:releaseSelectionDigest(snapshot),
    entries:snapshot.candidates.map(candidate=>({identity:candidateIdentity(candidate),disposition:"include",reason:"Default: include verified integrated work"}))};
}
export function readReleaseSelection(selection, snapshot, repository, head, expectedDigest) {
  if (selection === undefined) {
    if(expectedDigest !== undefined) throw new Error("A selection digest requires its selection file");
    return undefined;
  }
  if(!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid release selection object; explicit selection must not fall back to a full release");
  const actualDigest=digest(selection);
  if(expectedDigest !== undefined && (!/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest)) throw new Error("Release selection digest changed; re-plan and review the current dispositions");
  const expected=createReleaseSelection(snapshot,repository,head);
  if (Object.keys(selection).some(key=>!["schemaVersion","productId","repository","plannedCommit","candidatesDigest","entries"].includes(key)) || selection.schemaVersion!==1 || selection.productId!==expected.productId || selection.repository!==repository
    || selection.plannedCommit!==head || selection.candidatesDigest!==expected.candidatesDigest || !Array.isArray(selection.entries)
    || selection.entries.length!==snapshot.candidates.length) throw new Error("Release selection changed: refresh the complete candidates and review every disposition again");
  const entries=new Map(), candidates=new Map(snapshot.candidates.map(c=>[candidateIdentity(c),c]));
  for (const entry of selection.entries) {
    const candidate=candidates.get(entry?.identity);
    if(!candidate || entries.has(entry.identity) || !["include","unmerged","historical_gap","deferred"].includes(entry.disposition)
      || typeof entry.reason!=="string" || !entry.reason.trim() || entry.reason.length>4000
      || Object.keys(entry).some(key=>!["identity","disposition","reason","authorization"].includes(key))) throw new Error("Invalid or incomplete release disposition");
    if(entry.disposition==="deferred" && (typeof entry.authorization!=="string" || !entry.authorization.trim() || entry.authorization.length>4000)) throw new Error("Deferring integrated work requires the explicit user instruction");
    const missingReference=!candidate.completion && !candidate.pullRequestUrl;
    const missingScope=candidate.requiredArtifacts===undefined || candidate.requiredArtifacts===null;
    if(entry.disposition==="historical_gap" && !missingReference && !missingScope) throw new Error("Known integrated work cannot be excluded as a historical gap");
    entries.set(entry.identity,entry);
  }
  return { ...expected, entries:[...entries.values()].sort((a,b)=>a.identity.localeCompare(b.identity)), digest:actualDigest };
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  try {
    const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
    if(!args.includes("--create-selection") || !["--candidates","--repository","--head","--output"].every(flag=>args.includes(flag))) throw new Error("Use --create-selection --candidates <full pages> --repository <GitHub repository> --head <SHA> --output <new file>");
    const snapshot=releaseCandidatesFromPages(JSON.parse(readFileSync(value("--candidates"),"utf8")),{coverage:true});
    writeFileSync(value("--output"),JSON.stringify(createReleaseSelection(snapshot,value("--repository"),value("--head")),null,2)+"\n",{flag:"wx",mode:0o600});
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
