import { useEffect, useId, useRef, type ComponentProps, type RefObject } from "react";
import { reportAndroidBackDepth } from "./android-bridge";
import { backDepthFromState, DIALOG_HISTORY_MARKER, OVERLAY_HISTORY_MARKER, QUICK_SETTINGS_HISTORY_MARKER } from "./navigation";

type Layer = { id: string; close: () => boolean | void; leaving: boolean };
const layers = new Map<string, Layer>();
let unwinding: { url: string } | undefined;
let suspended = 0;
const afterClose: Array<() => void> = [];
const ids = (): string[] => Array.isArray(history.state?.[DIALOG_HISTORY_MARKER]) ? history.state[DIALOG_HISTORY_MARKER] : [];
const state = () => typeof history.state === "object" && history.state ? history.state : {};
const syncDepth = () => reportAndroidBackDepth(backDepthFromState(history.state));
const active = () => [...layers.values()].filter(layer => !layer.leaving);

function normalizeLegacyLayers() {
  const previous = state();
  const retired = [OVERLAY_HISTORY_MARKER, QUICK_SETTINGS_HISTORY_MARKER].filter(key => previous[key]);
  if (!retired.length) return;
  const next = { ...previous, [DIALOG_HISTORY_MARKER]: [...retired, ...ids()] };
  for (const key of retired) delete next[key];
  history.replaceState(next, "");
}

/** Remove closed entries before registering a replacement (menu -> editor).
 * A single coordinator serializes history traversal; individual components must
 * never race history.back() against another component's pushState(). */
function reconcile() {
  if (unwinding || suspended) return;
  const current = ids();
  const stale = current.findIndex(id => !layers.has(id));
  if (stale >= 0) {
    // A host may restore only the current entry, with no stack to traverse.
    if (history.length <= 1) {
      history.replaceState({ ...state(), [DIALOG_HISTORY_MARKER]: current.slice(0, stale) }, "");
      reconcile();
      return;
    }
    unwinding = { url: location.href };
    history.go(stale - current.length);
    return;
  }
  for (const layer of active()) {
    if (!ids().includes(layer.id)) {
      history.pushState({ ...state(), [DIALOG_HISTORY_MARKER]: [...ids(), layer.id] }, "");
    }
  }
  syncDepth();
  if (!layers.size) for (const action of afterClose.splice(0)) action();
}

/** A guard may approve a page navigation. First retire its confirmation's
 * history entry, then let the route owner perform the approved navigation. */
export function afterOverlaysClose(action: () => void) {
  afterClose.push(action);
  queueMicrotask(reconcile);
}

/** A page guard restores its own history before its confirmation can push a
 * new layer. Otherwise pushState cancels the in-flight forward restoration. */
export function holdOverlayHistory(): () => void {
  suspended++;
  return () => { suspended--; reconcile(); };
}

function dismiss(layer: Layer): boolean {
  layer.leaving = true;
  if (layer.close() === false) { layer.leaving = false; return false; }
  return true;
}

// Registered on module load, before route listeners: dismissing a layer must
// not reset the route, scroll position or the draft of the page underneath it.
if (typeof window !== "undefined") {
  // React instances do not survive reload. Retire their actual history entries,
  // not just the IDs: clearing IDs alone leaves an extra, invisible Back step.
  normalizeLegacyLayers();
  queueMicrotask(reconcile);
  window.addEventListener("popstate", event => {
    normalizeLegacyLayers();
    if (suspended) return;
    if (unwinding) {
      const { url } = unwinding;
      unwinding = undefined;
      event.stopImmediatePropagation();
      // A successful form may have replaced its URL (e.g. applied filters).
      history.replaceState(state(), "", url);
      reconcile();
      return;
    }
    const top = active().at(-1);
    if (top && !ids().includes(top.id)) {
      event.stopImmediatePropagation();
      // Preserve the parent route on a one-step Back. A rejected dismissal
      // restores exactly one entry; the guard owns any confirmation UI.
      if (!dismiss(top)) {
        history.pushState({ ...state(), [DIALOG_HISTORY_MARKER]: active().map(layer => layer.id) }, "");
      }
      syncDepth();
      return;
    }
    // Forward/reload must not revive an invisible layer or native Back depth.
    if (ids().some(id => !layers.has(id))) {
      history.replaceState({ ...state(), [DIALOG_HISTORY_MARKER]: ids().filter(id => layers.has(id)) }, "");
      syncDepth();
    }
  }, true);
  window.addEventListener("keydown", event => {
    const top = active().at(-1);
    if (event.key !== "Escape" || !top) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss(top);
  }, true);
}

