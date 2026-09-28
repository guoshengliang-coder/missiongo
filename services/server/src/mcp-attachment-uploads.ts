import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { extname } from "node:path";

import { conflict, invalidInput, notFound } from "./errors.js";
import { validateUploadMetadata, type AttachmentStorage } from "./attachment-storage.js";
import type { MissionGoStore } from "./store.js";
import type { AttachmentRecord, CreateDerivedWorkItemInput, EventAttribution } from "./types.js";

export const MCP_UPLOAD_CHUNK_BYTES = 512 * 1024;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface UploadRow {
  upload_id: string;
  account_id: string;
  client_id: string;
  product_id: string;
  filename: string;
  content_type: string;
  kind: "image" | "video" | "log" | "document";
  size_bytes: number;
  sha256: string;
  received_bytes: number;
  storage_filename: string;
  expires_at: string;
  consumed_item_key: string | null;
  attachment_id: string | null;
}

interface Owner {
  readonly accountId: string;
  readonly clientId: string;
}

export class McpAttachmentUploads {
  private lastOrphanSweep = 0;

  constructor(private readonly store: MissionGoStore, private readonly storage: AttachmentStorage) {}

  private upload(id: string): UploadRow | undefined {
    return this.store.database.connection.prepare("SELECT * FROM mcp_attachment_uploads WHERE upload_id = ?")
      .get(id) as unknown as UploadRow | undefined;
  }

  private requireOwner(row: UploadRow, owner: Owner, productId: string): void {
    if (row.account_id !== owner.accountId || row.client_id !== owner.clientId || row.product_id !== productId) {
      throw notFound("Attachment upload");
    }
    if (row.expires_at <= new Date().toISOString()) throw conflict("upload_expired", "Attachment upload expired; start again with a new upload ID.");
  }

