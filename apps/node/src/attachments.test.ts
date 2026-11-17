import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { prepareAttachments } from "./attachments.js";
import type { Command } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("downloads only the bound session file, verifies its digest, and reuses the original bytes on retry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-files-"))); roots.push(root);
  const content = Buffer.from("fixture original"); const bytes = vi.fn(async () => content);
  const command: Command = { id: "command-one", status: "queued", text: "read this", attachments: [{ id: "attachment-one", filename: "../中文 original.txt", kind: "file", contentType: "text/plain", sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }] };
  const first = await prepareAttachments(root, "session-one", command, { bytes });
  const path = first.attachments![0]!.localPath!;
  expect(path).toContain("attachment-one.txt"); expect(readFileSync(path)).toEqual(content);
  expect(bytes).toHaveBeenCalledWith("/api/v1/node/agent-sessions/session-one/attachments/attachment-one/content", content.length);
  await prepareAttachments(root, "session-one", command, { bytes }); expect(bytes).toHaveBeenCalledOnce();
  writeFileSync(path, "different bytes");
  await expect(prepareAttachments(root, "session-one", command, { bytes })).rejects.toThrow("changed");
  await expect(prepareAttachments(root, "../session", command, { bytes })).rejects.toThrow("identifier");
});
it("does not make a local file available when the download does not match its declared original", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-files-"))); roots.push(root);
  await expect(prepareAttachments(root, "session", { id: "command", status: "queued", text: "", attachments: [{ id: "file", filename: "file.txt", kind: "file", contentType: "text/plain", sizeBytes: 3, sha256: "a".repeat(64) }] }, { bytes: async () => Buffer.from("bad") })).rejects.toThrow("digest");
});
