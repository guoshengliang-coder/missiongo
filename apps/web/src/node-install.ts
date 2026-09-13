import type { DispatchNode } from "./types";

/**
 * Served by this same deployment: nginx in production, vite.config.ts in dev
 * and preview. A fixed "latest" name, so the console never has to know which
 * build is published.
 */
export const MACOS_CLIENT_DOWNLOAD_PATH = "/downloads/missiongo-macos-latest.zip";

/**
 * How long the panel keeps watching for a Mac after the download was clicked.
 * Unzipping, getting past Gatekeeper and signing in take a few minutes; past a
 * quarter of an hour the person has most likely walked away, and the fast poll
 * would only be load.
 */
export const NODE_WAIT_GIVE_UP_MS = 15 * 60_000;

/**
 * What the panel remembers from the moment the download was clicked.
 *
 * `baseline` holds the machines that were already usable then. A revoked
 * machine is left out on purpose: signing in again from the same Mac restores
 * that record instead of creating a new one, so it has to count as arriving
 * when it comes back.
 */
export interface PendingArrival {
  readonly baseline: readonly string[];
  readonly startedAt: number;
}

export function arrivalBaseline(nodes: readonly DispatchNode[]): string[] {
  return nodes.filter((node) => !node.revokedAt).map((node) => node.id);
}

/**
 * What the panel knows about the Mac somebody is connecting, judged only by the
 * node list.
 *
 * - `waiting`: no machine has turned up since the download was clicked.
 * - `signedIn`: a new machine is listed but has not heartbeated yet -- sign-in
 *   worked and the client is still starting up.
 * - `online`: a new machine is heartbeating; the guide has done its job.
 * - `gaveUp`: nothing came online within the wait, so the fast poll stops.
 *
 * "New" means absent from the baseline. Matching on the name instead would call
 * an old machine of the same name a success, and matching on "any online
 * machine" would do the same for every machine that was already running.
 */
export type ArrivalProgress =
  | { readonly state: "waiting" }
  | { readonly state: "signedIn"; readonly node: DispatchNode }
  | { readonly state: "online"; readonly node: DispatchNode }
  | { readonly state: "gaveUp" };

export function arrivalProgress(
  arrival: PendingArrival,
  nodes: readonly DispatchNode[],
  now: number,
): ArrivalProgress {
  const before = new Set(arrival.baseline);
  const arrived = nodes.filter((node) => !before.has(node.id) && !node.revokedAt);
  // Checked before the give-up: the usual poll still runs after it, and a Mac
  // that makes it online late deserves the same confirmation.
  const online = arrived.find((node) => node.online);
  if (online) return { state: "online", node: online };
  if (now - arrival.startedAt >= NODE_WAIT_GIVE_UP_MS) return { state: "gaveUp" };
  const signedIn = arrived[0];
  return signedIn ? { state: "signedIn", node: signedIn } : { state: "waiting" };
}

/** The panel's usual poll, and the one used while somebody is watching a machine come up. */
export const NODE_LIST_REFETCH_MS = 30_000;
export const NODE_LIST_WAITING_REFETCH_MS = 5_000;

/**
 * Fast only while a machine is expected. A machine heartbeats as soon as the
 * client signs in, so the usual poll could add up to 30 seconds to a screen
 * somebody is staring at; outside that window the fast poll is pure load.
 */
export function nodeListRefetchInterval(progress: ArrivalProgress | undefined): number {
  return progress?.state === "waiting" || progress?.state === "signedIn"
    ? NODE_LIST_WAITING_REFETCH_MS
    : NODE_LIST_REFETCH_MS;
}
