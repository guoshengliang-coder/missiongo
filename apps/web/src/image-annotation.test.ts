import { describe, expect, it } from "vitest";

import {
  annotatedFilename,
  annotationOutputType,
  clampOffset,
  clampZoom,
  fitScale,
  isAnnotatableImage,
  MAX_ANNOTATION_ZOOM,
  zoomAbout,
} from "./image-annotation";

describe("isAnnotatableImage", () => {
  it("accepts the image types a canvas can decode", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isAnnotatableImage({ name: "shot.bin", type })).toBe(true);
    }
  });

  it("rejects HEIC and HEIF, which no mainstream browser decodes", () => {
    // Android cameras produce these by default, so the editor has to say why
    // rather than open onto a blank canvas.
    expect(isAnnotatableImage({ name: "IMG_0001.heic", type: "image/heic" })).toBe(false);
    expect(isAnnotatableImage({ name: "IMG_0001.heif", type: "image/heif" })).toBe(false);
    expect(isAnnotatableImage({ name: "IMG_0001.HEIC", type: "" })).toBe(false);
  });

  it("rejects anything that is not an image", () => {
    expect(isAnnotatableImage({ name: "launch.log", type: "text/plain" })).toBe(false);
    expect(isAnnotatableImage({ name: "clip.mp4", type: "video/mp4" })).toBe(false);
  });
});

describe("annotationOutputType", () => {
  it("keeps a PNG screenshot as PNG", () => {
    expect(annotationOutputType({ name: "shot.png", type: "image/png" })).toBe("image/png");
    expect(annotationOutputType({ name: "shot.png", type: "" })).toBe("image/png");
  });

  it("writes everything else as JPEG", () => {
    // Re-encoding a photograph as PNG can multiply its size past the limit.
    expect(annotationOutputType({ name: "photo.jpg", type: "image/jpeg" })).toBe("image/jpeg");
    expect(annotationOutputType({ name: "shot.webp", type: "image/webp" })).toBe("image/jpeg");
    expect(annotationOutputType({ name: "loop.gif", type: "image/gif" })).toBe("image/jpeg");
  });
});

describe("annotatedFilename", () => {
  it("matches the extension to the bytes the file now holds", () => {
    expect(annotatedFilename("shot.webp", "image/jpeg")).toBe("shot.jpg");
    expect(annotatedFilename("shot.png", "image/png")).toBe("shot.png");
    expect(annotatedFilename("photo.JPEG", "image/jpeg")).toBe("photo.jpg");
  });

  it("handles names with no extension or a leading dot", () => {
    expect(annotatedFilename("screenshot", "image/png")).toBe("screenshot.png");
    expect(annotatedFilename(".hidden", "image/jpeg")).toBe(".hidden.jpg");
  });
});

describe("fitting the image to the stage", () => {
  it("shrinks a tall screenshot until all of it is on screen", () => {
    // The exact shape from the report: at full size only a quarter of it fit,
    // and the rest could not be reached at all.
    const scale = fitScale({ width: 1170, height: 2532 }, { width: 1446, height: 606 });
    expect(scale).toBeCloseTo(606 / 2532, 10);
    expect(2532 * scale).toBeCloseTo(606, 6);
    expect(1170 * scale).toBeLessThan(1446);
  });

  it("leaves a small image at its own size rather than blowing it up", () => {
    expect(fitScale({ width: 200, height: 120 }, { width: 1400, height: 800 })).toBe(1);
  });

  it("falls back to 1 before anything has been measured", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("zooming", () => {
  it("stays within the allowed range", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(999)).toBe(MAX_ANNOTATION_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("keeps the anchored point under the pointer", () => {
    // Anchor 100px right of centre. After doubling, the image pixel that was
    // under the pointer has to still be under it.
    const anchor = { x: 100, y: 0 };
    const next = zoomAbout(anchor, { x: 0, y: 0 }, 1, 2);
    expect(next).toEqual({ x: -100, y: 0 });
    // The anchor's position relative to the image origin doubled, and the
    // offset absorbed exactly that much.
    expect(anchor.x - next.x).toBe(2 * (anchor.x - 0));
  });

  it("leaves the view alone when the zoom does not change", () => {
    expect(zoomAbout({ x: 40, y: -12 }, { x: 5, y: 7 }, 3, 3)).toEqual({ x: 5, y: 7 });
  });
});

describe("panning bounds", () => {
  const displayed = { width: 400, height: 600 };
  const stage = { width: 400, height: 600 };

  it("has nowhere to go while the whole image is visible", () => {
    expect(clampOffset({ x: 250, y: -900 }, displayed, stage, 1)).toEqual({ x: 0, y: 0 });
  });

  it("allows exactly the hidden half in each direction", () => {
    // At 2x the image is 800x1200 in a 400x600 stage, so 200/300 is hidden
    // on each side.
    expect(clampOffset({ x: 1000, y: 1000 }, displayed, stage, 2)).toEqual({ x: 200, y: 300 });
    expect(clampOffset({ x: -1000, y: -1000 }, displayed, stage, 2)).toEqual({ x: -200, y: -300 });
    expect(clampOffset({ x: 50, y: -80 }, displayed, stage, 2)).toEqual({ x: 50, y: -80 });
  });

  it("pulls the image home when the zoom drops back to the fit", () => {
    const panned = clampOffset({ x: 200, y: 300 }, displayed, stage, 2);
    expect(clampOffset(panned, displayed, stage, 1)).toEqual({ x: 0, y: 0 });
  });
});
