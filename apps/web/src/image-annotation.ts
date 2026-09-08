/**
 * Rules for annotating an image attachment.
 *
 * Annotation is destructive by design: the marked-up image replaces the
 * original rather than being stored beside it, so the format and filename it
 * ends up with have to be decided deliberately.
 */

/** Colours offered for circling a problem area. Chosen to stay visible on both light UI screenshots and photographs. */
export const ANNOTATION_COLORS = ["#e5484d", "#f76808", "#ffb224", "#30a46c", "#0091ff", "#8e4ec6"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/**
 * "hand" pans instead of marking. It is a tool rather than a held modifier
 * because reaching a different part of the image is a step people take before
 * drawing, not during it, and a visible mode is something you can find.
 */
export const ANNOTATION_TOOLS = ["pen", "rectangle", "ellipse", "hand"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

/** Drawing tools, i.e. everything that leaves a mark. */
export type AnnotationDrawTool = Exclude<AnnotationTool, "hand">;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Offset {
  readonly x: number;
  readonly y: number;
}

export const MIN_ANNOTATION_ZOOM = 1;
export const MAX_ANNOTATION_ZOOM = 12;

/**
 * How much to shrink the image so all of it is on screen at rest.
 *
 * Capped at 1 so a small image is shown at its own size rather than blown up:
 * an upscaled screenshot is blurry, and its marks would land on pixels that
 * were guessed rather than photographed. Zooming past this is still allowed --
 * that is a deliberate act, not the default view.
 */
export function fitScale(image: Size, stage: Size): number {
  if (image.width <= 0 || image.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(stage.width / image.width, stage.height / image.height, 1);
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ANNOTATION_ZOOM;
  return Math.min(Math.max(zoom, MIN_ANNOTATION_ZOOM), MAX_ANNOTATION_ZOOM);
}

/**
 * The offset that keeps `anchor` under the same pixel of the image while the
 * zoom changes, so pinching or scrolling magnifies what is being pointed at
 * instead of drifting towards the middle.
 *
 * `anchor` is measured from the centre of the stage, matching a CSS transform
 * whose origin is the centre.
 */
export function zoomAbout(anchor: Offset, offset: Offset, fromZoom: number, toZoom: number): Offset {
  const ratio = toZoom / fromZoom;
  return {
    x: anchor.x - (anchor.x - offset.x) * ratio,
    y: anchor.y - (anchor.y - offset.y) * ratio,
  };
}

/**
 * Stop the image being dragged off the stage entirely. Panning is bounded by
 * how much of the image is actually hidden, so at rest there is nowhere to go
 * and there is never an empty stage to recover from.
 */
export function clampOffset(offset: Offset, displayed: Size, stage: Size, zoom: number): Offset {
  // Normalising -0 keeps the value out of the transform string, where it would
  // read as "translate(-0px, 0px)".
  const within = (value: number, slack: number): number => {
    const bounded = Math.min(Math.max(value, -slack), slack);
    return bounded === 0 ? 0 : bounded;
  };
  return {
    x: within(offset.x, Math.max(0, (displayed.width * zoom - stage.width) / 2)),
    y: within(offset.y, Math.max(0, (displayed.height * zoom - stage.height) / 2)),
  };
}

/**
 * HEIC and HEIF decode in neither Chrome nor Firefox, so a canvas cannot read
 * one to draw on. Android cameras produce HEIC by default, so this is the
 * common case rather than an edge one, and the editor says so instead of
 * silently converting a file the person did not ask to convert.
 */
const UNDECODABLE_TYPES = new Set(["image/heic", "image/heif"]);
const UNDECODABLE_EXTENSIONS = new Set(["heic", "heif"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isAnnotatableImage(file: { readonly name: string; readonly type: string }): boolean {
  const type = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (UNDECODABLE_TYPES.has(type) || UNDECODABLE_EXTENSIONS.has(extensionOf(file.name))) return false;
  return type.startsWith("image/");
}

/**
 * A canvas can only export PNG or JPEG. Keeping PNG as PNG preserves the crisp
 * text in a screenshot; everything else becomes JPEG, because re-encoding a
 * photograph as PNG can multiply its size and push it past the upload limit.
 *
 * An animated GIF loses its animation here. That is accepted: what matters
 * after annotation is the frame the marks were drawn on.
 */
export function annotationOutputType(file: { readonly name: string; readonly type: string }): "image/png" | "image/jpeg" {
  const type = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "image/png" || (!type && extensionOf(file.name) === "png")) return "image/png";
  return "image/jpeg";
}

export const ANNOTATION_JPEG_QUALITY = 0.92;

/** Give the annotated file an extension matching the bytes it now holds. */
export function annotatedFilename(originalName: string, outputType: "image/png" | "image/jpeg"): string {
  const extension = outputType === "image/png" ? "png" : "jpg";
  const dot = originalName.lastIndexOf(".");
  const base = dot <= 0 ? originalName : originalName.slice(0, dot);
  return `${base || "image"}.${extension}`;
}
