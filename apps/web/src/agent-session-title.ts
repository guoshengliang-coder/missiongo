import type { AgentSessionSummary } from "./types";

/** Matches a work-item key of the shape `PREFIX-123`; anything else keeps its full key. */
const KEYED_ITEM_KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;

/**
 * The item keys of a dispatch session's title (AND-179).
 *
 * A multi-item dispatch prefixes every key with the product key ("AND-169、AND-168、…"),
 * which fills the session list row long before the item title fits and ends up
 * ellipsized. Write the prefix once per run instead: the first key of each prefix
 * keeps it, the ones that follow show only their number ("AND-169、168、…"). When the
 * prefix changes -- a dispatch can span products -- the new prefix is spelled out
 * again, and keys that are not `PREFIX-123`-shaped stay in full, so every number can
 * still be traced back to a key written out in full right before it.
 */
export function compactItemKeys(keys: readonly string[]): string {
  let currentPrefix: string | undefined;
  return keys
    .map((key) => {
      const match = key.match(KEYED_ITEM_KEY);
      if (!match) return key;
      if (match[1] !== currentPrefix) {
        currentPrefix = match[1];
        return key;
      }
      return match[2];
    })
    .join("、");
}

/** The session list row and conversation heading: compact keys, then the first item's title. */
export function sessionTitle(session: Pick<AgentSessionSummary, "items" | "sessionName" | "id">): string {
  const keys = compactItemKeys(session.items.map((item) => item.key));
  const firstTitle = session.items[0]?.title;
  return firstTitle ? `${keys} · ${firstTitle}` : session.sessionName ?? session.id;
}
