import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import type { AttachmentKind } from "@missiongo/domain";

import { invalidInput } from "./errors.js";
import type { MissionGoStore } from "./store.js";
import type { AttachmentRecord } from "./types.js";

interface AttachmentRule {
  readonly kind: AttachmentKind;
  readonly contentType: string;
  readonly acceptedContentTypes: readonly string[];
  readonly maxBytes: number;
}

const MEBIBYTE = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 100 * MEBIBYTE;

const RULES: Readonly<Record<string, AttachmentRule>> = {
  ".png": { kind: "image", contentType: "image/png", acceptedContentTypes: ["image/png"], maxBytes: 20 * MEBIBYTE },
  ".jpg": { kind: "image", contentType: "image/jpeg", acceptedContentTypes: ["image/jpeg"], maxBytes: 20 * MEBIBYTE },
  ".jpeg": { kind: "image", contentType: "image/jpeg", acceptedContentTypes: ["image/jpeg"], maxBytes: 20 * MEBIBYTE },
  ".webp": { kind: "image", contentType: "image/webp", acceptedContentTypes: ["image/webp"], maxBytes: 20 * MEBIBYTE },
  ".gif": { kind: "image", contentType: "image/gif", acceptedContentTypes: ["image/gif"], maxBytes: 20 * MEBIBYTE },
  ".heic": { kind: "image", contentType: "image/heic", acceptedContentTypes: ["image/heic", "image/heif"], maxBytes: 20 * MEBIBYTE },
  ".mp4": { kind: "video", contentType: "video/mp4", acceptedContentTypes: ["video/mp4"], maxBytes: MAX_ATTACHMENT_BYTES },
  ".mov": { kind: "video", contentType: "video/quicktime", acceptedContentTypes: ["video/quicktime"], maxBytes: MAX_ATTACHMENT_BYTES },
  ".webm": { kind: "video", contentType: "video/webm", acceptedContentTypes: ["video/webm"], maxBytes: MAX_ATTACHMENT_BYTES },
  ".log": { kind: "log", contentType: "text/plain", acceptedContentTypes: ["text/plain"], maxBytes: 10 * MEBIBYTE },
  // A .txt or .json someone attaches is far more often a note or an exported
  // payload than a log, and filing it under diagnostics buried it. Only .log
  // still means "machine output"; everything else readable is a document.
  ".txt": { kind: "document", contentType: "text/plain", acceptedContentTypes: ["text/plain"], maxBytes: 10 * MEBIBYTE },
  ".json": { kind: "document", contentType: "application/json", acceptedContentTypes: ["application/json"], maxBytes: 10 * MEBIBYTE },
  ".md": { kind: "document", contentType: "text/markdown", acceptedContentTypes: ["text/markdown", "text/plain", "text/x-markdown"], maxBytes: 10 * MEBIBYTE },
  ".csv": { kind: "document", contentType: "text/csv", acceptedContentTypes: ["text/csv", "text/plain", "application/csv"], maxBytes: 10 * MEBIBYTE },
  ".pdf": { kind: "document", contentType: "application/pdf", acceptedContentTypes: ["application/pdf"], maxBytes: 20 * MEBIBYTE },
};

function safeFilename(encodedFilename: string): string {
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw invalidInput("Attachment filename is not valid URL-encoded text.");
  }
  if (!filename || filename.length > 255 || filename.includes("\0") || filename.includes("\\") || basename(filename) !== filename) {
    throw invalidInput("Attachment filename must be a plain filename without a path.");
  }
  return filename;
}

interface ValidatedUpload {
  readonly filename: string;
  readonly extension: string;
  readonly rule: AttachmentRule;
  readonly contentType: string;
}

/**
 * Apply the rules an incoming attachment has to satisfy, whether it is being
 * added or replacing an existing one. Keeping this in one place stops the two
 * paths drifting apart on limits or accepted types.
 */
