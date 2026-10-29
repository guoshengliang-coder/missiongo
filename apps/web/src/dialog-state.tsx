import { createContext, useContext, useLayoutEffect, useId } from "react";

export type DialogDraft = { dirty: boolean; pending: boolean };
export const DialogDraftContext = createContext<((id: string, draft?: DialogDraft) => void) | null>(null);

/** Register only edits owned by this dialog. Nested dialogs have their own provider. */
export function useDialogDraft(dirty: boolean, pending = false) {
  const id = useId();
  const update = useContext(DialogDraftContext);
  useLayoutEffect(() => {
    update?.(id, { dirty, pending });
    return () => update?.(id);
  }, [id, update, dirty, pending]);
}
