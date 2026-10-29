import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBeforeUnloadGuard } from "./unsaved-changes";
import { X } from "lucide-react";
import { useI18n } from "./i18n";
import { DialogDraftContext, type DialogDraft } from "./dialog-state";
import { reportAndroidBackDepth } from "./android-bridge";
import { backDepthFromState, DIALOG_HISTORY_MARKER } from "./navigation";

export function Modal({ title, subtitle, onClose, children, wide = false, scrolls = false, historyManaged = false, dirty: ownDirty = false, pending: ownPending = false, closeWarning }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  closeWarning?: string | undefined;
  dirty?: boolean;
  pending?: boolean;
  wide?: boolean;
  scrolls?: boolean;
  /** The capture sheet already owns a history entry. Other dialogs own theirs here. */
  historyManaged?: boolean;
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
  const returnFocus = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  const lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    const dialog = dialogRef.current;
    const originalFocus = returnFocus.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-initial-focus], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)")?.focus();
    const state = typeof history.state === "object" && history.state ? history.state : {};
    const ids: string[] = state[DIALOG_HISTORY_MARKER] ?? [];
    const ownState = historyManaged || ids.includes(titleId) ? state : { ...state, [DIALOG_HISTORY_MARKER]: [...ids, titleId] };
    const url = window.location.href;
    if (!historyManaged && !ids.includes(titleId)) history.pushState(ownState, "", url);
    reportAndroidBackDepth(backDepthFromState(history.state));
    const back = (event: PopStateEvent) => {
      const leftEntry = historyManaged
        ? backDepthFromState(history.state) < backDepthFromState(ownState)
        : !history.state?.[DIALOG_HISTORY_MARKER]?.includes(titleId);
      if (!leftEntry) return;
      // Native editors such as image annotation share this entry with their
      // parent. Back dismisses that top editor before touching the form below.
      const focused = document.activeElement?.closest("dialog");
      const top = focused ?? Array.from(document.querySelectorAll("dialog[open]")).at(-1);
      if (top && top !== dialog && !top.classList.contains("modal-layer")) {
        event.stopImmediatePropagation();
        history.pushState(ownState, "", url);
        top.dispatchEvent(new Event("cancel", { cancelable: true }));
        reportAndroidBackDepth(backDepthFromState(history.state));
        return;
      }
      if (historyManaged) return;
      if (!close.current()) {
        event.stopImmediatePropagation();
        history.pushState(ownState, "", url);
      }
      reportAndroidBackDepth(backDepthFromState(history.state));
    };
    window.addEventListener("popstate", back, true);
    return () => {
      window.removeEventListener("popstate", back, true);
      dialog?.close();
      // StrictMode replays effects. Let the replay reuse the entry instead of
      // racing an asynchronous history.back() with the second mount.
      queueMicrotask(() => {
        if (lifecycle.current !== generation) return;
        if (!historyManaged && history.state?.[DIALOG_HISTORY_MARKER]?.at(-1) === titleId) {
          // A form can apply URL-based filters before it closes. Carry that
          // accepted URL to the parent entry before route listeners read it.
          const acceptedUrl = window.location.href;
          if (acceptedUrl !== url) window.addEventListener("popstate", () => {
            if (window.location.href === url) history.replaceState(history.state, "", acceptedUrl);
          }, { capture: true, once: true });
          history.back();
        }
        originalFocus?.focus();
      });
    };
  }, [historyManaged, titleId]);
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
      if (panel) panel.style.maxHeight = `${Math.max(120, height - 36)}px`;
      requestAnimationFrame(() => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea, select")) document.activeElement.scrollIntoView({ block: "nearest" });
      });
    };
    fit(); viewport?.addEventListener("resize", fit);
    return () => viewport?.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>("[data-initial-focus], input:not([type=hidden]), textarea, select, button")?.focus();
  }, [title]);
  return (
    <dialog ref={dialogRef} className="modal-layer" aria-labelledby={titleId} aria-busy={pending}
      onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); close.current(); }}
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
          <DialogDraftContext.Provider value={update}><fieldset className="modal-fields" disabled={pending}>{children}</fieldset></DialogDraftContext.Provider>
        </div>
      </section>
    </dialog>
  );
}
