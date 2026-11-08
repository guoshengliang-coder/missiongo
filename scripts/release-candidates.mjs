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
