import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useI18n } from "./i18n";

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const INITIAL: View = { scale: 1, x: 0, y: 0 };

/** Owns only image gestures. The gallery still owns unzoomed one-finger swipes. */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const viewRef = useRef<View>(INITIAL);
  const [view, setView] = useState(INITIAL);
  const points = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; center: Point; distance: number } | null>(null);
  const lastTap = useRef<{ time: number; point: Point } | null>(null);
  const tapStart = useRef<Point | null>(null);
  const moved = useRef(false);
  const pointerType = useRef("");

  const apply = (next: View) => {
    const scale = Math.max(1, Math.min(5, next.scale));
    const bounds = viewport.current;
    const img = image.current;
    const fit = bounds && img?.naturalWidth ? Math.min(bounds.clientWidth / img.naturalWidth, bounds.clientHeight / img.naturalHeight) : 0;
    const limitX = bounds && img ? Math.max(0, (img.naturalWidth * fit * scale - bounds.clientWidth) / 2) : 0;
    const limitY = bounds && img ? Math.max(0, (img.naturalHeight * fit * scale - bounds.clientHeight) / 2) : 0;
    const value = { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    viewRef.current = value;
    setView(value);
  };
  const zoom = (scale: number) => apply({ ...viewRef.current, scale });
  const begin = () => {
    const values = [...points.current.values()];
    if (!values.length) { gesture.current = null; return; }
    const first = values[0]!;
    const second = values[1];
    gesture.current = {
      view: viewRef.current,
      center: second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first,
      distance: second ? Math.hypot(first.x - second.x, first.y - second.y) : 0,
    };
  };

  useEffect(() => {
    const element = viewport.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(viewRef.current.scale * Math.exp(-event.deltaY * 0.002));
    };
    element?.addEventListener("wheel", wheel, { passive: false });
    const resize = new ResizeObserver(() => apply(viewRef.current));
    if (element) resize.observe(element);
    return () => { element?.removeEventListener("wheel", wheel); resize.disconnect(); };
  }, []);

  const finish = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!points.current.has(event.pointerId)) return;
    if (!cancelled && event.pointerType === "touch" && points.current.size === 1 && !moved.current) {
      const now = performance.now();
      const previous = lastTap.current;
      if (previous && now - previous.time < 300 && Math.hypot(event.clientX - previous.point.x, event.clientY - previous.point.y) < 24) {
        zoom(viewRef.current.scale > 1 ? 1 : 2.5);
        lastTap.current = null;
      } else lastTap.current = { time: now, point: { x: event.clientX, y: event.clientY } };
    }
    points.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    begin();
  };

  return <div className="zoomable-image" data-zoomed={view.scale > 1}>
    <div ref={viewport} className="zoomable-image-viewport"
      onDoubleClick={() => { if (pointerType.current !== "touch") zoom(viewRef.current.scale > 1 ? 1 : 2.5); }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        pointerType.current = event.pointerType;
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        tapStart.current = { x: event.clientX, y: event.clientY };
        moved.current = points.current.size > 1;
        if (moved.current) lastTap.current = null;
        begin();
      }}
      onPointerMove={event => {
        if (!points.current.has(event.pointerId)) return;
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (tapStart.current && Math.hypot(event.clientX - tapStart.current.x, event.clientY - tapStart.current.y) > 8) moved.current = true;
        const start = gesture.current;
        if (!start) return;
        const values = [...points.current.values()];
        const first = values[0]!;
        const second = values[1];
        if (second && start.distance > 0) {
          const scale = Math.max(1, Math.min(5, start.view.scale * Math.hypot(first.x - second.x, first.y - second.y) / start.distance));
          const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = scale / start.view.scale;
          apply({ scale,
            x: start.view.x * ratio + (start.center.x - bounds.left - bounds.width / 2) * (1 - ratio) + center.x - start.center.x,
            y: start.view.y * ratio + (start.center.y - bounds.top - bounds.height / 2) * (1 - ratio) + center.y - start.center.y });
        } else if (start.view.scale > 1) apply({ ...start.view, x: start.view.x + first.x - start.center.x, y: start.view.y + first.y - start.center.y });
      }}
      onPointerUp={event => finish(event)}
      onPointerCancel={event => finish(event, true)}
      onLostPointerCapture={event => { if (points.current.delete(event.pointerId)) begin(); }}
    >
      <img ref={image} src={src} alt={alt} draggable={false} onLoad={() => apply(INITIAL)} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
    <div className="image-zoom-controls" onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
      <button type="button" onClick={() => zoom(viewRef.current.scale / 1.5)} disabled={view.scale <= 1} aria-label={t("zoomOutImage")}><Minus size={18} /></button>
      <button type="button" onClick={() => apply(INITIAL)} aria-label={t("resetImageZoom")} title={t("resetImageZoom")}><RotateCcw size={16} /><span>{Math.round(view.scale * 100)}%</span></button>
      <button type="button" onClick={() => zoom(viewRef.current.scale * 1.5)} disabled={view.scale >= 5} aria-label={t("zoomInImage")}><Plus size={18} /></button>
    </div>
  </div>;
}
