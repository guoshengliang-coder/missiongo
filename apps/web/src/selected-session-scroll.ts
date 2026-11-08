import { useLayoutEffect, useRef } from "react";

/** Reveal only on navigation/arrival/layout changes, not on polling or user scrolling. */
export function useSelectedSessionScroll(id: string | null, visible: boolean, conversationOpen: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || !id || !visible) return;
    const reveal = () => {
      const row = list.querySelector<HTMLElement>(".agent-console-session.active");
      if (!row || !list.getClientRects().length || list.clientHeight === 0) return;
      const box = list.getBoundingClientRect(), target = row.getBoundingClientRect();
      if (target.top < box.top) list.scrollTop += target.top - box.top;
      else if (target.bottom > box.bottom) list.scrollTop += Math.min(target.bottom - box.bottom, target.top - box.top);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [id, visible, conversationOpen]);
  return ref;
}
