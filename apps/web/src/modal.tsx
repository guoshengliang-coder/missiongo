import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBeforeUnloadGuard } from "./unsaved-changes";
import { X } from "lucide-react";
import { useI18n } from "./i18n";
import { DialogDraftContext, type DialogDraft } from "./dialog-state";
import { useModalSurface } from "./overlay";

export function Modal({ className = "", fullScreenOnCompact = false, title, subtitle, onClose, children, wide = false, scrolls = false, dirty: ownDirty = false, pending: ownPending = false, closeWarning }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
  className?: string;
  fullScreenOnCompact?: boolean;
  closeWarning?: string | undefined;
  dirty?: boolean;
  pending?: boolean;
  wide?: boolean;
  scrolls?: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [drafts, setDrafts] = useState<Record<string, DialogDraft>>({});
  const [discarding, setDiscarding] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const update = useCallback((id: string, draft?: DialogDraft) => setDrafts(previous => {
    if (!draft && !previous[id]) return previous;
    if (draft && previous[id]?.dirty === draft.dirty && previous[id]?.pending === draft.pending) return previous;
    const next = { ...previous }; if (draft) next[id] = draft; else delete next[id]; return next;
  }), []);
  const dirty = ownDirty || Object.values(drafts).some(draft => draft.dirty);
  const pending = ownPending || Object.values(drafts).some(draft => draft.pending);
  useBeforeUnloadGuard(dirty || pending || Boolean(closeWarning));
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = useRef<() => boolean>(() => false);
  close.current = () => {
    if (pending) { setWaiting(true); return false; }
    if (dirty || closeWarning) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      setDiscarding(true);
      return false;
    }
    onClose(); return true;
  };
  useModalSurface(dialogRef, () => close.current());
  useEffect(() => {
    if (discarding) dialogRef.current?.querySelector<HTMLElement>("[data-continue-editing]")?.focus();
  }, [discarding]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const fit = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const height = viewport?.height ?? window.innerHeight;
      dialog.style.height = `${height}px`;
      dialog.style.top = `${viewport?.offsetTop ?? 0}px`;
      const panel = dialog.querySelector<HTMLElement>(".modal");
      if (panel) panel.style.maxHeight = `${Math.max(120, height - (fullScreenOnCompact && window.innerWidth<=1023 ? 0 : 36))}px`;
      requestAnimationFrame(() => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea, [role=combobox]")) document.activeElement.scrollIntoView({ block: "nearest" });
      });
    };
    fit(); viewport?.addEventListener("resize", fit);
    return () => viewport?.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>("[data-initial-focus], input:not([type=hidden]), textarea, [role=combobox], button")?.focus();
  }, [title]);
  return (
    <dialog ref={dialogRef} className={`modal-layer ${className}`} aria-labelledby={titleId} aria-busy={pending}
      onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}>
      <section className={`modal ${wide ? "wide" : ""} ${scrolls ? "scrolls" : ""}`}>
        <header><div><p className="eyebrow">{subtitle}</p><h2 id={titleId}>{discarding ? t(closeWarning ? "confirmAction" : "discardDialogTitle") : title}</h2></div><button type="button" className="icon-button" disabled={pending} onClick={() => close.current()} aria-label={t("close")}><X size={20} /></button></header>
        {waiting && pending && <p role="status" className="account-note">{t("settingsWaitForSave")}</p>}
        {discarding && <div className="discard-dialog">
          <p>{closeWarning ?? t("discardDialogHelp")}</p>
          <div className="form-footer">
            <button type="button" className="secondary-button" data-continue-editing onClick={() => { setDiscarding(false); requestAnimationFrame(() => previousFocus.current?.focus()); }}>{t(closeWarning ? "keepViewing" : "continueEditing")}</button>
            <button type="button" className="danger-button" disabled={pending} onClick={onClose}>{t(closeWarning ? "close" : "discardChanges")}</button>
          </div>
        </div>}
        <div className="modal-content" hidden={discarding}>
          <DialogDraftContext.Provider value={update}><fieldset className="modal-fields" disabled={pending}>{typeof children==="function" ? children(()=>{close.current();}) : children}</fieldset></DialogDraftContext.Provider>
        </div>
      </section>
    </dialog>
  );
}