  /** Remove incomplete uploads after their lease. Consumed files belong to work items. */
  private cleanupExpired(): void {
    const db = this.store.database;
    const expired = db.connection.prepare("SELECT * FROM mcp_attachment_uploads WHERE expires_at <= ?")
      .all(new Date().toISOString()) as unknown as UploadRow[];
    for (const row of expired) {
      if (!row.consumed_item_key) {
        try { unlinkSync(this.storage.resolveStoredFile(row.storage_filename)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      db.connection.prepare("DELETE FROM mcp_attachment_uploads WHERE upload_id = ?").run(row.upload_id);
    }
    // A process can die after writing a new file but before SQLite commits its
    // upload row. Only unreferenced files older than a full upload lease are
    // collected; an in-flight browser upload is always much younger.
    if (Date.now() - this.lastOrphanSweep < 60 * 60 * 1000 || !existsSync(this.storage.rootPath)) return;
    this.lastOrphanSweep = Date.now();
    for (const entry of readdirSync(this.storage.rootPath, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(entry.name)) continue;
      const path = this.storage.resolveStoredFile(entry.name);
      if (statSync(path).mtimeMs > Date.now() - UPLOAD_LIFETIME_MS) continue;
      const referenced = db.connection.prepare("SELECT 1 FROM work_item_attachments WHERE storage_filename = ?").get(entry.name)
        || db.connection.prepare("SELECT 1 FROM mcp_attachment_uploads WHERE storage_filename = ?").get(entry.name);
      if (!referenced) unlinkSync(path);
    }
  }

  stageChunk(input: {
    readonly uploadId: string;
    readonly productId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly offsetBytes: number;
    readonly dataBase64: string;
  }, owner: Owner): { uploadId: string; receivedBytes: number; complete: boolean; expiresAt: string } {
    this.cleanupExpired();
    // The browser sends a URL-encoded filename header; MCP supplies a plain
    // filename. Encode it before applying the exact same validation rules.
    const validated = validateUploadMetadata(encodeURIComponent(input.filename), input.contentType, input.sizeBytes);
    if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw invalidInput("sha256 must be a 64-character hex digest.");
    if (!Number.isSafeInteger(input.offsetBytes) || input.offsetBytes < 0) throw invalidInput("offsetBytes is invalid.");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) {
      throw invalidInput("dataBase64 must be canonical base64.");
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length < 1 || bytes.length > MCP_UPLOAD_CHUNK_BYTES || bytes.toString("base64") !== input.dataBase64) {
      throw invalidInput("Upload chunk must contain 1 to 512 KiB of canonical base64 data.");
    }
    if (input.offsetBytes + bytes.length > input.sizeBytes) throw invalidInput("Upload chunk exceeds declared file size.");
    mkdirSync(this.storage.rootPath, { recursive: true, mode: 0o700 });
    const db = this.store.database;
    let newlyCreatedPath: string | undefined;
    try {
      return db.transaction(() => {
        let row = this.upload(input.uploadId);
        let created = false;
        if (!row) {
          if (input.offsetBytes !== 0) throw conflict("upload_offset_mismatch", "The first chunk must start at byte 0.");
          const pending = db.connection.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
            FROM mcp_attachment_uploads WHERE account_id = ? AND client_id = ? AND consumed_item_key IS NULL`)
            .get(owner.accountId, owner.clientId) as unknown as { count: number; bytes: number };
          if (pending.count >= 20 || pending.bytes + input.sizeBytes > 1024 * 1024 * 1024) {
            throw conflict("upload_quota_reached", "Finish or wait for existing uploads to expire before staging more files.");
          }
          const storageFilename = `${randomUUID()}${extname(validated.filename).toLowerCase()}`;
          const expiresAt = new Date(Date.now() + UPLOAD_LIFETIME_MS).toISOString();
          db.connection.prepare(`INSERT INTO mcp_attachment_uploads
            (upload_id, account_id, client_id, product_id, filename, content_type, kind, size_bytes, sha256,
             received_bytes, storage_filename, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
            input.uploadId, owner.accountId, owner.clientId, input.productId, validated.filename,
            validated.contentType, validated.rule.kind, input.sizeBytes, input.sha256.toLowerCase(),
            storageFilename, expiresAt,
          );
          row = this.upload(input.uploadId)!;
          created = true;
        }
        this.requireOwner(row, owner, input.productId);
        if (row.consumed_item_key) throw conflict("upload_consumed", "This attachment upload is already attached to an item.");
        if (row.filename !== validated.filename || row.content_type !== validated.contentType
          || row.size_bytes !== input.sizeBytes || row.sha256 !== input.sha256.toLowerCase()) {
          throw conflict("upload_id_conflict", "This upload ID was used with different file metadata.");
        }
        const path = this.storage.resolveStoredFile(row.storage_filename);
        if (created) newlyCreatedPath = path;
        let fd: number;
        try {
          fd = openSync(path, created ? "wx+" : "r+", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw conflict("upload_file_missing", "Staged file is missing; start again.");
          throw error;
        }
        try {
          const actual = statSync(path).size;
          if (actual < row.received_bytes) throw conflict("upload_file_short", "Staged file is incomplete; start again.");
          if (actual > row.received_bytes) ftruncateSync(fd, row.received_bytes);
          if (input.offsetBytes < row.received_bytes && input.offsetBytes + bytes.length <= row.received_bytes) {
            const previous = Buffer.alloc(bytes.length);
            readSync(fd, previous, 0, bytes.length, input.offsetBytes);
            if (!previous.equals(bytes)) throw conflict("upload_chunk_conflict", "A different chunk already occupies this offset.");
            return { uploadId: input.uploadId, receivedBytes: row.received_bytes,
              complete: row.received_bytes === row.size_bytes, expiresAt: row.expires_at };
          }
          if (input.offsetBytes !== row.received_bytes) {
            throw conflict("upload_offset_mismatch", `Next chunk must start at byte ${row.received_bytes}.`);
          }
          let written = 0;
          while (written < bytes.length) {
            written += writeSync(fd, bytes, written, bytes.length - written, row.received_bytes + written);
          }
          const received = row.received_bytes + bytes.length;
          if (received === row.size_bytes) {
            const hash = createHash("sha256");
            const block = Buffer.alloc(MCP_UPLOAD_CHUNK_BYTES);
            for (let offset = 0; offset < received; offset += block.length) {
              const count = readSync(fd, block, 0, Math.min(block.length, received - offset), offset);
              hash.update(block.subarray(0, count));
            }
            if (hash.digest("hex") !== row.sha256) {
              ftruncateSync(fd, row.received_bytes);
              throw conflict("upload_digest_mismatch", "The uploaded bytes do not match sha256; retry the final chunk or start again.");
            }
            fsyncSync(fd);
          }
          db.connection.prepare("UPDATE mcp_attachment_uploads SET received_bytes = ? WHERE upload_id = ?")
            .run(received, input.uploadId);
          return { uploadId: input.uploadId, receivedBytes: received, complete: received === row.size_bytes,
            expiresAt: row.expires_at };
        } finally {
          closeSync(fd);
        }
      });
    } catch (error) {
      // SQLite rollback cannot roll back a new file. Keep retries from leaving
      // bytes that have no upload row, including failed digest validation.
      if (newlyCreatedPath && !this.upload(input.uploadId)) {
        try { unlinkSync(newlyCreatedPath); } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      throw error;
    }
  }

  private checkedUploads(ids: readonly string[], owner: Owner, productId: string): UploadRow[] {
    if (ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length) {
      throw invalidInput("Give 1 to 10 distinct attachment upload IDs.");
    }
    return ids.map((id) => {
      const row = this.upload(id);
      if (!row) throw notFound("Attachment upload");
      this.requireOwner(row, owner, productId);
      if (row.consumed_item_key) throw conflict("upload_consumed", "This attachment upload is already attached to an item.");
      if (row.received_bytes !== row.size_bytes) throw conflict("upload_incomplete", "Finish uploading every attachment before attaching it.");
      const path = this.storage.resolveStoredFile(row.storage_filename);
      if (!existsSync(path) || statSync(path).size !== row.size_bytes) {
        throw conflict("upload_file_missing", "Staged file is missing or incomplete; start again.");
      }
      return row;
    });
  }

  private previous(key: string, operation: string, requestHash: string): { item_key: string; attachment_ids_json: string } | undefined {
    const row = this.store.database.connection.prepare("SELECT * FROM mcp_attachment_commits WHERE idempotency_key = ?")
      .get(key) as unknown as { operation: string; request_hash: string; item_key: string; attachment_ids_json: string } | undefined;
    if (row) {
      if (row.operation !== operation || row.request_hash !== requestHash) {
        throw conflict("idempotency_conflict", "This idempotency key was used with different attachment arguments.");
      }
      return row;
    }
    if (this.store.database.connection.prepare("SELECT 1 FROM idempotency_keys WHERE key = ?").get(key)) {
      throw conflict("idempotency_conflict", "This idempotency key was already used for another request.");
    }
    return undefined;
  }

  private attach(row: UploadRow, itemKey: string, attribution: EventAttribution): AttachmentRecord {
    const attachment = this.store.createAttachmentMetadata({
      itemKey, kind: row.kind, filename: row.filename, storageFilename: row.storage_filename,
      contentType: row.content_type, sizeBytes: row.size_bytes, attribution, actorKind: "agent",
    });
    this.store.database.connection.prepare(
      "UPDATE mcp_attachment_uploads SET consumed_item_key = ?, attachment_id = ? WHERE upload_id = ?",
    ).run(itemKey, attachment.id, row.upload_id);
    return attachment;
  }

  createItem(input: CreateDerivedWorkItemInput, uploadIds: readonly string[], owner: Owner, productId: string) {
    this.cleanupExpired();
    const requestHash = createHash("sha256").update(JSON.stringify({ input, uploadIds })).digest("hex");
    return this.store.database.transaction(() => {
      const repeated = this.previous(input.idempotencyKey, "create_item", requestHash);
      if (repeated) return this.store.getWorkItem(repeated.item_key);
      const rows = this.checkedUploads(uploadIds, owner, productId);
      const item = this.store.createDerivedWorkItem(input);
      const attribution: EventAttribution = input.attribution ?? {};
      const attachments = rows.map((row) => this.attach(row, item.key, attribution));
      this.store.database.connection.prepare(`INSERT INTO mcp_attachment_commits
        (idempotency_key, operation, request_hash, item_key, attachment_ids_json) VALUES (?, ?, ?, ?, ?)`).run(
        input.idempotencyKey, "create_item", requestHash, item.key, JSON.stringify(attachments.map((a) => a.id)),
      );
      return this.store.getWorkItem(item.key);
    });
  }

  addToItem(itemKey: string, uploadId: string, idempotencyKey: string, owner: Owner, attribution: EventAttribution) {
    this.cleanupExpired();
    const productId = this.store.getWorkItem(itemKey).productId;
    const requestHash = createHash("sha256").update(JSON.stringify({ itemKey, uploadId })).digest("hex");
    return this.store.database.transaction(() => {
      const repeated = this.previous(idempotencyKey, "add_item_attachment", requestHash);
      if (repeated) return this.store.getAttachmentRecord(itemKey, JSON.parse(repeated.attachment_ids_json)[0] as string);
      const [row] = this.checkedUploads([uploadId], owner, productId);
      const attachment = this.attach(row!, itemKey, attribution);
      this.store.database.connection.prepare(`INSERT INTO mcp_attachment_commits
        (idempotency_key, operation, request_hash, item_key, attachment_ids_json) VALUES (?, ?, ?, ?, ?)`).run(
        idempotencyKey, "add_item_attachment", requestHash, itemKey, JSON.stringify([attachment.id]),
      );
      return attachment;
    });
  }
}