function register(id: string, close: Layer["close"]): () => void {
  const layer: Layer = { id, close, leaving: false };
  layers.set(id, layer);
  reconcile();
  return () => {
    if (layers.get(id) === layer) layers.delete(id);
    // StrictMode can immediately re-register the same id. Only reconcile the
    // settled set, including a parent and its child being removed together.
    queueMicrotask(reconcile);
  };
}

/** Use for nonmodal popups. Return false to retain a guarded/pending layer. */
export function useOverlay(open: boolean, onClose: () => boolean | void) {
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => open ? register(id, () => close.current()) : undefined, [id, open]);
}

/** The only native dialog lifecycle: top-layer inertness and focus belong to
 * the browser, while all dialogs/popups share the same history coordinator. */
export function useModalSurface(ref: RefObject<HTMLDialogElement | null>, onClose: () => boolean | void, open = true) {
  useOverlay(open, onClose);
  const close = useRef(onClose);
  close.current = onClose;
  const generation = useRef(0);
  const original = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const current = ++generation.current;
    const dialog = ref.current;
    if (!original.current || !original.current.isConnected) original.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [role=combobox]:not(:disabled)")?.focus({ preventScroll: true });
    const cancel = (event: Event) => { if (event.target !== dialog) return; event.preventDefault(); close.current(); };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.close();
      queueMicrotask(() => {
        if (generation.current !== current) return;
        const target = original.current;
        const top = document.activeElement?.closest<HTMLDialogElement>("dialog[open]") ?? Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
        if (target?.isConnected && (!top || top.contains(target))) target.focus({ preventScroll: true });
        else {
          const fallback = top ?? document.querySelector<HTMLElement>(".settings-page-main, .detail-pane, main");
          if (fallback) { if (!fallback.hasAttribute("tabindex")) fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
        }
        original.current = null;
      });
    };
  }, [open, ref]);
}

export function OverlayDialog({ onClose, children, ...props }: Omit<ComponentProps<"dialog">, "onClose" | "open" | "ref"> & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useModalSurface(ref, onClose);
  return <dialog {...props} ref={ref} onClick={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>{children}</dialog>;
}

/** Native details menus keep their existing markup and positioning, but get
 * the same one-layer Back/Escape contract as Select. Disclosure sections are
 * not menus and should keep using ordinary details. */
export function OverlayMenu({ ref: externalRef, ...props }: ComponentProps<"details">) {
  const ref = useRef<HTMLDetailsElement>(null);
  const id = useId();
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    let unregister: (() => void) | undefined;
    const sync = () => {
      const visible = menu.open && !menu.parentElement?.closest("details:not([open])");
      if (visible && !unregister) unregister = register(id, () => { menu.open = false; menu.querySelector("summary")?.focus({ preventScroll: true }); });
      if (!visible && unregister) { unregister(); unregister = undefined; }
    };
    const observer = new MutationObserver(sync);
    observer.observe(menu, { attributes: true, attributeFilter: ["open"] });
    const parent = menu.parentElement?.closest("details");
    if (parent) observer.observe(parent, { attributes: true, attributeFilter: ["open"] });
    sync();
    return () => { observer.disconnect(); unregister?.(); };
  }, [id]);
  return <details {...props} ref={node => {
    ref.current = node;
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef) externalRef.current = node;
  }} />;
}