function validateUpload(encodedFilename: string, suppliedContentType: string, bytes: Buffer): ValidatedUpload {
  const filename = safeFilename(encodedFilename);
  const extension = extname(filename).toLowerCase();
  const rule = RULES[extension];
  if (!rule) throw invalidInput("Unsupported attachment extension.");
  if (bytes.length < 1) throw invalidInput("Attachment cannot be empty.");
  if (bytes.length > rule.maxBytes) throw invalidInput(`Attachment exceeds the ${rule.maxBytes / MEBIBYTE} MiB limit.`);

  const normalizedType = suppliedContentType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalizedType && normalizedType !== "application/octet-stream" && !rule.acceptedContentTypes.includes(normalizedType)) {
    throw invalidInput("Attachment content type does not match its filename.");
  }

  return {
    filename,
    extension,
    rule,
    contentType: normalizedType && normalizedType !== "application/octet-stream" ? normalizedType : rule.contentType,
  };
}

export class AttachmentStorage {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async save(
    store: MissionGoStore,
    itemKey: string,
    encodedFilename: string,
    suppliedContentType: string,
    bytes: Buffer,
    feedbackUpload?: { readonly draftId: string; readonly clientAttachmentId: string },
  ): Promise<AttachmentRecord> {
    store.getWorkItem(itemKey);
    const { filename, extension, rule, contentType } = validateUpload(encodedFilename, suppliedContentType, bytes);

    const contentSha256 = feedbackUpload ? createHash("sha256").update(bytes).digest("hex") : undefined;
    const existing = feedbackUpload
      ? store.getFeedbackAttachmentUpload(feedbackUpload.draftId, feedbackUpload.clientAttachmentId)
      : undefined;
    if (existing) {
      if (
        existing.attachment.filename !== filename
        || existing.attachment.sizeBytes !== bytes.length
        || existing.contentSha256 !== contentSha256
      ) {
        throw invalidInput("Client attachment ID has already been used for a different file.");
      }
      return existing.attachment;
    }

    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const storageFilename = `${randomUUID()}${extension}`;
    const path = this.resolveStoredFile(storageFilename);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      return store.createAttachmentMetadata({
        itemKey,
        kind: rule.kind,
        filename,
        storageFilename,
        contentType,
        sizeBytes: bytes.length,
        ...(feedbackUpload ? {
          feedbackDraftId: feedbackUpload.draftId,
          clientAttachmentId: feedbackUpload.clientAttachmentId,
          contentSha256: contentSha256!,
        } : {}),
      });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Replace an attachment's bytes in place, keeping its id and display number.
   *
   * The new file is written first and the old one removed only after the
   * metadata swap commits. A failure then leaves an unreferenced file behind,
   * which is harmless, rather than a row pointing at a file that is gone.
   */
  async replace(
    store: MissionGoStore,
    itemKey: string,
    attachmentId: string,
    encodedFilename: string,
    suppliedContentType: string,
    bytes: Buffer,
  ): Promise<AttachmentRecord> {
    const { filename, extension, rule, contentType } = validateUpload(encodedFilename, suppliedContentType, bytes);

    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const storageFilename = `${randomUUID()}${extension}`;
    const path = this.resolveStoredFile(storageFilename);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });

    let replaced;
    try {
      replaced = store.replaceAttachmentContent({
        itemKey,
        attachmentId,
        kind: rule.kind,
        filename,
        storageFilename,
        contentType,
        sizeBytes: bytes.length,
      });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }

    await unlink(this.resolveStoredFile(replaced.replacedStorageFilename)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return replaced.attachment;
  }

  async remove(store: MissionGoStore, itemKey: string, attachmentId: string): Promise<AttachmentRecord> {
    const attachment = store.getAttachmentRecord(itemKey, attachmentId);
    const path = this.resolveStoredFile(attachment.storageFilename);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return store.deleteAttachmentMetadata(itemKey, attachmentId);
  }

  resolveStoredFile(storageFilename: string): string {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(storageFilename)) throw invalidInput("Attachment storage name is invalid.");
    const path = resolve(this.rootPath, storageFilename);
    const relativePath = relative(this.rootPath, path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw invalidInput("Attachment storage path is invalid.");
    return path;
  }
}
