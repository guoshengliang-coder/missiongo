/**
 * Where an image's small rendition lives and how big to ask for it.
 *
 * The originals behind these run to megabytes and are served `no-store`, so
 * drawing a preview from them meant downloading every screenshot in full each
 * time a detail view opened. The server renders the thumbnail; these decide
 * the URL, which is also the browser's cache key.
 */

/** Tiles in the item list are drawn at 84px and can land on a 2x screen. */
export const LIST_THUMBNAIL_EDGE = 192;

/** The server refuses to render anything larger than this. */
export const MAX_THUMBNAIL_EDGE = 1024;

/**
 * The edge to request for a preview drawn `cssWidth` pixels wide.
 *
 * Rounded up to a few fixed steps rather than the exact pixel count, so cards
 * that differ by a few pixels -- or a pane resized between visits -- ask for
 * the same URL and reuse what the browser already holds.
 */
export function previewThumbnailEdge(cssWidth: number, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const needed = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth * ratio : MAX_THUMBNAIL_EDGE / 2;
  for (const step of [256, 512, 768]) {
    if (needed <= step) return step;
  }
  return MAX_THUMBNAIL_EDGE;
}

/**
 * The thumbnail URL for one attachment revision.
 *
 * Annotating replaces an image under the same id, so the revision has to be in
 * the URL: it is what lets the server mark the response immutable without an
 * edited image hiding behind the cached original.
 */
export function attachmentThumbnailPath(itemKey: string, attachmentId: string, width: number, revision: string): string {
  const query = new URLSearchParams({ width: String(width), rev: revision });
  return `/api/v1/items/${encodeURIComponent(itemKey)}/attachments/${encodeURIComponent(attachmentId)}/thumbnail?${query}`;
}
