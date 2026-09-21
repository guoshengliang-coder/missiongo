import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const captureSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
const sdkSource = readFileSync(fileURLToPath(new URL("./SdkFeedback.tsx", import.meta.url)), "utf8");

describe("mobile media deletion default", () => {
  it("defaults both phone upload forms to selected", () => {
    expect(captureSource).toContain("const [clearGalleryCopies, setClearGalleryCopies] = useState(true)");
    expect(sdkSource).toContain("const [clearGalleryCopies, setClearGalleryCopies] = useState(true)");
  });

  it("still deletes only after every selected upload succeeds", () => {
    expect(captureSource).toContain("if (clearGalleryCopies && failedUploads === 0) mediaDeletion?.deletePickedMedia()");
    expect(sdkSource).toContain("if (clearGalleryCopies && failed.length === 0) mediaDeletion?.deletePickedMedia()");
  });
});
