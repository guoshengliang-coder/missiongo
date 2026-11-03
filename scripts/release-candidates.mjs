/** Shared pagination contract for planning and post-release reconciliation. */
export function releaseCandidatesFromPages(input, { coverage = false, now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  if (!Array.isArray(input?.pages) || input.pages.length === 0) throw new Error("Release candidates need every list_release_candidates page");
  let productId;
  let expectedCursor = null;
  let snapshotAt = now;
  const candidates = [];
  const noReleaseItems = [];
  const seen = new Set();
  for (const [index, page] of input.pages.entries()) {
    if (!page || page.requestedBeforeSequence !== expectedCursor || typeof page.productId !== "string" || !page.productId || !Array.isArray(page.candidates)) {
      throw new Error("Release candidate pages have a missing or incorrect cursor");
    }
    productId ??= page.productId;
    if (page.productId !== productId) throw new Error("Release candidate pages span products");
    if (coverage) {
      if (page.coverageVersion !== 1 || !Array.isArray(page.noReleaseItems)) {
        throw new Error("Full release coverage needs list_release_candidates(includeUnscoped: true); upgrade the server if unsupported");
      }
      const generatedAt = Date.parse(page.generatedAt);
      if (!Number.isFinite(generatedAt) || generatedAt > now + 60_000 || now - generatedAt > maxAgeMs) {
        throw new Error("Release candidate snapshot is stale or invalid; refresh every page before deployment");
      }
      snapshotAt = Math.min(snapshotAt, generatedAt);
    }
    for (const candidate of page.candidates) {
      if (seen.has(candidate?.itemKey)) throw new Error("Release candidate pages repeat an item");
      seen.add(candidate?.itemKey); candidates.push(candidate);
    }
    if (coverage) for (const item of page.noReleaseItems) {
      if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(item?.itemKey ?? "") || typeof item.noReleaseReason !== "string" || !item.noReleaseReason.trim() || seen.has(item.itemKey)) {
        throw new Error("Invalid explicit no-release exclusion");
      }
      seen.add(item.itemKey); noReleaseItems.push(item);
    }
    const next = page.nextBeforeSequence ?? null;
    if (next !== null && (!Number.isSafeInteger(next) || next <= 0 || expectedCursor !== null && next >= expectedCursor)) throw new Error("Release candidate cursor is invalid");
    if (next === null && index !== input.pages.length - 1) throw new Error("Release candidate pages continue after the final page");
    expectedCursor = next;
  }
  if (expectedCursor !== null) throw new Error("Release candidate scan stopped before the final page");
  return { productId, candidates, ...(coverage ? { noReleaseItems, snapshotAt: new Date(snapshotAt).toISOString() } : {}) };
}
