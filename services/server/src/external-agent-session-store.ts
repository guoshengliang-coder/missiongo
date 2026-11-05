import { assertBuilderExecution, assertExternalExecution } from "./builder-authority.js";
import { createHash, randomUUID } from "node:crypto";

import type { AgentKind } from "@missiongo/domain";

import type { AgentSessionListItem, AgentSessionSnapshot, AgentSessionStatus } from "./agent-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";

export const EXTERNAL_AGENT_KINDS = ["codex", "claude_code", "opencode", "hermes", "other"] as const;
export const EXTERNAL_PROGRESS_STATUSES = ["working", "waiting_for_input", "blocked", "completed", "failed"] as const;
export type ExternalProgressStatus = typeof EXTERNAL_PROGRESS_STATUSES[number];
export interface ExternalSessionIdentity {
  readonly agentKind: AgentKind | "other";
  /** Native client ID when available; otherwise a stable UUID for this conversation. */
  readonly sessionRef: string;
  readonly refKind: "native" | "tracking";
  readonly name?: string | undefined;
  readonly autoConnect?: boolean | undefined;
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

  /** Explicit plan requests may be visible before claiming, without starting an execution. Native discovery uses the existing opt-in channel. */
  prepareApproval(owner: ExternalSessionOwner, identity: ExternalSessionIdentity, keys: readonly string[], revision: string): string {
    return this.store.database.transaction(() => {
      let row = this.db.prepare(`SELECT * FROM external_agent_sessions
        WHERE account_id=? AND client_id=? AND agent_kind=? AND session_ref=?`)
        .get(owner.accountId, owner.clientId ?? "", identity.agentKind, identity.sessionRef) as unknown as SessionRow | undefined;
      if (row) {
        assertExternalExecution(this.store.database, row.id);
        if (row.ref_kind !== identity.refKind || row.archived_at) throw conflict("session_identity_conflict", "Use this conversation's active original identity.");
      }
      for (const key of keys) assertBuilderExecution(this.store.database, this.store.getWorkItem(key).id, owner.accountId);
      const now = new Date().toISOString();
      if (!row) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO external_agent_sessions
          (id,account_id,client_id,agent_kind,session_ref,ref_kind,name,progress_status,created_at,updated_at,activity_at,unread_at)
          VALUES (?,?,?,?,?,?,?,'waiting_for_input',?,?,?,?)`)
          .run(id,owner.accountId,owner.clientId ?? "",identity.agentKind,identity.sessionRef,identity.refKind,identity.name ?? null,now,now,now,now);
        row = this.row(owner.accountId,id);
      }
      if (identity.autoConnect) {
        if (identity.refKind !== "native" || !["codex","claude_code","opencode"].includes(identity.agentKind))
          throw invalidInput("Automatic connection requires a supported native identity.");
        // Discovery only. Preserve an explicit disconnect and never start a CLI.
        this.db.prepare("UPDATE external_agent_sessions SET native_auto_connect=1 WHERE id=? AND native_generation=0").run(row.id);
      }
      const previous = this.db.prepare("SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?")
        .get(owner.accountId,`native:${owner.clientId ?? ""}:${identity.agentKind}:${identity.refKind}:${identity.sessionRef}`) as {revision:string}|undefined;
      if (previous?.revision !== revision) {
        const activityAt = new Date(Math.max(Date.now(),Date.parse(row.updated_at)+1)).toISOString();
        this.db.prepare("UPDATE external_agent_sessions SET updated_at=?,activity_at=?,unread_at=? WHERE id=?").run(activityAt,activityAt,activityAt,row.id);
      }
      for (const key of keys) this.db.prepare(`INSERT OR IGNORE INTO external_agent_session_items(session_id,item_id,link_kind) VALUES (?,?,'approval')`)
        .run(row.id,this.store.getWorkItem(key).id);
      return row.id;
    });
  }

  isHandling(sessionId: string, itemKey: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM external_agent_session_items i JOIN work_items w ON w.id=i.item_id
      WHERE i.session_id=? AND w.item_key=? AND i.link_kind='handling'`).get(sessionId,itemKey));
  }

