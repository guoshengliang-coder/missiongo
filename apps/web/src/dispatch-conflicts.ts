import type { MessageKey } from "./i18n";
import type { ActiveDispatch } from "./types";

/**
 * An item stays ready until a session claims it, and in plan mode that is only
 * after a person approves the plan -- possibly hours after the dispatch. In that
 * window the item still looks dispatchable, and sending it again starts a second
 * session on the same work. The checkbox is left alone on purpose: the earlier
 * session may be gone (the Mac was shut, the session closed), and re-dispatching
 * is then exactly the right thing. So the list marks the row and the dialog asks.
 */

/**
 * Shared by the list and the dialog so they read one cache: a dispatch that
 * succeeds invalidates it once and both catch up.
 */
export const ACTIVE_DISPATCHES_QUERY_KEY = ["dispatches", "active"] as const;

/**
 * Nothing pushes dispatch progress to the console. Often enough that a Mac
 * picking the work up shows within a minute, rarely enough to be free.
 */
export const ACTIVE_DISPATCHES_REFETCH_MS = 30_000;

/**
 * One entry per item. The server already sends one, but should it ever send
 * two, the newer one is the session that could still claim the item.
 */
export function activeDispatchesByItem(active: readonly ActiveDispatch[]): ReadonlyMap<string, ActiveDispatch> {
  const byItem = new Map<string, ActiveDispatch>();
  for (const entry of active) {
    const current = byItem.get(entry.itemKey);
    if (!current || Date.parse(entry.createdAt) > Date.parse(current.createdAt)) byItem.set(entry.itemKey, entry);
  }
  return byItem;
}

/** The selected items that were already dispatched and not claimed, in the order they were selected. */
export function dispatchConflicts(
  itemKeys: readonly string[],
  byItem: ReadonlyMap<string, ActiveDispatch>,
): ActiveDispatch[] {
  return [...new Set(itemKeys)].flatMap((key) => {
    const entry = byItem.get(key);
    return entry ? [entry] : [];
  });
}

/**
 * What the person ticked "re-dispatch anyway" about. When a refetch turns up a
 * different set -- another item, or a newer dispatch of the same one -- the tick
 * was about something else and has to be given again.
 */
export function conflictSignature(conflicts: readonly ActiveDispatch[]): string {
  return conflicts.map((entry) => `${entry.itemKey}:${entry.dispatchId}`).join(" ");
}

/**
 * Only a dispatch its machine has not picked up can be withdrawn; the server
 * cancels those when re-dispatching, and the dialog says so.
 */
export function includesQueued(conflicts: readonly ActiveDispatch[]): boolean {
  return conflicts.some((entry) => entry.status === "queued");
}

/**
 * Short wording for the three active states. Not `dispatchStatusLabelKey`: that
 * one says 「机器已领取」 for delivered, and next to "the item has not been
 * claimed yet" two different kinds of 领取 in one sentence read as a contradiction.
 * Takes a string so a status this build does not know is shown as itself.
 */
export function activeDispatchStatusKey(status: string): MessageKey | null {
  if (status === "queued") return "activeDispatchQueued";
  if (status === "delivered") return "activeDispatchDelivered";
  if (status === "launched") return "activeDispatchLaunched";
  return null;
}
