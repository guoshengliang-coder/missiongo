import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { validateUpload } from "./attachment-storage.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { invalidInput, notFound } from "./errors.js";

export interface AgentSessionAttachment {
  readonly id: string;
  readonly filename: string;
  readonly kind: "image" | "video" | "document" | "log";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

interface AttachmentRow {
  id: string;
  session_id: string;
  account_id: string;
  command_id: string | null;
  filename: string;
  storage_filename: string;
  kind: AgentSessionAttachment["kind"];
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function publicAttachment(row: AttachmentRow): AgentSessionAttachment {
  return {
    id: row.id, filename: row.filename, kind: row.kind,
    contentType: row.content_type, sizeBytes: row.size_bytes,
    sha256: row.sha256, createdAt: row.created_at,
  };
}

export class AgentSessionAttachments {
  readonly rootPath: string;

  constructor(private readonly database: MissionGoDatabase, rootPath: string) {
    this.rootPath = resolve(rootPath, "agent-sessions");
  }

  async upload(sessionId: string, accountId: string, encodedFilename: string, contentType: string, bytes: Buffer): Promise<AgentSessionAttachment> {
    await this.pruneDrafts();
    const validated = validateUpload(encodedFilename, contentType, bytes);
    const count = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM agent_session_attachments WHERE session_id = ? AND account_id = ? AND command_id IS NULL",
    ).get(sessionId, accountId) as unknown as { count: number };
    if (count.count >= 10) throw invalidInput("A message can have at most 10 attachments.");
    const id = randomUUID();
    const storageFilename = `${id}${validated.extension}`;
    const path = this.resolveStoredFile(storageFilename);
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const createdAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      this.database.connection.prepare(
        `INSERT INTO agent_session_attachments
          (id, session_id, account_id, command_id, filename, storage_filename, kind, content_type, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, sessionId, accountId, validated.filename, storageFilename, validated.rule.kind,
        validated.contentType, bytes.length, sha256, createdAt);
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return { id, filename: validated.filename, kind: validated.rule.kind,
      contentType: validated.contentType, sizeBytes: bytes.length, sha256, createdAt };
  }

  bind(sessionId: string, accountId: string, commandId: string, ids: readonly string[]): readonly AgentSessionAttachment[] {
    if (ids.length > 10 || new Set(ids).size !== ids.length) throw invalidInput("A message can have at most 10 distinct attachments.");
    const rows = ids.map((id) => this.row(sessionId, id));
    if (rows.some((row) => row.account_id !== accountId || row.command_id !== null)) {
      throw invalidInput("Attachments must be unused uploads from this account.");
    }
    const update = this.database.connection.prepare(
      "UPDATE agent_session_attachments SET command_id = ? WHERE id = ? AND session_id = ? AND account_id = ? AND command_id IS NULL",
    );
    rows.forEach((row) => update.run(commandId, row.id, sessionId, accountId));
    return rows.map(publicAttachment);
  }

  listForCommand(commandId: string): readonly AgentSessionAttachment[] {
    return (this.database.connection.prepare(
      "SELECT * FROM agent_session_attachments WHERE command_id = ? ORDER BY created_at, rowid",
    ).all(commandId) as unknown as AttachmentRow[]).map(publicAttachment);
  }

  listForSession(sessionId: string): readonly (AgentSessionAttachment & { readonly commandId: string })[] {
    return (this.database.connection.prepare(
      "SELECT * FROM agent_session_attachments WHERE session_id = ? AND command_id IS NOT NULL ORDER BY created_at, rowid",
    ).all(sessionId) as unknown as AttachmentRow[]).map((row) => ({ ...publicAttachment(row), commandId: row.command_id! }));
  }

  get(sessionId: string, id: string): { readonly attachment: AgentSessionAttachment; readonly path: string; readonly commandId: string | null } {
    const row = this.row(sessionId, id);
    return { attachment: publicAttachment(row), path: this.resolveStoredFile(row.storage_filename), commandId: row.command_id };
  }

  async removeDraft(sessionId: string, accountId: string, id: string): Promise<void> {
    const row = this.row(sessionId, id);
    if (row.account_id !== accountId || row.command_id !== null) throw notFound("Agent session attachment");
    this.database.connection.prepare(
      "DELETE FROM agent_session_attachments WHERE id = ? AND session_id = ? AND account_id = ? AND command_id IS NULL",
    ).run(id, sessionId, accountId);
    await unlink(this.resolveStoredFile(row.storage_filename)).catch(() => undefined);
  }

  private async pruneDrafts(): Promise<void> {
    const before = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const rows = this.database.connection.prepare(
      "SELECT * FROM agent_session_attachments WHERE command_id IS NULL AND created_at < ? LIMIT 100",
    ).all(before) as unknown as AttachmentRow[];
    for (const row of rows) {
      const removed = this.database.connection.prepare(
        "DELETE FROM agent_session_attachments WHERE id = ? AND command_id IS NULL",
      ).run(row.id);
      if (removed.changes) await unlink(this.resolveStoredFile(row.storage_filename)).catch(() => undefined);
    }
  }

  private row(sessionId: string, id: string): AttachmentRow {
    const row = this.database.connection.prepare(
      "SELECT * FROM agent_session_attachments WHERE id = ? AND session_id = ?",
    ).get(id, sessionId) as unknown as AttachmentRow | undefined;
    if (!row) throw notFound("Agent session attachment");
    return row;
  }

  private resolveStoredFile(filename: string): string {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(filename)) throw invalidInput("Attachment storage name is invalid.");
    const path = resolve(this.rootPath, filename);
    if (relative(this.rootPath, path).startsWith("..")) throw invalidInput("Attachment storage path is invalid.");
    return path;
  }
}