  register(owner: ExternalSessionOwner, identity: ExternalSessionIdentity, itemKey: string, sessionId?: string): string {
    const item = this.store.getWorkItem(itemKey);
    return this.store.database.transaction(() => {
      assertBuilderExecution(this.store.database,item.id,owner.accountId);
      if (sessionId) assertExternalExecution(this.store.database,sessionId);
      if (identity.autoConnect && (identity.refKind !== "native" || !["codex", "opencode", "claude_code"].includes(identity.agentKind))) {
        throw invalidInput("Automatic connection requires a native Codex, Claude Code or OpenCode session ID.");
      }
      if (sessionId) {
        const previous = this.row(owner.accountId, sessionId);
        this.authorize(owner, sessionId, itemKey, () => {});
        if (previous.agent_kind !== identity.agentKind || identity.refKind !== "native") {
          throw conflict("session_identity_conflict", "Only this conversation's native identity can be attached.");
        }
        if (previous.ref_kind === "native" && previous.session_ref !== identity.sessionRef) {
          throw conflict("session_identity_conflict", "The native conversation cannot change.");
        }
        const duplicate = this.db.prepare("SELECT id FROM external_agent_sessions WHERE account_id=? AND client_id=? AND agent_kind=? AND session_ref=? AND id<>?")
          .get(owner.accountId, owner.clientId ?? "", identity.agentKind, identity.sessionRef, sessionId);
        if (duplicate) throw conflict("session_identity_conflict", "This native conversation already has a record.");
        this.db.prepare("UPDATE external_agent_sessions SET session_ref=?,ref_kind='native',native_auto_connect=CASE WHEN native_generation=0 THEN ? ELSE native_auto_connect END WHERE id=?")
          .run(identity.sessionRef, identity.autoConnect ? 1 : 0, sessionId);
      }
      const existing = this.db.prepare(`SELECT * FROM external_agent_sessions
        WHERE account_id = ? AND client_id = ? AND agent_kind = ? AND session_ref = ?`)
        .get(owner.accountId, owner.clientId ?? "", identity.agentKind, identity.sessionRef) as unknown as SessionRow | undefined;
      if (existing && this.isHandling(existing.id, item.key)) {
        assertExternalExecution(this.store.database, existing.id);
        if (existing.ref_kind !== identity.refKind) throw conflict("session_identity_conflict", "The reference kind cannot change.");
        if (identity.autoConnect) this.db.prepare("UPDATE external_agent_sessions SET native_auto_connect=1 WHERE id=? AND native_generation=0").run(existing.id);
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
      if (identity.autoConnect) this.db.prepare("UPDATE external_agent_sessions SET native_auto_connect=1 WHERE id=? AND native_generation=0").run(id);
      if (existing) assertExternalExecution(this.store.database, existing.id);
      const inserted = this.db.prepare(`INSERT INTO external_agent_session_items(session_id, item_id, link_kind) VALUES (?, ?, 'handling')
        ON CONFLICT(session_id,item_id) DO UPDATE SET link_kind='handling' WHERE link_kind='approval'`).run(id, item.id);
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
    if (!this.isHandling(sessionId,itemKey)) throw conflict("external_session_item_not_in_progress", "Claim this item before reporting handling progress.");
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
    const { nativeMessages, ...native } = new ExternalNativeSessionStore(this.store).overlay(accountId, sessionId);
    const proposal = new ImplementationPlans(this.store.database).proposal(accountId, `native:${row.client_id}:${row.agent_kind}:${row.ref_kind}:${row.session_ref}`);
    const reports = this.db.prepare("SELECT id, item_key, status, text, created_at FROM external_agent_session_reports WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as unknown as { id: string; item_key: string; status: ExternalProgressStatus; text: string | null; created_at: string }[];
    return {
      id: row.id, source: "external", agentKind: row.agent_kind, status: this.status(row),
      progressStatus: row.progress_status, refKind: row.ref_kind,
      approvalOnly: !this.db.prepare("SELECT 1 FROM external_agent_session_items WHERE session_id=? AND link_kind='handling' LIMIT 1").get(sessionId),
      ...(reports.length ? {lastReportedAt:reports.at(-1)!.created_at} : {}),
      updatedAt: row.updated_at, ...(row.archived_at ? { archivedAt: row.archived_at, archivedSource: "missiongo" as const } : {}),
      activities: [], turnState: {},
      ...native,
      messages: [...reports.map((report) => ({ id: report.id, sourceId: report.id, role: "agent" as const,
        text: `${report.item_key} · ${report.text ?? report.status}`, occurredAt: report.created_at })), ...nativeMessages, ...(proposal && !reports.length && !nativeMessages.length ? [{id:`plan:${proposal.revision}`,sourceId:`plan:${proposal.revision}`,role:"plan" as const,text:proposal.plan,occurredAt:row.updated_at}] : [])],
    };
  }

  listForAccount(accountId: string, limit = 100): AgentSessionListItem[] {
    const plans = new ImplementationPlans(this.store.database);
    const requestIdentities = new Set((this.db.prepare("SELECT identity_key FROM implementation_plan_requests WHERE account_id=?").all(accountId) as {identity_key:string}[]).map(row=>row.identity_key));
    const rows = this.db.prepare("SELECT * FROM external_agent_sessions WHERE account_id = ? ORDER BY activity_at DESC, rowid DESC LIMIT ?")
      .all(accountId, limit) as unknown as SessionRow[];
    // AND-383: batch the per-row lookups (latest report, linked items) and
    // reuse one native-session store instead of allocating per row.
    const nativeStore = new ExternalNativeSessionStore(this.store);
    const ids = rows.map((row) => row.id);
    const holes = (values: readonly string[]) => `(${values.map(() => "?").join(",")})`;
    const latestBySession = new Map<string, { id: string; text: string | null; status: ExternalProgressStatus; item_key: string; created_at:string }>();
    const itemsBySession = new Map<string, Array<{ key: string; title: string; productId: string; linkKind:string }>>();
    if (ids.length) {
      const reports = this.db.prepare(`SELECT session_id, id, text, status, item_key, created_at FROM (
        SELECT session_id, id, text, status, item_key, created_at,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, rowid DESC) AS rn
        FROM external_agent_session_reports WHERE session_id IN ${holes(ids)}) WHERE rn = 1`)
        .all(...ids) as unknown as Array<{ session_id: string; id: string; text: string | null; status: ExternalProgressStatus; item_key: string; created_at:string }>;
      for (const report of reports) latestBySession.set(report.session_id, report);
      const items = this.db.prepare(`SELECT i.session_id, w.item_key, w.title, w.product_id, i.link_kind
        FROM external_agent_session_items i JOIN work_items w ON w.id = i.item_id
        WHERE i.session_id IN ${holes(ids)} ORDER BY i.session_id, i.rowid`)
        .all(...ids) as unknown as Array<{ session_id: string; item_key: string; title: string; product_id: string; link_kind:string }>;
      for (const item of items) {
        const list = itemsBySession.get(item.session_id) ?? [];
        itemsBySession.set(item.session_id, list);
        list.push({ key: item.item_key, title: item.title, productId: item.product_id, linkKind:item.link_kind });
      }
    }
    return rows.map((row) => {
      const { nativeMessages, ...native } = nativeStore.overlay(accountId, row.id, false);
      const latest = latestBySession.get(row.id);
      const identity = `native:${row.client_id}:${row.agent_kind}:${row.ref_kind}:${row.session_ref}`;
      const proposal = requestIdentities.has(identity) ? plans.proposal(accountId,identity) : undefined;
      const pendingApproval = proposal && proposal.valid && !proposal.approved;
      const items = itemsBySession.get(row.id) ?? [];
      const revision = latest?.id ?? row.updated_at;
      const needsAttention = ["waiting_for_input", "blocked", "failed"].includes(row.progress_status)
        && row.dismissed_revision !== revision;
      return {
        id: row.id, source: "external", agentKind: row.agent_kind, status: this.status(row),
        progressStatus: row.progress_status, refKind: row.ref_kind, approvalOnly: items.every(item=>item.linkKind === "approval"),
        ...(latest ? {lastReportedAt:latest.created_at} : {}),
        updatedAt: row.updated_at, ...(row.archived_at ? { archivedAt: row.archived_at, archivedSource: "missiongo" as const } : {}),
        activities: [], turnState: {}, agentSessionId: row.id, activityAt: row.activity_at,
        nodeName: row.name ?? row.agent_kind, nodeRevoked: false,
        mode: "external", dispatchStatus: "external", ...(row.name ? { sessionName: row.name } : {}),
        createdAt: row.created_at, items: items.map((item) => ({ key: item.key, title: item.title, productId: item.productId })),
        ...(latest ? { latestMessage: { role: "agent" as const, text: `${latest.item_key} · ${latest.text ?? latest.status}` } } : {}),
        attention: { state: needsAttention ? "needed" : "not_needed", ...(needsAttention ? { kind: latest ? "action" as const : "approval" as const,
          reason: latest?.text ?? "方案等待批准，请审阅当前方案与验证目标。" } : {}),
          ...(revision ? { revision } : {}), ...(row.dismissed_revision === revision ? { dismissed: true } : {}) },
        needsAttention, waitingForReply: needsAttention, retryable: false, stoppable: false,
        unread: Boolean(row.unread_at && (!row.read_at || row.unread_at > row.read_at)),
        ...(row.unread_at ? { unreadAt: row.unread_at } : {}),
        ...native,
        ...(pendingApproval ? {attention:{state:row.dismissed_revision === proposal.revision ? "not_needed" as const : "needed" as const,
          kind:"approval" as const,reason:"方案等待批准，请审阅当前方案与验证目标。",revision:proposal.revision,
          ...(row.dismissed_revision === proposal.revision ? {dismissed:true} : {})},needsAttention:row.dismissed_revision !== proposal.revision,waitingForReply:row.dismissed_revision !== proposal.revision} : {}),
        ...(proposal?.approved && !latest ? {attention:{state:"not_needed" as const},needsAttention:false,waitingForReply:false} : {}),
        ...(nativeMessages.at(-1) ? { latestMessage: { role: nativeMessages.at(-1)!.role, text: nativeMessages.at(-1)!.text } } : {}),
      };
    });
  }

  setArchived(accountId: string, sessionId: string, archived: boolean): void {
    this.row(accountId, sessionId);
    this.db.prepare("UPDATE external_agent_sessions SET archived_at = ?, auto_archive_suppressed = CASE WHEN ? = 0 AND archive_reason = 'auto' THEN 1 ELSE auto_archive_suppressed END, archive_reason = NULL WHERE id = ?")
      .run(archived ? new Date().toISOString() : null, archived ? 1 : 0, sessionId);
    if(archived) this.db.prepare("UPDATE implementation_plan_continuations SET state='cancelled' WHERE account_id=? AND session_id=? AND state='waiting'")
      .run(accountId,sessionId);
  }

  markRead(accountId: string, sessionId: string, through: string): void {
    const row = this.row(accountId, sessionId);
    if (!Number.isFinite(Date.parse(through)) || new Date(through).toISOString() !== through || !row.unread_at || through > row.unread_at) throw invalidInput("through must name an observed unread timestamp.");
    this.db.prepare("UPDATE external_agent_sessions SET read_at = ? WHERE id = ? AND (read_at IS NULL OR read_at < ?)")
      .run(through, sessionId, through);
  }

  dismissAttention(accountId: string, sessionId: string, revision: string): void {
    const native = new ExternalNativeSessionStore(this.store).overlay(accountId, sessionId, false);
    const latest = this.db.prepare("SELECT id FROM external_agent_session_reports WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    const row = this.row(accountId,sessionId);
    const proposal = new ImplementationPlans(this.store.database).proposal(accountId,`native:${row.client_id}:${row.agent_kind}:${row.ref_kind}:${row.session_ref}`);
    const expected = proposal?.valid && !proposal.approved ? proposal.revision : native.attention?.revision ?? latest?.id;
    if (expected !== revision) throw conflict("agent_attention_changed", "New progress arrived; reload before dismissing.");
    this.db.prepare("UPDATE external_agent_sessions SET dismissed_revision = ? WHERE id = ?").run(revision, sessionId);
  }
}
