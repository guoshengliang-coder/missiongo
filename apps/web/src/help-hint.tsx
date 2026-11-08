import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";
import { useOverlay } from "./overlay";
import { useI18n } from "./i18n";
import "./help-hint.css";

/** Click help is separate from the label: reading never changes a form value. */
export function HelpHint({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n(), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 300, maxHeight: 300 });
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useOverlay(open, () => close(true));
  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent).detail !== id) close(); };
    document.addEventListener("missiongo-help-open", other);
    return () => document.removeEventListener("missiongo-help-open", other);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".back-button")) return;
      if (!trigger.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      if (!trigger.current?.getClientRects().length) { close(); return; }
      const a = trigger.current.getBoundingClientRect(), v = window.visualViewport;
      const x = v?.offsetLeft ?? 0, y = v?.offsetTop ?? 0;
      const w = v?.width ?? innerWidth, h = v?.height ?? innerHeight;
      if (a.bottom < y || a.top > y + h || a.right < x || a.left > x + w) { close(); return; }
      const width = Math.min(340, w - 16), below = y + h - a.bottom - 14, above = a.top - y - 14;
      const desired = Math.min(panel.current?.scrollHeight ?? 200, 300);
      const up = below < desired && above > below, maxHeight = Math.max(44, Math.min(300, up ? above : below));
      const next = { left: Math.max(x + 8, Math.min(a.left, x + w - width - 8)),
        top: up ? Math.max(y + 8, a.top - Math.min(desired, maxHeight) - 6) : a.bottom + 6, width, maxHeight };
      setPosition(previous => previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (panel.current) observer.observe(panel.current);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener("resize", fit); window.addEventListener("scroll", fit, true);
    window.visualViewport?.addEventListener("resize", fit); window.visualViewport?.addEventListener("scroll", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); window.removeEventListener("scroll", fit, true);
      window.visualViewport?.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("scroll", fit); };
  }, [open]);
  return <><button type="button" ref={trigger} className="help-hint-trigger" aria-label={t("helpFor", { title })}
    aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
      if (open) close(true);
      else { document.dispatchEvent(new CustomEvent("missiongo-help-open", { detail: id })); setOpen(true); }
    }}><CircleHelp size={14} strokeWidth={1.5} aria-hidden="true" /></button>
    {open && createPortal(<div ref={panel} id={id} role="region" aria-label={title} className="help-hint-panel" style={position}>
      <header><strong>{title}</strong><button type="button" className="icon-button" aria-label={t("close")} onClick={() => close(true)}><X size={16} /></button></header>
      <div>{children}</div>
    </div>, trigger.current?.closest("dialog") ?? document.body)}</>;
}
