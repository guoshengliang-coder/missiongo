import { useCallback, useEffect, useRef } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { useI18n } from "./i18n";
import { useOverlay } from "./overlay";
import { useMediaQuery } from "./use-media-query";

/** One search value for desktop and the compact topbar, independent of item search. */
export function AgentConsoleSearch({ value, onChange, open, onOpenChange }: {
  value: string; onChange: (value: string) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const compact = useMediaQuery("(max-width: 1023px)");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    onOpenChange(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, [onOpenChange]);
  useOverlay(compact && open, close);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        onOpenChange(true);
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [onOpenChange]);
  return <div className={`agent-console-search-slot ${open ? "expanded" : ""}`}>
    <button ref={trigger} type="button" className="icon-button agent-console-search-trigger"
      aria-label={t("agentConsoleSearch")} aria-expanded={open} onClick={() => onOpenChange(true)}><Search size={19} /></button>
    <label className="agent-console-search">
      <button type="button" className="icon-button agent-console-search-close" aria-label={t("closeSearch")} onClick={close}><ArrowLeft size={18} /></button>
      <Search size={17} />
      <input ref={input} value={value} onChange={event => onChange(event.target.value)}
        aria-label={t("agentConsoleSearch")} placeholder={t("agentConsoleSearch")}
        onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); close(); } }} />
      {value && <button type="button" className="icon-button" aria-label={t("clearSearch")} onClick={() => { onChange(""); input.current?.focus(); }}><X size={17} /></button>}
    </label>
  </div>;
}
