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

export const ANNOTATION_TOOLS = ["pen", "rectangle", "ellipse"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

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
