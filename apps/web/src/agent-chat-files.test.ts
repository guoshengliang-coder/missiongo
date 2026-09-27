import { describe, expect, it } from "vitest";

import { mergeChatFiles } from "./agent-chat-files";

const mib = 1024 * 1024;

// validateAttachment reads only name and size; a full byte buffer would prove
// nothing beyond what these two fields already say.
function file(name: string, size: number): File {
  return { name, size } as File;
}

describe("mergeChatFiles", () => {
  it("appends dropped or pasted files to the draft", () => {
    const current = [file("shot.png", 8 * mib)];
    const incoming = [file("clip.mp4", 2 * mib), file("note.md", 512)];
    const result = mergeChatFiles(current, incoming);
    expect(result.rejection).toBeNull();
    expect(result.files.map((entry) => entry.name)).toEqual(["shot.png", "clip.mp4", "note.md"]);
  });

  it("keeps the draft unchanged when the batch would pass ten files", () => {
    const current = Array.from({ length: 8 }, (_, index) => file(`shot-${index}.png`, 512));
    const result = mergeChatFiles(current, [file("extra-1.png", 512), file("extra-2.png", 512), file("extra-3.png", 512)]);
    expect(result.rejection).toEqual({ reason: "too-many" });
    expect(result.files).toHaveLength(8);
  });

  it("rejects the whole batch on an unsupported extension, keeping what was already drafted", () => {
    const current = [file("shot.png", 512)];
    const result = mergeChatFiles(current, [file("ok.png", 512), file("archive.zip", 512)]);
    expect(result.rejection).toEqual({ reason: "unsupported", filename: "archive.zip" });
    expect(result.files).toHaveLength(1);
  });

  it("rejects a file past its own size limit", () => {
    const result = mergeChatFiles([], [file("huge.mp4", 101 * mib)]);
    expect(result.rejection).toEqual({ reason: "too-large", filename: "huge.mp4", limitMiB: 100 });
  });

  it("re-checks files already sitting in the draft, so nothing invalid rides along", () => {
    const result = mergeChatFiles([file("stale.exe", 512)], [file("shot.png", 512)]);
    expect(result.rejection).toEqual({ reason: "unsupported", filename: "stale.exe" });
  });

  it("leaves the draft untouched when nothing comes in", () => {
    const current = [file("shot.png", 512)];
    const result = mergeChatFiles(current, []);
    expect(result.rejection).toBeNull();
    expect(result.files).toEqual(current);
  });
});
