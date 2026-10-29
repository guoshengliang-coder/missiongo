import { createContext, useCallback, useContext, useLayoutEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { DialogDraftContext, useDialogDraft } from "./dialog-state";
import { Modal } from "./modal";
import { useI18n } from "./i18n";
import { useUnsavedChangesGuard } from "./unsaved-changes";

export type SettingsLeaveGuard = (proceed?: () => void) => boolean;

type Draft = { dirty: boolean; pending: boolean };
const Drafts = createContext<((id: string, value?: Draft) => void) | null>(null);
export function useSettingsDraft(dirty: boolean, pending = false) {
  useDialogDraft(dirty, pending);
  const dialog = useContext(DialogDraftContext);
  const id = useId(); const update = useContext(Drafts);
  useLayoutEffect(() => { update?.(id, { dirty: !dialog && dirty, pending: !dialog && pending }); return () => update?.(id); }, [id, update, dirty, pending, dialog]);
}
export function SettingsDraftProvider({ guard, children }: { guard: RefObject<SettingsLeaveGuard>; children: ReactNode }) {
  const { t } = useI18n();
  const proceedRef = useRef<(() => void) | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const update = useCallback((id: string, value?: Draft) => setDrafts(previous => {
    if (value && previous[id]?.dirty === value.dirty && previous[id]?.pending === value.pending) return previous;
    if (!value && !previous[id]) return previous;
    const next = { ...previous }; if (value) next[id] = value; else delete next[id]; return next;
  }), []);
  const dirty = Object.values(drafts).some(value => value.dirty);
  const pending = Object.values(drafts).some(value => value.pending);
  useUnsavedChangesGuard(dirty || pending);
  const confirm = useMemo<SettingsLeaveGuard>(() => proceed => {
    if (pending) { setWaiting(true); return false; }
    if (!dirty) return true;
    proceedRef.current = proceed;
    setConfirming(true);
    return false;
  }, [dirty, pending]);
  useLayoutEffect(() => { guard.current = confirm; return () => { guard.current = () => true; }; }, [guard, confirm]);
  return <Drafts.Provider value={update}>{children}
    {confirming && <Modal historyManaged title={t("discardDialogTitle")} subtitle="" onClose={() => setConfirming(false)}>
      <p>{t("discardDialogHelp")}</p>
      <div className="form-footer"><button type="button" data-initial-focus className="secondary-button" onClick={() => setConfirming(false)}>{t("continueEditing")}</button><button type="button" className="danger-button" onClick={() => { setConfirming(false); proceedRef.current?.(); }}>{t("discardChanges")}</button></div>
    </Modal>}
    {waiting && <Modal historyManaged title={t("settingsWaitForSave")} subtitle="" onClose={() => setWaiting(false)}><div className="form-footer"><button type="button" className="primary-button" onClick={() => setWaiting(false)}>{t("close")}</button></div></Modal>}
  </Drafts.Provider>;
}
