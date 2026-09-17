import { describe, expect, it } from "vitest";

import { validateAttachment } from "./attachment-validation";

const mib = 1024 * 1024;

describe("validateAttachment", () => {
  it("accepts supported document extensions at their server-aligned limits", () => {
    expect(validateAttachment({ name: "notes.md", size: 10 * mib })).toEqual({ valid: true });
    expect(validateAttachment({ name: "export.csv", size: 10 * mib })).toEqual({ valid: true });
    expect(validateAttachment({ name: "report.pdf", size: 20 * mib })).toEqual({ valid: true });
  });

  it("reports the PDF size limit instead of treating PDFs as unsupported", () => {
    expect(validateAttachment({ name: "report.pdf", size: 20 * mib + 1 })).toEqual({
      valid: false,
      reason: "too-large",
      limitMiB: 20,
    });
  });

  it("continues to reject extensions outside the selected attachment category", () => {
    expect(validateAttachment({ name: "movie.mp4", size: mib }, ["md", "txt", "csv", "json", "pdf"])).toEqual({
      valid: false,
      reason: "unsupported",
    });
  });
});
