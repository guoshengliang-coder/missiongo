import { describe, expect, it } from "vitest";

import { MEBIBYTE, validateUpload, validateUploadMetadata } from "./attachment-storage.js";

describe("HTML and ZIP attachment rules", () => {
  it("applies the exact 10 and 100 MiB limits before receiving bytes", () => {
    expect(validateUploadMetadata("prototype.html", "text/html", 10 * MEBIBYTE).rule.kind).toBe("document");
    expect(validateUploadMetadata("prototype.zip", "application/zip", 100 * MEBIBYTE).rule.kind).toBe("archive");
    expect(() => validateUploadMetadata("prototype.html", "text/html", 10 * MEBIBYTE + 1)).toThrow("10 MiB limit");
    expect(() => validateUploadMetadata("prototype.zip", "application/zip", 100 * MEBIBYTE + 1)).toThrow("100 MiB limit");
  });

  it("rejects mismatched MIME types and non-ZIP bytes while preserving supported aliases", () => {
    expect(() => validateUploadMetadata("prototype.html", "application/zip", 1)).toThrow("does not match");
    expect(() => validateUploadMetadata("prototype.zip", "text/html", 4)).toThrow("does not match");
    expect(validateUploadMetadata("prototype.zip", "application/x-zip-compressed", 4).rule.kind).toBe("archive");
    expect(() => validateUpload("prototype.zip", "application/zip", Buffer.from("plain text"))).toThrow("does not match");
    expect(() => validateUploadMetadata("prototype.exe", "application/octet-stream", 1)).toThrow("Unsupported attachment extension");
  });
});
