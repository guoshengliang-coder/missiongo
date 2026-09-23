import decodeHeic from "heic-decode";
import sharp from "sharp";

/**
 * Image formats a browser other than Safari cannot draw, and that sharp's
 * prebuilt libvips cannot read either: it carries AVIF but not the HEVC codec
 * behind HEIC. An iPhone saves its photos this way, so without this a
 * screenshot taken on one was a broken tile on every PC and Android phone,
 * and an unreadable preview for the AI reading the item (C6 in
 * docs/ui-ue-review-2026-09.md).
 */
export const BROWSER_UNREADABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/heic", "image/heif"]);

/** The longest edge of the JPEG a HEIC is turned into. Enough to annotate. */
export const DECODED_PREVIEW_EDGE = 2560;

/**
 * One HEIC decode at a time. libheif runs as WebAssembly and holds the whole
 * image as RGBA while it works -- a 12-megapixel photo is about 250 MiB -- so a
 * detail view with several of them must not decode them all at once.
 */
let decoding: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = decoding.then(work, work);
  decoding = next.catch(() => undefined);
  return next;
}

/** A HEIC as a JPEG no larger than {@link DECODED_PREVIEW_EDGE} on its long side. */
export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  return oneAtATime(async () => {
    const { width, height, data } = await decodeHeic({ buffer: bytes });
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
      .resize({ width: DECODED_PREVIEW_EDGE, height: DECODED_PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  });
}
