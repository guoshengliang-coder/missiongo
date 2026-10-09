import { createHash, randomUUID } from "node:crypto";

import type { AgentKind } from "@missiongo/domain";

import type { AgentSessionListItem, AgentSessionSnapshot, AgentSessionStatus } from "./agent-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";

export const EXTERNAL_AGENT_KINDS = ["codex", "claude_code", "opencode", "hermes", "other"] as const;
export const EXTERNAL_PROGRESS_STATUSES = ["working", "waiting_for_input", "blocked", "completed", "failed"] as const;
export type ExternalProgressStatus = typeof EXTERNAL_PROGRESS_STATUSES[number];
export interface ExternalSessionIdentity {
  readonly agentKind: AgentKind | "other";
  /** Native client ID when available; otherwise a stable UUID for this conversation. */
  readonly sessionRef: string;
  readonly refKind: "native" | "tracking";
  readonly name?: string | undefined;
}
export interface ExternalSessionOwner {
  readonly accountId: string;
  readonly clientId?: string;
}
interface SessionRow {
  id: string; account_id: string; client_id: string; agent_kind: AgentKind | "other";
  session_ref: string; ref_kind: "native" | "tracking"; name: string | null;
  progress_status: ExternalProgressStatus; created_at: string; updated_at: string;
  activity_at: string; archived_at: string | null; unread_at: string | null;
  read_at: string | null; dismissed_revision: string | null;
}

/** Explicit, account-scoped progress records. These never create a dispatch or control a local client. */
export class ExternalAgentSessionStore {
  constructor(private readonly store: MissionGoStore) {}
  private get db() { return this.store.database.connection; }

  has(sessionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM external_agent_sessions WHERE id = ?").get(sessionId));
  }

