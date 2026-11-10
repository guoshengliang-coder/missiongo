import { createContext, useContext, useLayoutEffect, useId, useCallback, useState } from "react";

export type DialogDraft = { dirty: boolean; pending: boolean };
export const DialogDraftContext = createContext<((id: string, draft?: DialogDraft) => void) | null>(null);

/** Shared registration for modal forms and an embedded detail's navigation boundary. */
export function useDialogDraftState() {
  const [drafts, setDrafts] = useState<Record<string, DialogDraft>>({});
  const update = useCallback((id: string, draft?: DialogDraft) => setDrafts(previous => {
    if (!draft && !previous[id]) return previous;
    if (draft && previous[id]?.dirty === draft.dirty && previous[id]?.pending === draft.pending) return previous;
    const next = { ...previous }; if (draft) next[id] = draft; else delete next[id]; return next;
  }), []);
  return { update, dirty: Object.values(drafts).some(draft => draft.dirty), pending: Object.values(drafts).some(draft => draft.pending) };
}

/** Register only edits owned by this dialog. Nested dialogs have their own provider. */
export function useDialogDraft(dirty: boolean, pending = false) {
  const id = useId();
  const update = useContext(DialogDraftContext);
  useLayoutEffect(() => {
    update?.(id, { dirty, pending });
    return () => update?.(id);
  }, [id, update, dirty, pending]);
}
