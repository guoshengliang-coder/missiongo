import { describe, expect, it } from "vitest";

import { attachmentThumbnailPath, MAX_THUMBNAIL_EDGE, previewThumbnailEdge } from "./attachment-thumbnail";

describe("sizing a detail-view preview", () => {
  it("covers the drawn width at the screen's pixel ratio", () => {
    expect(previewThumbnailEdge(240, 1)).toBe(256);
    expect(previewThumbnailEdge(240, 2)).toBe(512);
    expect(previewThumbnailEdge(360, 2)).toBe(768);
  });

  it("snaps nearby widths to the same request so the browser cache is shared", () => {
    expect(previewThumbnailEdge(300, 2)).toBe(previewThumbnailEdge(330, 2));
  });

  it("never asks for more than the server will render", () => {
    expect(previewThumbnailEdge(1600, 3)).toBe(MAX_THUMBNAIL_EDGE);
  });

  it("falls back to a middle size when the card has not been measured", () => {
    expect(previewThumbnailEdge(0, 2)).toBe(512);
    expect(previewThumbnailEdge(Number.NaN, Number.NaN)).toBe(512);
  });
});

describe("the thumbnail URL", () => {
  it("names the revision, so an annotated image gets a new cache entry", () => {
    const before = attachmentThumbnailPath("AND-1", "a1", 512, "aaaaaaaaaaaa");
    const after = attachmentThumbnailPath("AND-1", "a1", 512, "bbbbbbbbbbbb");
    expect(before).toBe("/api/v1/items/AND-1/attachments/a1/thumbnail?width=512&rev=aaaaaaaaaaaa");
    expect(after).not.toBe(before);
  });

  it("escapes the path segments it is given", () => {
    expect(attachmentThumbnailPath("AND 1", "a/1", 192, "r")).toBe(
      "/api/v1/items/AND%201/attachments/a%2F1/thumbnail?width=192&rev=r",
    );
  });
});
