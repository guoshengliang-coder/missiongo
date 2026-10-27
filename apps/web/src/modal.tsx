import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "./i18n";

export function Modal({ title, subtitle, onClose, children, wide = false, scrolls = false }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Wide modals leave scrolling to their content; set when the content has no scroller of its own. */
  scrolls?: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    // showModal() runs the dialog focusing steps synchronously, after React has
    // already honoured autoFocus, so it lands on the dialog itself and the
    // caret never reaches the field. Claim it back in the same tick: deferring
    // to a frame would leave the modal unfocused in a background tab.
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="modal-layer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={`modal ${wide ? "wide" : ""} ${scrolls ? "scrolls" : ""}`}>
        <header><div><p className="eyebrow">{subtitle}</p><h2 id={titleId}>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
        {children}
      </section>
    </dialog>
  );
}

