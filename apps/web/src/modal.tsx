import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBeforeUnloadGuard } from "./unsaved-changes";
import { X } from "lucide-react";
import { useI18n } from "./i18n";
import { DialogDraftContext, useDialogDraftState } from "./dialog-state";
import { useModalSurface } from "./overlay";

export function Modal({ className = "", fullScreenOnCompact = false, title, subtitle, headerActions, onClose, children, wide = false, scrolls = false, dirty: ownDirty = false, pending: ownPending = false, pendingNotice, closeWarning }: {
  title: string;
  subtitle: string;
  /** Optional secondary reading actions; the close control remains separate. */
  headerActions?: ReactNode;
  onClose: () => void;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
  className?: string;
  fullScreenOnCompact?: boolean;
  closeWarning?: string | undefined;
  dirty?: boolean;
  pending?: boolean;
  /** A caller with its own ongoing-operation message can suppress the save-specific notice. */
  pendingNotice?: string | null;
  wide?: boolean;
  scrolls?: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drafts = useDialogDraftState();
  const [discarding, setDiscarding] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const dirty = ownDirty || drafts.dirty;
  const pending = ownPending || drafts.pending;
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
        <header><div>{subtitle && <p className="eyebrow">{subtitle}</p>}<h2 id={titleId}>{discarding ? t(closeWarning ? "confirmAction" : "discardDialogTitle") : title}</h2></div>{!discarding && headerActions && <div className="modal-header-actions">{headerActions}</div>}<button type="button" className="icon-button" disabled={pending} onClick={() => close.current()} aria-label={t("close")}><X size={20} /></button></header>
        {waiting && pending && pendingNotice !== null && <p role="status" className="account-note">{pendingNotice ?? t("settingsWaitForSave")}</p>}
        {discarding && <div className="discard-dialog">
          <p>{closeWarning ?? t("discardDialogHelp")}</p>
          <div className="form-footer">
            <button type="button" className="secondary-button" data-continue-editing onClick={() => { setDiscarding(false); requestAnimationFrame(() => previousFocus.current?.focus()); }}>{t(closeWarning ? "keepViewing" : "continueEditing")}</button>
            <button type="button" className="danger-button" disabled={pending} onClick={onClose}>{t(closeWarning ? "close" : "discardChanges")}</button>
          </div>
        </div>}
        <div className="modal-content" hidden={discarding}>
          <DialogDraftContext.Provider value={drafts.update}><fieldset className="modal-fields" disabled={pending}>{typeof children==="function" ? children(()=>{close.current();}) : children}</fieldset></DialogDraftContext.Provider>
        </div>
      </section>
    </dialog>
  );
}
