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
  ".txt": { kind: "log", contentType: "text/plain", acceptedContentTypes: ["text/plain"], maxBytes: 10 * MEBIBYTE },
  ".json": { kind: "log", contentType: "application/json", acceptedContentTypes: ["application/json"], maxBytes: 10 * MEBIBYTE },
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
    const filename = safeFilename(encodedFilename);
    const extension = extname(filename).toLowerCase();
    const rule = RULES[extension];
    if (!rule) throw invalidInput("Unsupported attachment extension.");
    if (bytes.length < 1) throw invalidInput("Attachment cannot be empty.");
    if (bytes.length > rule.maxBytes) throw invalidInput(`Attachment exceeds the ${rule.maxBytes / MEBIBYTE} MiB limit.`);

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

    const normalizedType = suppliedContentType.split(";", 1)[0]!.trim().toLowerCase();
    if (normalizedType && normalizedType !== "application/octet-stream" && !rule.acceptedContentTypes.includes(normalizedType)) {
      throw invalidInput("Attachment content type does not match its filename.");
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
        contentType: normalizedType && normalizedType !== "application/octet-stream" ? normalizedType : rule.contentType,
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
