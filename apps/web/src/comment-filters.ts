import { useCallback, useState } from "react";

export const COMMENT_CATEGORIES = ["human", "agent", "activity"] as const;
export type CommentCategory = typeof COMMENT_CATEGORIES[number];
export const commentFilterKey = (accountId: string) => `missiongo.comment-filters.v1:${encodeURIComponent(accountId)}`;

export function parseCommentFilters(raw: string | null): readonly CommentCategory[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(value) && value.every(category => COMMENT_CATEGORIES.includes(category))) {
      return COMMENT_CATEGORIES.filter(category => value.includes(category));
    }
  } catch { /* Invalid local preferences fall back to the complete view. */ }
  return COMMENT_CATEGORIES;
}

function read(accountId: string): readonly CommentCategory[] {
  try { return parseCommentFilters(localStorage.getItem(commentFilterKey(accountId))); }
  catch { return COMMENT_CATEGORIES; }
}

/** A display preference only: never passed to timeline APIs or MCP. */
export function useCommentFilters(accountId: string) {
  const [state, setState] = useState(() => ({ accountId, categories: read(accountId), failed: false }));
  const current = state.accountId === accountId ? state : { accountId, categories: read(accountId), failed: false };
  if (state.accountId !== accountId) setState(current);
  const update = useCallback((categories: readonly CommentCategory[]) => {
    let failed = false;
    try { localStorage.setItem(commentFilterKey(accountId), JSON.stringify(categories)); }
    catch { failed = true; }
    setState({ accountId, categories, failed });
  }, [accountId]);
  return { categories: current.categories, update, storageFailed: current.failed };
}