  private row(accountId: string, sessionId: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM external_agent_sessions WHERE id = ? AND account_id = ?")
      .get(sessionId, accountId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Agent session");
    return row;
  }

  itemKeys(accountId: string, sessionId: string): string[] {
    this.row(accountId, sessionId);
    return (this.db.prepare(`SELECT w.item_key FROM external_agent_session_items i
      JOIN work_items w ON w.id = i.item_id WHERE i.session_id = ? ORDER BY i.rowid`)
      .all(sessionId) as unknown as { item_key: string }[]).map((item) => item.item_key);
  }

  /** Check every linked product before returning any conversation content. */
  authorize(owner: ExternalSessionOwner, sessionId: string, itemKey: string, authorizeItem: (key: string) => unknown): void {
    const row = this.row(owner.accountId, sessionId);
    if (row.client_id !== (owner.clientId ?? "")) throw notFound("Agent session");
    const keys = this.itemKeys(owner.accountId, sessionId);
    if (!keys.includes(itemKey.toUpperCase())) throw notFound("Session item");
    keys.forEach(authorizeItem);
  }

  register(owner: ExternalSessionOwner, identity: ExternalSessionIdentity, itemKey: string): string {
    const item = this.store.getWorkItem(itemKey);
    return this.store.database.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM external_agent_sessions
        WHERE account_id = ? AND client_id = ? AND agent_kind = ? AND session_ref = ?`)
        .get(owner.accountId, owner.clientId ?? "", identity.agentKind, identity.sessionRef) as unknown as SessionRow | undefined;
      if (existing && this.db.prepare("SELECT 1 FROM external_agent_session_items WHERE session_id = ? AND item_id = ?").get(existing.id, item.id)) {
        if (existing.ref_kind !== identity.refKind) throw conflict("session_identity_conflict", "The reference kind cannot change.");
        return existing.id;
      }
      if (!["in_progress", "development_complete", "pending_verification"].includes(item.status)) {
        throw conflict("external_session_item_not_in_progress", "Claim the ready item before registering a handling session.");
      }
      if (existing && existing.ref_kind !== identity.refKind) throw conflict("session_identity_conflict", "The reference kind cannot change.");
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      if (!existing) this.db.prepare(`INSERT INTO external_agent_sessions
        (id, account_id, client_id, agent_kind, session_ref, ref_kind, name, progress_status, created_at, updated_at, activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?)`)
        .run(id, owner.accountId, owner.clientId ?? "", identity.agentKind, identity.sessionRef, identity.refKind, identity.name ?? null, now, now, now);
      const inserted = this.db.prepare("INSERT OR IGNORE INTO external_agent_session_items(session_id, item_id) VALUES (?, ?)").run(id, item.id);
      if (inserted.changes) this.report(owner, id, item.key, "working", `开始处理 ${item.key}`, `linked:${item.id}`);
      return id;
    });
  }

  /** Stable fallback for old clients; never present it as a native conversation ID. */
  claimIdentity(agentId: string, key: string): ExternalSessionIdentity {
    const normalized = agentId.trim().toLowerCase().replace(/[ -]/g, "_");
    const kind = EXTERNAL_AGENT_KINDS.find((candidate) => candidate === normalized) ?? "other";
    return { agentKind: kind, sessionRef: `claim:${createHash("sha256").update(key).digest("hex")}`, refKind: "tracking", name: agentId.slice(0, 100) };
  }

  report(owner: ExternalSessionOwner, sessionId: string, itemKey: string, status: ExternalProgressStatus,
    text: string | undefined, idempotencyKey: string): void {
    this.authorize(owner, sessionId, itemKey, () => {});
    this.store.database.transaction(() => {
      const digest = createHash("sha256").update(JSON.stringify({ itemKey, status, text: text ?? null })).digest("hex");
      const prior = this.db.prepare("SELECT digest FROM external_agent_session_reports WHERE session_id = ? AND idempotency_key = ?")
        .get(sessionId, idempotencyKey) as { digest: string } | undefined;
      if (prior) {
        if (prior.digest !== digest) throw conflict("session_report_key_reused", "This report key was already used for different content.");
        return;
      }
      const row = this.row(owner.accountId, sessionId);
      // A monotonic server clock keeps arrivals in the same millisecond unread independently.
      const now = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
      this.db.prepare(`INSERT INTO external_agent_session_reports
        (id, session_id, item_key, status, text, idempotency_key, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), sessionId, itemKey, status, text ?? null, idempotencyKey, digest, now);
      this.db.prepare(`UPDATE external_agent_sessions SET progress_status = ?, updated_at = ?, activity_at = ?, unread_at = ?
        WHERE id = ?`).run(status, now, now, now, sessionId);
    });
  }

  private status(row: SessionRow): AgentSessionStatus {
    if (row.progress_status === "completed") return "idle";
    if (row.progress_status === "failed") return "failed";
    if (Date.now() - Date.parse(row.updated_at) > 30 * 60_000) return "unavailable";
    if (row.progress_status === "working") return "active";
    return "stalled";
  }

  getForAccount(accountId: string, sessionId: string): AgentSessionSnapshot {
    const row = this.row(accountId, sessionId);
    const reports = this.db.prepare("SELECT id, item_key, status, text, created_at FROM external_agent_session_reports WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as unknown as { id: string; item_key: string; status: ExternalProgressStatus; text: string | null; created_at: string }[];
    return {
      id: row.id, source: "external", agentKind: row.agent_kind, status: this.status(row),
      progressStatus: row.progress_status, lastReportedAt: row.updated_at, refKind: row.ref_kind,
      updatedAt: row.updated_at, ...(row.archived_at ? { archivedAt: row.archived_at, archivedSource: "missiongo" as const } : {}),
      messages: reports.map((report) => ({ id: report.id, sourceId: report.id, role: "agent" as const,
        text: `${report.item_key} · ${report.text ?? report.status}`, occurredAt: report.created_at })),
      activities: [], turnState: {}, replyable: false,
    };
  }

  listForAccount(accountId: string, limit = 100): AgentSessionListItem[] {
    const rows = this.db.prepare("SELECT * FROM external_agent_sessions WHERE account_id = ? ORDER BY activity_at DESC, rowid DESC LIMIT ?")
      .all(accountId, limit) as unknown as SessionRow[];
    return rows.map((row) => {
      const latest = this.db.prepare("SELECT id, text, status, item_key FROM external_agent_session_reports WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(row.id) as { id: string; text: string | null; status: ExternalProgressStatus; item_key: string } | undefined;
      const items = this.itemKeys(accountId, row.id).map((key) => this.store.getWorkItem(key));
      const revision = latest?.id;
      const needsAttention = ["waiting_for_input", "blocked", "failed"].includes(row.progress_status)
        && row.dismissed_revision !== revision;
      return {
        id: row.id, source: "external", agentKind: row.agent_kind, status: this.status(row),
        progressStatus: row.progress_status, lastReportedAt: row.updated_at, refKind: row.ref_kind,
        updatedAt: row.updated_at, ...(row.archived_at ? { archivedAt: row.archived_at, archivedSource: "missiongo" as const } : {}),
        replyable: false, activities: [], turnState: {}, agentSessionId: row.id, activityAt: row.activity_at,
        nodeName: row.name ?? row.agent_kind, nodeRevoked: false,
        mode: "external", dispatchStatus: "external", ...(row.name ? { sessionName: row.name } : {}),
        createdAt: row.created_at, items: items.map((item) => ({ key: item.key, title: item.title, productId: item.productId })),
        ...(latest ? { latestMessage: { role: "agent" as const, text: `${latest.item_key} · ${latest.text ?? latest.status}` } } : {}),
        attention: { state: needsAttention ? "needed" : "not_needed", ...(needsAttention ? { kind: "action" as const,
          reason: latest?.text ?? "请在原 Agent 客户端查看并处理。" } : {}),
          ...(revision ? { revision } : {}), ...(row.dismissed_revision === revision ? { dismissed: true } : {}) },
        needsAttention, waitingForReply: needsAttention, retryable: false, stoppable: false,
        settings: { mode: "external", adjustable: false },
        unread: Boolean(row.unread_at && (!row.read_at || row.unread_at > row.read_at)),
        ...(row.unread_at ? { unreadAt: row.unread_at } : {}),
      };
    });
  }

  setArchived(accountId: string, sessionId: string, archived: boolean): void {
    this.row(accountId, sessionId);
    this.db.prepare("UPDATE external_agent_sessions SET archived_at = ? WHERE id = ?")
      .run(archived ? new Date().toISOString() : null, sessionId);
  }

  markRead(accountId: string, sessionId: string, through: string): void {
    const row = this.row(accountId, sessionId);
    if (!Number.isFinite(Date.parse(through)) || new Date(through).toISOString() !== through || !row.unread_at || through > row.unread_at) throw invalidInput("through must name an observed unread timestamp.");
    this.db.prepare("UPDATE external_agent_sessions SET read_at = ? WHERE id = ? AND (read_at IS NULL OR read_at < ?)")
      .run(through, sessionId, through);
  }

  dismissAttention(accountId: string, sessionId: string, revision: string): void {
    const snapshot = this.getForAccount(accountId, sessionId);
    if (snapshot.messages.at(-1)?.id !== revision) throw conflict("agent_attention_changed", "New progress arrived; reload before dismissing.");
    this.db.prepare("UPDATE external_agent_sessions SET dismissed_revision = ? WHERE id = ?").run(revision, sessionId);
  }
}
