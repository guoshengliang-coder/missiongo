import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "./i18n";
import { useUnsavedChangesGuard } from "./unsaved-changes";

type Draft = { dirty: boolean; pending: boolean };
const Drafts = createContext<((id: string, value?: Draft) => void) | null>(null);
export function useSettingsDraft(dirty: boolean, pending = false) {
  const id = useId(); const update = useContext(Drafts);
  useEffect(() => { update?.(id, { dirty, pending }); return () => update?.(id); }, [id, update, dirty, pending]);
}
export function SettingsDraftProvider({ guard, children }: { guard: RefObject<() => boolean>; children: ReactNode }) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const update = useCallback((id: string, value?: Draft) => setDrafts(previous => {
    if (value && previous[id]?.dirty === value.dirty && previous[id]?.pending === value.pending) return previous;
    if (!value && !previous[id]) return previous;
    const next = { ...previous }; if (value) next[id] = value; else delete next[id]; return next;
  }), []);
  const dirty = Object.values(drafts).some(value => value.dirty);
  const pending = Object.values(drafts).some(value => value.pending);
  useUnsavedChangesGuard(dirty || pending);
  const confirm = useMemo(() => () => {
    if (pending) { window.alert(t("settingsWaitForSave")); return false; }
    return !dirty || window.confirm(t("settingsDiscardChanges"));
  }, [dirty, pending, t]);
  useEffect(() => { guard.current = confirm; return () => { guard.current = () => true; }; }, [guard, confirm]);
  return <Drafts.Provider value={update}>{children}</Drafts.Provider>;
}
