import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";

/**
 * Keeps the last screen on disk so a cold start can paint it immediately instead
 * of waiting on the network.
 *
 * Even after the request chain was collapsed to one, a cold start still had
 * nothing to show until that request came back -- 185-234ms of round trip
 * measured against production, on top of the JS boot. Restoring the previous
 * answer costs a synchronous read of a few hundred kilobytes and puts the list
 * on screen at first paint; the fresh copy replaces it when it arrives.
 *
 * localStorage rather than IndexedDB on purpose. IndexedDB is async, so the
 * first paint would have to wait for it -- reintroducing, in smaller form, the
 * very wait this removes. The synchronous read is a few milliseconds at these
 * sizes, and MAX_BYTES keeps it that way.
 */

const STORAGE_KEY = "missiongo.query-cache";

/**
 * Stamped per build (see vite.config.ts). A deploy can change the shape of what
 * these queries return, and hydrating yesterday's shape into today's components
 * is how a cache like this crashes a screen instead of speeding it up. Losing
 * the cache once per deploy is the cheap side of that trade.
 */
declare const MISSIONGO_BUILD_STAMP: string;

/**
 * Beyond this the cache is dropped rather than written: past a few hundred
 * kilobytes the synchronous read starts to cost more than the round trip it is
 * meant to save, and localStorage quotas are not generous.
 */
const MAX_BYTES = 1_500_000;

/** Older than this and the network is a better answer than the cache. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long to wait for more changes before writing again. */
const WRITE_DELAY_MS = 1_000;

interface StoredCache {
  readonly build: string;
  readonly savedAt: number;
  readonly state: ReturnType<typeof dehydrate>;
}

/**
 * Only the queries that draw the first screen.
 *
 * `attachment-content` is excluded deliberately: it holds Blobs, which do not
 * survive JSON, and they are the largest thing the client ever caches.
 * `bootstrap` is excluded because it is a snapshot of the other three -- keeping
 * it would store everything twice and let the copies disagree.
 */
const PERSISTED_KEYS = new Set(["products", "items", "components"]);

function isPersistable(queryKey: readonly unknown[]): boolean {
  return typeof queryKey[0] === "string" && PERSISTED_KEYS.has(queryKey[0]);
}

/**
 * Drop everything on disk. Called on sign-out, and whenever a restore looks
 * wrong.
 *
 * On sign-out this is not an optimisation: without it the next person to open
 * the app on this device would be shown the previous account's work items,
 * painted from cache before the server ever said whether they may see them.
 */
export function clearPersistedQueryCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser that will not let us clear it will not have let us write it.
  }
}

/** Restore synchronously, before the first render, or do nothing. */
export function restorePersistedQueryCache(client: QueryClient): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  try {
    const stored = JSON.parse(raw) as StoredCache;
    if (stored.build !== MISSIONGO_BUILD_STAMP || Date.now() - stored.savedAt > MAX_AGE_MS) {
      clearPersistedQueryCache();
      return;
    }
    hydrate(client, stored.state);
  } catch {
    // Corrupt or from a shape we no longer understand. Start clean rather than
    // hand a half-parsed cache to the screen.
    clearPersistedQueryCache();
  }
}

/**
 * Write the cache back as it changes. Returns an unsubscribe function.
 *
 * Writes are delayed and coalesced: a list render settles several queries in a
 * row, and serialising on each one would put the cost back on the main thread
 * during exactly the boot this exists to speed up.
 */
export function persistQueryCache(client: QueryClient): () => void {
  let timer: number | undefined;

  const write = () => {
    timer = undefined;
    try {
      const state = dehydrate(client, {
        shouldDehydrateQuery: (query) =>
          query.state.status === "success" && isPersistable(query.queryKey),
      });
      if (state.queries.length === 0) {
        clearPersistedQueryCache();
        return;
      }
      const payload = JSON.stringify({
        build: MISSIONGO_BUILD_STAMP,
        savedAt: Date.now(),
        state,
      } satisfies StoredCache);
      if (payload.length > MAX_BYTES) {
        clearPersistedQueryCache();
        return;
      }
      localStorage.setItem(STORAGE_KEY, payload);
    } catch {
      // Quota, private mode, or a value that would not serialise. The cache is
      // an optimisation; failing to write one must never break the session.
      clearPersistedQueryCache();
    }
  };

  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (timer !== undefined) return;
    timer = window.setTimeout(write, WRITE_DELAY_MS);
  });

  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    unsubscribe();
  };
}
