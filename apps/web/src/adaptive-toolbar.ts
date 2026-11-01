import { useLayoutEffect, useState } from "react";

/** Measure the expanded toolbar at its intrinsic width, even while secondary
 * controls are folded. Measuring the folded layout would toggle forever near
 * the threshold. Temporary attributes are restored synchronously before paint. */
export function useToolbarOverflow() {
  const [bar, toolbarRef] = useState<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = () => {
      const available = bar.clientWidth;
      const previousWidth = bar.style.width;
      const previousOverflow = bar.dataset.overflow;
      const secondary = bar.querySelector<HTMLElement>("[data-toolbar-secondary]");
      const hidden = secondary?.getAttribute("aria-hidden");
      bar.dataset.overflow = "false";
      secondary?.setAttribute("aria-hidden", "false");
      bar.style.width = "max-content";
      const required = bar.scrollWidth;
      bar.style.width = previousWidth;
      if (previousOverflow === undefined) delete bar.dataset.overflow;
      else bar.dataset.overflow = previousOverflow;
      if (hidden == null) secondary?.removeAttribute("aria-hidden");
      else secondary?.setAttribute("aria-hidden", hidden);
      setOverflow(required > available + 0.5);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    bar.querySelectorAll("button, summary, [data-toolbar-secondary], code, .status-pill").forEach(node => observer.observe(node));
    const changes = new MutationObserver(measure);
    changes.observe(bar, { childList: true, subtree: true, characterData: true });
    measure();
    return () => { observer.disconnect(); changes.disconnect(); };
  }, [bar]);
  return { toolbarRef, overflow };
}
