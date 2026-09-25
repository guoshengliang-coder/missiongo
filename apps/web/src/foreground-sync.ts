import type { QueryKey } from "@tanstack/react-query";

/**
 * How long a page may sit hidden before coming back is worth a background
 * re-read. Below this the data left on screen is still what the server would
 * return, and a needless request would only add noise (AND-192).
 */
export const FOREGROUND_SYNC_STALE_MS = 60_000;

export interface ForegroundSyncCandidate {
  readonly queryKey: QueryKey;
  readonly active: boolean;
  readonly updatedAt: number;
}

/**
 * The queries a return to the foreground should quietly re-read.
 *
 * Only active queries -- those a mounted view is still showing -- and only ones
 * whose data is past `staleMs`. A query that never fetched (`updatedAt` 0) is
 * skipped: it is already fetching on mount. A response that compares equal
 * re-renders nothing, so an unchanged console looks untouched: the refresh is
 * invisible unless something actually moved (AND-192).
 */
export function foregroundSyncTargets(
  candidates: readonly ForegroundSyncCandidate[],
  now: number,
  staleMs = FOREGROUND_SYNC_STALE_MS,
): QueryKey[] {
  return candidates
    .filter((candidate) => candidate.active && candidate.updatedAt > 0 && now - candidate.updatedAt >= staleMs)
    .map((candidate) => candidate.queryKey);
}