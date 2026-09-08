import { Circle, Hand, Loader2, Maximize, Minus, Pencil, Plus, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";

import { useI18n, type MessageKey } from "./i18n";
import {
  ANNOTATION_COLORS,
  ANNOTATION_JPEG_QUALITY,
  MAX_ANNOTATION_ZOOM,
  MIN_ANNOTATION_ZOOM,
  annotatedFilename,
  annotationOutputType,
  clampOffset,
  clampZoom,
  fitScale,
  zoomAbout,
  type AnnotationColor,
  type AnnotationDrawTool,
  type AnnotationTool,
  type Offset,
} from "./image-annotation";

const TOOL_BUTTONS = [
  { name: "pen", Icon: Pencil, label: "annotateToolPen" },
  { name: "rectangle", Icon: Square, label: "annotateToolRectangle" },
  { name: "ellipse", Icon: Circle, label: "annotateToolEllipse" },
  { name: "hand", Icon: Hand, label: "annotateToolHand" },
] as const satisfies readonly { name: AnnotationTool; Icon: typeof Pencil; label: MessageKey }[];

/** One step of the +/- buttons. Geometric, so zooming feels even at every scale. */
const ZOOM_STEP = 1.4;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Shape {
  readonly tool: AnnotationDrawTool;
  readonly color: AnnotationColor;
  readonly width: number;
  readonly points: readonly Point[];
}

/**
 * Marks are drawn at the image's own resolution, not the size it happens to be
 * displayed at, so the exported file keeps its original detail. Stroke width
 * scales with the image for the same reason: three pixels is a bold line on a
 * phone screenshot and invisible on a 4000px photograph.
 *
 * Dividing by the zoom keeps the line the same thickness under the pointer at
 * every magnification. Zooming in is how you mark something small, and a line
 * that stayed fixed in image pixels would blot out the very detail you zoomed
 * in to circle. At rest (zoom 1) this is exactly the width it always was.
 */
function strokeWidthFor(width: number, height: number, zoom: number): number {
  return Math.max(1, Math.round(Math.max(3, Math.max(width, height) / 260) / zoom));
}

function drawShape(context: CanvasRenderingContext2D, shape: Shape): void {
  context.strokeStyle = shape.color;
  context.lineWidth = shape.width;
  context.lineCap = "round";
  context.lineJoin = "round";

  const [start] = shape.points;
  const end = shape.points.at(-1);
  if (!start || !end) return;

  context.beginPath();
  if (shape.tool === "pen") {
    context.moveTo(start.x, start.y);
    for (const point of shape.points.slice(1)) context.lineTo(point.x, point.y);
  } else if (shape.tool === "rectangle") {
    context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else {
    context.ellipse(
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      Math.abs(end.x - start.x) / 2,
      Math.abs(end.y - start.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
  }
  context.stroke();
}

export function ImageAnnotator({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (annotated: File) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(MIN_ANNOTATION_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  // Pointer ids currently down on the canvas. Two of them means a pinch, and
  // the in-flight stroke is abandoned rather than dragged around by a gesture
  // that was never meant to draw.
  const pointersRef = useRef(new Map<number, Offset>());
  const panRef = useRef<{ readonly from: Offset; readonly at: Offset } | null>(null);
  const pinchRef = useRef<{ readonly distance: number; readonly zoom: number } | null>(null);
  const [shapes, setShapes] = useState<readonly Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("pen");
  const [color, setColor] = useState<AnnotationColor>(ANNOTATION_COLORS[0]);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  useEffect(() => {
    // The cleanup revokes the URL, which makes a still-loading image fire its
    // error handler. Strict Mode runs every effect twice, so without this guard
    // the discarded first attempt reports a failure over the successful second.
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.addEventListener("load", () => {
      if (cancelled) return;
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
      setReady(true);
    });
    image.addEventListener("error", () => {
      if (!cancelled) setLoadError(t("annotateUnreadable"));
    });
    image.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [file, t]);

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !image || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const shape of shapes) drawShape(context, shape);
    if (drawing) drawShape(context, drawing);
  }, [drawing, shapes]);

  useEffect(() => {
    if (ready) repaint();
  }, [ready, repaint]);

  // The fit is computed here rather than left to `max-height: 100%`, which was
  // silently dropped and let a tall screenshot render at full height inside a
  // clipped stage -- most of the image was simply unreachable.
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setStage({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useMemo(() => fitScale(natural, stage), [natural, stage]);
  const displayed = useMemo(
    () => ({ width: natural.width * fit, height: natural.height * fit }),
    [natural, fit],
  );

  const applyView = useCallback((nextZoom: number, nextOffset: Offset) => {
    const clamped = clampZoom(nextZoom);
    setZoom(clamped);
    setOffset(clampOffset(nextOffset, displayed, stage, clamped));
  }, [displayed, stage]);

  /** Zoom about a point given in client coordinates, e.g. the cursor. */
  const zoomAt = useCallback((nextZoom: number, client?: Offset) => {
    const box = stageRef.current?.getBoundingClientRect();
    const anchor = box && client
      ? { x: client.x - (box.left + box.width / 2), y: client.y - (box.top + box.height / 2) }
      : { x: 0, y: 0 };
    const clamped = clampZoom(nextZoom);
    applyView(clamped, zoomAbout(anchor, offset, zoom, clamped));
  }, [applyView, offset, zoom]);

  const resetView = useCallback(() => {
    setZoom(MIN_ANNOTATION_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);

  // A pan is only bounded once the image is bigger than the stage, so shrinking
  // back to the fit has to pull the image home rather than leave it off-screen.
  useEffect(() => {
    setOffset((current) => clampOffset(current, displayed, stage, zoom));
  }, [displayed, stage, zoom]);

  const pointFrom = (event: ReactPointerEvent<HTMLCanvasElement>): Point | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return undefined;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  };

  const pointerSpread = (): { distance: number; centre: Offset } | undefined => {
    const [first, second] = [...pointersRef.current.values()];
    if (!first || !second) return undefined;
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      centre: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || saving) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);

    const spread = pointerSpread();
    if (spread) {
      // A second finger turns the gesture into a pinch. Whatever the first was
      // drawing is dropped rather than committed: nobody means to leave a mark
      // by starting to zoom.
      setDrawing(null);
      panRef.current = null;
      pinchRef.current = { distance: spread.distance, zoom };
      return;
    }

    if (tool === "hand") {
      panRef.current = { from: offset, at: { x: event.clientX, y: event.clientY } };
      return;
    }

    const point = pointFrom(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) return;
    setDrawing({ tool, color, width: strokeWidthFor(canvas.width, canvas.height, zoom), points: [point] });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch) {
      const spread = pointerSpread();
      if (spread && pinch.distance > 0) zoomAt(pinch.zoom * (spread.distance / pinch.distance), spread.centre);
      return;
    }

    const pan = panRef.current;
    if (pan) {
      applyView(zoom, {
        x: pan.from.x + (event.clientX - pan.at.x),
        y: pan.from.y + (event.clientY - pan.at.y),
      });
      return;
    }

    if (!drawing) return;
    const point = pointFrom(event);
    if (!point) return;
    setDrawing(drawing.tool === "pen"
      ? { ...drawing, points: [...drawing.points, point] }
      : { ...drawing, points: [drawing.points[0]!, point] });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    panRef.current = null;
    if (!drawing) return;
    // A tap with no movement leaves a single point, which would draw nothing.
    if (drawing.points.length > 1) setShapes((current) => [...current, drawing]);
    setDrawing(null);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    // deltaY is negative when scrolling up, which is the direction people
    // expect to magnify. Exponential so a trackpad flick and a mouse notch
    // both feel proportional rather than linear at one scale and wild at another.
    zoomAt(zoom * Math.exp(-event.deltaY / 380), { x: event.clientX, y: event.clientY });
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    setSaving(true);
    const outputType = annotationOutputType(file);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, outputType, outputType === "image/jpeg" ? ANNOTATION_JPEG_QUALITY : undefined);
    });
    if (!blob) {
      setLoadError(t("annotateExportFailed"));
      setSaving(false);
      return;
    }
    const name = annotatedFilename(file.name, outputType);
    try {
      await onSave(new File([blob], name, { type: outputType, lastModified: Date.now() }));
    } finally {
      setSaving(false);
    }
  };

  // A native modal dialog for two reasons. It joins the top layer, so it covers
  // the edit dialog that opens it instead of painting underneath; and the portal
  // keeps it out of the caller's subtree, whose descendant selectors
  // (".attachment-card footer" and the like) would otherwise restyle it.
  return createPortal(
    <dialog
      ref={dialogRef}
      className="annotator"
      aria-label={t("annotateTitle")}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <header className="annotator-bar">
        <strong>{t("annotateTitle")}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label={t("cancel")}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="annotator-tools">
        <div className="annotator-group" role="group" aria-label={t("annotateTools")}>
          {TOOL_BUTTONS.map(({ name, Icon, label }) => (
            <button
              key={name}
              type="button"
              className={`annotator-tool${tool === name ? " active" : ""}`}
              aria-pressed={tool === name}
              aria-label={t(label)}
              onClick={() => setTool(name)}
            >
              <Icon size={17} aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="annotator-group" role="group" aria-label={t("annotateColor")}>
          {ANNOTATION_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={`annotator-swatch${color === swatch ? " active" : ""}`}
              style={{ background: swatch }}
              aria-pressed={color === swatch}
              aria-label={swatch}
              onClick={() => setColor(swatch)}
            />
          ))}
        </div>

        <button
          type="button"
          className="annotator-tool"
          onClick={() => setShapes((current) => current.slice(0, -1))}
          disabled={shapes.length === 0}
          aria-label={t("annotateUndo")}
        >
          <RotateCcw size={17} aria-hidden="true" />
        </button>

        {/* Buttons as well as wheel and pinch: the Android shell turns off the
            browser's own zoom, and a mouse without a wheel still needs a way in. */}
        <div className="annotator-group" role="group" aria-label={t("annotateZoom")}>
          <button
            type="button"
            className="annotator-tool"
            onClick={() => zoomAt(zoom / ZOOM_STEP)}
            disabled={!ready || zoom <= MIN_ANNOTATION_ZOOM}
            aria-label={t("annotateZoomOut")}
          >
            <Minus size={17} aria-hidden="true" />
          </button>
          <output className="annotator-zoom-level">{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            className="annotator-tool"
            onClick={() => zoomAt(zoom * ZOOM_STEP)}
            disabled={!ready || zoom >= MAX_ANNOTATION_ZOOM}
            aria-label={t("annotateZoomIn")}
          >
            <Plus size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="annotator-tool"
            onClick={resetView}
            disabled={!ready || (zoom === MIN_ANNOTATION_ZOOM && offset.x === 0 && offset.y === 0)}
            aria-label={t("annotateZoomFit")}
          >
            <Maximize size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="annotator-stage" ref={stageRef}>
        {loadError
          ? <p className="annotator-error">{loadError}</p>
          : (
            <canvas
              ref={canvasRef}
              className={`annotator-canvas${tool === "hand" ? " panning" : ""}`}
              // Sized here, not by CSS. The backing store stays at the image's
              // natural resolution -- which is what toBlob exports -- while the
              // element is laid out at the fitted size and the transform only
              // changes what is on screen. So zoom and pan cannot reach the
              // saved file, and pointFrom keeps working: getBoundingClientRect
              // already reports the transformed box.
              style={displayed.width > 0
                ? {
                  width: `${displayed.width}px`,
                  height: `${displayed.height}px`,
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                }
                : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            />
          )}
      </div>

      <footer className="annotator-actions">
        <p className="annotator-hint">{t("annotateOverwriteHint")}</p>
        <div>
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>{t("cancel")}</button>
          <button type="button" className="primary" onClick={save} disabled={!ready || saving || Boolean(loadError)}>
            {saving ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null}
            {t("annotateSave")}
          </button>
        </div>
      </footer>
    </dialog>,
    document.body,
  );
}
