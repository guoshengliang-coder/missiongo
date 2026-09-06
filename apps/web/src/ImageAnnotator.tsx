import { Circle, Loader2, Pencil, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { useI18n, type MessageKey } from "./i18n";
import {
  ANNOTATION_COLORS,
  ANNOTATION_JPEG_QUALITY,
  annotatedFilename,
  annotationOutputType,
  type AnnotationColor,
  type AnnotationTool,
} from "./image-annotation";

const TOOL_BUTTONS = [
  { name: "pen", Icon: Pencil, label: "annotateToolPen" },
  { name: "rectangle", Icon: Square, label: "annotateToolRectangle" },
  { name: "ellipse", Icon: Circle, label: "annotateToolEllipse" },
] as const satisfies readonly { name: AnnotationTool; Icon: typeof Pencil; label: MessageKey }[];

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Shape {
  readonly tool: AnnotationTool;
  readonly color: AnnotationColor;
  readonly width: number;
  readonly points: readonly Point[];
}

/**
 * Marks are drawn at the image's own resolution, not the size it happens to be
 * displayed at, so the exported file keeps its original detail. Stroke width
 * scales with the image for the same reason: three pixels is a bold line on a
 * phone screenshot and invisible on a 4000px photograph.
 */
function strokeWidthFor(width: number, height: number): number {
  return Math.max(3, Math.round(Math.max(width, height) / 260));
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || saving) return;
    const point = pointFrom(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing({ tool, color, width: strokeWidthFor(canvas.width, canvas.height), points: [point] });
  };

  const extendStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const point = pointFrom(event);
    if (!point) return;
    setDrawing(drawing.tool === "pen"
      ? { ...drawing, points: [...drawing.points, point] }
      : { ...drawing, points: [drawing.points[0]!, point] });
  };

  const endStroke = () => {
    if (!drawing) return;
    // A tap with no movement leaves a single point, which would draw nothing.
    if (drawing.points.length > 1) setShapes((current) => [...current, drawing]);
    setDrawing(null);
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
      </div>

      <div className="annotator-stage">
        {loadError
          ? <p className="annotator-error">{loadError}</p>
          : (
            <canvas
              ref={canvasRef}
              className="annotator-canvas"
              onPointerDown={startStroke}
              onPointerMove={extendStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
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
