import { describe, expect, it } from "vitest";

import { annotatedFilename, annotationOutputType, isAnnotatableImage } from "./image-annotation";

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
