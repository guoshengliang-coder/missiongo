import { createHash } from "node:crypto";

import { AgentApprovalStore, type AgentApproval } from "./agent-approval-store.js";
import { AgentConsoleSessions } from "./agent-console-sessions.js";
import { AgentSessionAttachments, type AgentSessionAttachment } from "./agent-session-attachments.js";
import { AgentSessionStore, type AgentSessionActivity, type AgentSessionListItem, type AgentSessionStatus, type AgentSessionTurnState } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { invalidInput, notFound } from "./errors.js";
import { ImplementationPlans } from "./implementation-plans.js";
import { PlanApprovalService, type PlanApprovalStatusCode } from "./plan-approval.js";
import type { MissionGoStore } from "./store.js";

export type SessionRecordSource = "dispatch" | "project" | "external";
export type SessionContentAvailability = "synced" | "progress_only" | "not_started";
export type SessionRecordKind = "agent_session" | "external_session" | "dispatch";

export interface SessionRecordView {
  /** Read ID for get_agent_session: an agent-session or external-session UUID, or `dispatch:<id>` before any native session exists. */
  readonly id: string;
  readonly recordKind: SessionRecordKind;
  readonly source: SessionRecordSource;
  readonly agentKind: string;
  readonly refKind?: "native" | "tracking";
  readonly dispatchId?: string;
  /** Which handling round of the linked items this dispatch is. */
  readonly round?: number;
  readonly status: AgentSessionStatus;
  readonly progressStatus?: string;
  readonly dispatchStatus?: string;
  /** Present only for project conversations (free session starts). */
  readonly productId?: string;
  readonly sessionName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activityAt: string;
  readonly archivedAt?: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly nodeConnectionState?: string;
  readonly nodeRevoked?: boolean;
  readonly contentAvailability: SessionContentAvailability;
  readonly lastSyncedAt?: string;
  readonly knownGaps: readonly string[];
}

export interface ItemConversationView {
  /** Preferred read ID for get_agent_session. */
  readonly sessionId: string;
  readonly agentKind: string;
  readonly status: AgentSessionStatus;
  readonly round?: number;
  readonly activityAt: string;
  readonly items: readonly { key: string; title: string; productId: string }[];
  readonly records: readonly SessionRecordView[];
  readonly contentAvailability: SessionContentAvailability;
  readonly lastSyncedAt?: string;
}

export type SessionMessageSource = "dispatch_sync" | "native_sync" | "progress_report";

export interface SessionQuestionView {
  readonly header?: string;
  readonly title: string;
  readonly detail?: string;
  readonly options?: readonly string[];
  readonly multiSelect?: boolean;
  readonly key?: string;
  readonly kind?: "text" | "number" | "boolean";
  readonly placeholder?: string;
  readonly custom?: boolean;
  readonly answered?: string;
  readonly withdrawn?: boolean;
}

export interface SessionMessageView {
  /** Stable server-side record ID; survives pagination and re-reads. */
  readonly id: string;
  /** The source client's own message ID, when the message was synchronized from a native transcript. */
  readonly sourceId?: string;
  readonly recordId: string;
  readonly recordSource: SessionMessageSource;
  readonly role: "user" | "agent" | "plan";
  readonly turnId?: string;
  readonly phase?: string;
  readonly text: string;
  readonly occurredAt?: string;
  readonly questions?: readonly SessionQuestionView[];
  /** Progress-report messages only. */
  readonly progressStatus?: string;
  readonly progressItemKey?: string;
}

export interface SessionAttachmentView extends AgentSessionAttachment {
  readonly recordId: string;
  readonly commandId?: string;
  readonly command?: { readonly text: string; readonly status: string; readonly createdAt: string };
}

export interface SessionAttachmentFile {
  readonly attachment: AgentSessionAttachment;
  readonly path: string;
  readonly recordId: string;
  readonly commandId: string | null;
}

export interface ReadConversationResult {
  readonly sessionId: string;
  readonly agentKind: string;
  readonly source: SessionRecordSource;
  readonly status: AgentSessionStatus;
  readonly round?: number;
  readonly archivedAt?: string;
  readonly items: readonly { key: string; title: string; productId: string }[];
  readonly records: readonly SessionRecordView[];
  readonly completeness: {
    readonly contentAvailability: SessionContentAvailability;
    readonly lastSyncedAt?: string;
    readonly snapshotTakenAt: string;
    readonly messageCount: number;
    /** sha256 over the ordered message IDs; a change means messages were appended or updated and the read must restart. */
    readonly consistencyDigest: string;
    readonly truncated: boolean;
    readonly knownGaps: readonly string[];
  };
  readonly messages: readonly SessionMessageView[];
  readonly nextOffset?: number;
  readonly activities: readonly AgentSessionActivity[];
  readonly turnState?: AgentSessionTurnState;
  readonly attachments: readonly SessionAttachmentView[];
}

/** A persisted implementation-plan record for one conversation identity (AND-400). */
export interface PlanApprovalRecordView {
  /** Conversation identity the record is keyed by: `dispatch:<id>` or `native:<client>:<kind>:<refKind>:<ref>`. */
  readonly identity: string;
  /** Current request revision; approvals for older revisions are superseded. */
  readonly revision: string;
  readonly keys: readonly string[];
  readonly plan: string;
  readonly validation: string;
  /** Latest approval written for this identity, when one exists. */
  readonly approval?: {
    readonly revision: string;
    /** False when a newer request revision superseded this approval. */
    readonly current: boolean;
    readonly planHash: string;
    readonly source: "web" | "native";
    readonly approvedAt: string;
    readonly commandId?: string;
    readonly recovery?: {
      readonly previousRevision: string;
      readonly sessionId: string;
      readonly planSourceId: string;
      readonly acceptanceSourceId: string;
      readonly nativeAcceptedAt: string;
      readonly recoveredAt: string;
      readonly resume?: {readonly state:string;readonly requestedAt:string;readonly commandId:string|null;readonly queuedAt:string|null};
    };
  };
  /** True only when a current-revision approval exists and the frozen scope still matches the items. */
  readonly approved: boolean;
  /** False when the item versions or boundaries moved past the frozen scope. */
  readonly scopeValid: boolean;
}

export interface PlanApprovalConversationInfo {
  readonly sessionId: string;
  readonly agentKind: string;
  readonly source: SessionRecordSource;
  /** Linked items, so the caller can enforce product scope before showing anything. */
  readonly items: readonly { key: string; productId: string }[];
  /** The newest plan message in the merged transcript, as a traceable reference. */
  readonly latestPlan?: { readonly messageId: string; readonly sourceId?: string; readonly occurredAt?: string; readonly digest: string };
  /** Live assessment of the conversation's approval state. An assessment, never a record of approval. */
  readonly assessment: { readonly code: PlanApprovalStatusCode; readonly reason?: string; readonly revision?: string };
  /** Codex source permission request, when one is open or recent. A different concept from plan approval. */
  readonly toolPermissionApproval?: { readonly kind: "manual" | "auto"; readonly status: string; readonly action: string; readonly reason?: string; readonly decision?: string };
  readonly formalRecords: {
    readonly available: boolean;
    readonly records?: readonly PlanApprovalRecordView[];
    /** Present when no persisted record exists for this conversation. */
    readonly note?: string;
  };
}

interface DispatchMessageRow {
  id: string; source_id: string; turn_id: string | null; role: "user" | "agent" | "plan";
  phase: string | null; text: string; questions_json: string | null; occurred_at: string;
}
interface NativeMessageRow { id: string; source_id: string; payload_json: string }
interface ProgressReportRow { id: string; item_key: string; status: string; text: string | null; created_at: string }
interface AttachmentRow {
  id: string; command_id: string | null; filename: string; kind: AgentSessionAttachment["kind"];
  content_type: string; size_bytes: number; sha256: string; created_at: string;
}
interface CommandRow { id: string; text: string; status: string; created_at: string }

const MAX_CONVERSATION_MESSAGES = 10_000;

const FORMAL_RECORDS_NOTE = "No persisted implementation-plan record exists for this conversation. "
  + "Nothing in this result proves approval; never report a plan as approved based on a comment, a chat reply, "
  + "a mode change, or transcript text.";

const AVAILABILITY_RANK: Record<SessionContentAvailability, number> = { synced: 2, progress_only: 1, not_started: 0 };

function recordView(row: AgentSessionListItem): SessionRecordView {
  const external = row.source === "external";
  const recordKind: SessionRecordKind = external ? "external_session" : row.agentSessionId ? "agent_session" : "dispatch";
  const source: SessionRecordSource = external ? "external" : row.productId ? "project" : "dispatch";
  const knownGaps: string[] = [];
  let contentAvailability: SessionContentAvailability;
  let lastSyncedAt: string | undefined;
  if (external) {
    const connection = row.nativeConnection;
    lastSyncedAt = connection?.lastSyncedAt;
    if (row.refKind !== "native") {
      contentAvailability = "progress_only";
      knownGaps.push("This conversation was registered as tracking only; progress reports exist but no transcript, plan text or execution records are synchronized.");
    } else if (lastSyncedAt) {
      contentAvailability = "synced";
    } else {
      contentAvailability = "progress_only";
      knownGaps.push("This native conversation has not synchronized any messages from a node yet; only progress reports are available.");
    }
    if (connection && connection.state !== "connected") {
      knownGaps.push(`The native connection is ${connection.state}${connection.nodeName ? ` (node ${connection.nodeName})` : ""}; stored records reflect the last successful sync and cannot confirm current native state.`);
    }
  } else if (row.agentSessionId) {
    contentAvailability = "synced";
    if (row.nodeRevoked) knownGaps.push("The node that runs this conversation has been revoked; its records stopped updating at that point.");
    else if (row.nodeConnectionState && row.nodeConnectionState !== "online") knownGaps.push(`The node that runs this conversation is ${row.nodeConnectionState}; records reflect its last report.`);
  } else {
    contentAvailability = "not_started";
    knownGaps.push(source === "project"
      ? "This project conversation has not reported a native session yet; no transcript exists."
      : "This dispatch has not reported a native session yet; no transcript exists.");
  }
  if (row.archivedAt) knownGaps.push(`The conversation was archived at ${row.archivedAt}; its records are historical.`);
  return {
    id: recordKind === "dispatch" ? `dispatch:${row.dispatchId}` : row.id,
    recordKind, source,
    agentKind: row.agentKind,
    ...(row.refKind ? { refKind: row.refKind } : {}),
    ...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
    ...(row.round ? { round: row.round } : {}),
    status: row.status,
    ...(row.progressStatus ? { progressStatus: row.progressStatus } : {}),
    ...(row.dispatchStatus ? { dispatchStatus: row.dispatchStatus } : {}),
    ...(row.productId ? { productId: row.productId } : {}),
    ...(row.sessionName ? { sessionName: row.sessionName } : {}),
    createdAt: row.createdAt, updatedAt: row.updatedAt, activityAt: row.activityAt,
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    ...(row.nodeId ? { nodeId: row.nodeId } : {}),
    ...(row.nodeName ? { nodeName: row.nodeName } : {}),
    ...(row.nodeConnectionState ? { nodeConnectionState: row.nodeConnectionState } : {}),
    ...(row.nodeRevoked === true ? { nodeRevoked: true } : {}),
    contentAvailability,
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    knownGaps,
  };
}

function conversationView(summary: AgentSessionListItem, members: readonly AgentSessionListItem[]): ItemConversationView {
  const records = members.map(recordView);
  // External list rows reuse their own ID as agentSessionId (console archive
  // routing), so dispatch-ness must come from `source`, never from the ID.
  const preferred = members.find((row) => row.source !== "external" && row.agentSessionId)
    ?? members.find((row) => row.agentSessionId)
    ?? members[0]!;
  const best = records.reduce((a, b) => (AVAILABILITY_RANK[b.contentAvailability] > AVAILABILITY_RANK[a.contentAvailability] ? b : a));
  const lastSyncedAt = records.flatMap((record) => record.lastSyncedAt ? [record.lastSyncedAt] : []).sort().at(-1);
  return {
    sessionId: preferred.agentSessionId ?? preferred.id,
    agentKind: summary.agentKind,
    status: summary.status,
    ...(summary.round ? { round: summary.round } : {}),
    activityAt: summary.activityAt,
    items: summary.items,
    records,
    contentAvailability: best.contentAvailability,
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
  };
}

/** Read-only projections over the conversation storage the console already uses. */
export class McpAgentSessionReads {
  private readonly dispatch: AgentSessionStore;
  private readonly external: ExternalAgentSessionStore;
  private readonly console: AgentConsoleSessions;
  private readonly approvals: AgentApprovalStore;
  private readonly plans: ImplementationPlans;
  private readonly sessionAttachments: AgentSessionAttachments;
  private readonly externalAttachments: AgentSessionAttachments;

  constructor(
    private readonly store: MissionGoStore,
    attachmentsRoot: string,
    private readonly planApprovalService: PlanApprovalService = new PlanApprovalService(),
  ) {
    this.dispatch = new AgentSessionStore(store.database);
    this.external = new ExternalAgentSessionStore(store);
    this.console = new AgentConsoleSessions(store, this.dispatch, this.external);
    this.approvals = new AgentApprovalStore(store.database);
    this.plans = new ImplementationPlans(store.database);
    this.sessionAttachments = new AgentSessionAttachments(store.database, attachmentsRoot);
    this.externalAttachments = new AgentSessionAttachments(store.database, attachmentsRoot, true);
  }

  /** Conversations verifiably linked to one item. Authorization over every linked product is the caller's. */
  listConversations(accountId: string, itemKey: string): readonly ItemConversationView[] {
    return this.console.listForItem(accountId, itemKey)
      .map(({ summary, members }) => conversationView(summary, members));
  }

  /** Resolve one conversation for reading. With itemKey the conversation must be linked to that item; without it, it must be a project conversation. */
  readConversation(accountId: string, sessionId: string, options: {
    itemKey?: string; offset?: number; limit?: number;
  } = {}): ReadConversationResult {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const { summary, members } = this.resolveConversation(accountId, sessionId, options.itemKey);
    const orderedMembers = [...members].sort((a, b) => Number(b.id === sessionId) - Number(a.id === sessionId)
      || Number(Boolean(b.agentSessionId)) - Number(Boolean(a.agentSessionId)));
    const messages = this.mergedMessages(orderedMembers);
    const truncated = messages.length > MAX_CONVERSATION_MESSAGES;
    const bounded = truncated ? messages.slice(0, MAX_CONVERSATION_MESSAGES) : messages;
    const consistencyDigest = createHash("sha256").update(JSON.stringify(bounded.map((message) => message.id))).digest("hex");
    const page = bounded.slice(offset, offset + limit);
    const nextOffset = offset + page.length < bounded.length ? offset + page.length : undefined;
    const records = members.map(recordView);
    const best = records.reduce((a, b) => (AVAILABILITY_RANK[b.contentAvailability] > AVAILABILITY_RANK[a.contentAvailability] ? b : a));
    const lastSyncedAt = records.flatMap((record) => record.lastSyncedAt ? [record.lastSyncedAt] : []).sort().at(-1);
    const knownGaps = [...new Set(records.flatMap((record) => record.knownGaps))];
    if (members.some(member => this.store.database.connection.prepare(
      "SELECT 1 FROM agent_history_sources WHERE account_id=? AND session_id=? AND (next_id IS NOT NULL OR error IS NOT NULL)",
    ).get(accountId, member.agentSessionId ?? member.id))) {
      knownGaps.push("This native conversation has a bounded history window or an incomplete source read. Earlier messages may require interactive pagination in MissionGo or reading the original client; this response does not prove the full native history was read.");
    }
    if (truncated) knownGaps.push(`Only the newest ${MAX_CONVERSATION_MESSAGES} messages were read; the full native history is longer.`);
    const primary = orderedMembers[0]!;
    const snapshot = primary.source === "external"
      ? this.external.getForAccount(accountId, primary.id)
      : primary.agentSessionId
        ? this.dispatch.getForAccount(accountId, primary.agentSessionId)
        : undefined;
    return {
      sessionId: primary.agentSessionId ?? primary.id,
      agentKind: summary.agentKind,
      source: primary.source === "external" ? "external" : primary.productId ? "project" : "dispatch",
      status: summary.status,
      ...(summary.round ? { round: summary.round } : {}),
      ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : {}),
      items: summary.items,
      records,
      completeness: {
        contentAvailability: best.contentAvailability,
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
        snapshotTakenAt: new Date().toISOString(),
        messageCount: bounded.length,
        consistencyDigest,
        truncated,
        knownGaps,
      },
      messages: page,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      activities: snapshot?.activities ?? [],
      ...(snapshot ? { turnState: snapshot.turnState } : {}),
      attachments: this.attachments(orderedMembers),
    };
  }

  /** Protected read of one session attachment's stored file. Authorization over the conversation is the caller's. */
  attachmentFile(accountId: string, sessionId: string, attachmentId: string, itemKey?: string): SessionAttachmentFile {
    const { members } = this.resolveConversation(accountId, sessionId, itemKey);
    for (const member of members) {
      if (member.source === "external") {
        const found = this.tryAttachment(this.externalAttachments, member.id, attachmentId);
        if (found) return { ...found, recordId: member.id };
      } else if (member.agentSessionId) {
        const found = this.tryAttachment(this.sessionAttachments, member.agentSessionId, attachmentId);
        if (found) return { ...found, recordId: member.agentSessionId };
      }
    }
    throw notFound("Session attachment");
  }

  private tryAttachment(store: AgentSessionAttachments, sessionId: string, attachmentId: string):
    Omit<SessionAttachmentFile, "recordId"> | undefined {
    try {
      const found = store.get(sessionId, attachmentId);
      return { attachment: found.attachment, path: found.path, commandId: found.commandId };
    } catch {
      return undefined;
    }
  }

  /** Plan and approval state for every linked conversation that has a readable record. */
  planApprovalInfos(accountId: string, itemKey: string): readonly PlanApprovalConversationInfo[] {
    return this.console.listForItem(accountId, itemKey).flatMap(({ summary, members }) => {
      const live = members.find((row) => row.source !== "external" && row.agentSessionId)
        ?? members.find((row) => row.source === "external")
        ?? members.find((row) => row.agentSessionId);
      if (!live) return [];
      const external = live.source === "external";
      const readId = external ? live.id : live.agentSessionId!;
      const snapshot = external
        ? this.external.getForAccount(accountId, readId)
        : this.dispatch.getForAccount(accountId, readId);
      const orderedMembers = [...members].sort((a, b) => Number(b.id === readId) - Number(a.id === readId)
        || Number(Boolean(b.agentSessionId)) - Number(Boolean(a.agentSessionId)));
      const messages = this.mergedMessages(orderedMembers);
      const withAttention = this.approvals.withAttention(this.console.getSummary(accountId, readId));
      const pendingReply = members.some((row) => row.command && ["queued", "delivering", "delivery_unknown"].includes(row.command.status));
      let unavailableReason: "connection_unavailable" | "reply_pending" | undefined = pendingReply ? "reply_pending" : undefined;
      if (!unavailableReason) {
        if (external) {
          if (summary.nativeConnection?.state !== "connected") unavailableReason = "connection_unavailable";
        } else if (summary.nodeRevoked || (summary.nodeConnectionState && summary.nodeConnectionState !== "online")) {
          unavailableReason = "connection_unavailable";
        }
      }
      const assessment = this.planApprovalService.assess({
        ...snapshot,
        // Progress reports have no source-native ID; a stable synthetic one keeps
        // the assessment's revision hashing deterministic.
        messages: messages.map((message) => ({
          id: message.id,
          sourceId: message.sourceId ?? `progress:${message.id}`,
          role: message.role,
          text: message.text,
          ...(message.turnId ? { turnId: message.turnId } : {}),
          ...(message.phase ? { phase: message.phase } : {}),
          ...(message.occurredAt ? { occurredAt: message.occurredAt } : {}),
          ...(message.questions ? { questions: message.questions } : {}),
        })),
        attention: withAttention.attention,
        ...(withAttention.approval ? { approval: withAttention.approval } : {}),
        canReply: external ? snapshot.replyable : snapshot.replyable && !snapshot.managedExecution,
      }, unavailableReason);
      const latestPlan = [...messages].reverse().find((message) => message.role === "plan");
      const permission = toolPermission(withAttention.approval);
      return [{
        sessionId: readId,
        agentKind: summary.agentKind,
        source: external ? "external" : live.productId ? "project" : "dispatch",
        items: summary.items.map((item) => ({ key: item.key, productId: item.productId })),
        ...(latestPlan ? { latestPlan: {
          messageId: latestPlan.id,
          ...(latestPlan.sourceId ? { sourceId: latestPlan.sourceId } : {}),
          ...(latestPlan.occurredAt ? { occurredAt: latestPlan.occurredAt } : {}),
          digest: createHash("sha256").update(latestPlan.text).digest("hex"),
        } } : {}),
        assessment: { code: assessment.status.code, ...(assessment.offer?.reason ? { reason: assessment.offer.reason } : {}), ...(assessment.offer ? { revision: assessment.offer.revision } : {}) },
        ...(permission ? { toolPermissionApproval: permission } : {}),
        formalRecords: this.implementationPlanRecords(accountId, members),
      }];
    });
  }

  /**
   * Persisted implementation-plan records (AND-400) for every identity this
   * conversation can have: `dispatch:<id>` for dispatch/project members, and the
   * writer's native identity for external members. External identities embed the
   * writing OAuth client, which a reader cannot know, so they are matched by
   * their stable agent/ref suffix instead of guessing.
   */
  private implementationPlanRecords(accountId: string, members: readonly AgentSessionListItem[]): PlanApprovalConversationInfo["formalRecords"] {
    const db = this.store.database.connection;
    const dispatchIdentities = new Set(members
      .filter((row) => row.source !== "external" && row.dispatchId)
      .map((row) => `dispatch:${row.dispatchId}`));
    const externalIdentity = (id: string) => db.prepare("SELECT agent_kind, session_ref, ref_kind FROM external_agent_sessions WHERE id=?").get(id) as
      { agent_kind: string; session_ref: string; ref_kind: string } | undefined;
    const nativeSuffixes = members
      .filter((row) => row.source === "external")
      .map((row) => externalIdentity(row.id))
      .filter((row): row is NonNullable<ReturnType<typeof externalIdentity>> => Boolean(row))
      .map((row) => `:${row.agent_kind}:${row.ref_kind}:${row.session_ref}`);
    const requests = db.prepare("SELECT identity_key, revision, proposal_json, scope_json FROM implementation_plan_requests WHERE account_id=?")
      .all(accountId) as Array<{ identity_key: string; revision: string; proposal_json: string | null; scope_json: string | null }>;
    const matched = requests.filter((request) => dispatchIdentities.has(request.identity_key)
      || (request.identity_key.startsWith("native:") && nativeSuffixes.some((suffix) => request.identity_key.endsWith(suffix))));
    if (!matched.length) return { available: false, note: FORMAL_RECORDS_NOTE };
    const records = matched.map((request) => {
      const approval = db.prepare(`SELECT revision, plan_hash, scope_json, plan_text, validation_text, source, command_id, approved_at
        FROM implementation_plan_approvals WHERE account_id=? AND identity_key=? ORDER BY approved_at DESC, rowid DESC LIMIT 1`)
        .get(accountId, request.identity_key) as {
        revision: string; plan_hash: string; scope_json: string; plan_text: string; validation_text: string;
        source: "web" | "native"; command_id: string | null; approved_at: string;
      } | undefined;
      const proposal = request.proposal_json ? JSON.parse(request.proposal_json) as { keys: string[]; plan: string; validation: string } | null : null;
      const recovery = db.prepare(`SELECT previous_revision AS previousRevision,session_id AS sessionId,
        plan_source_id AS planSourceId,acceptance_source_id AS acceptanceSourceId,
        native_accepted_at AS nativeAcceptedAt,recovered_at AS recoveredAt FROM implementation_plan_recoveries
        WHERE account_id=? AND identity_key=? AND revision=?`).get(accountId,request.identity_key,approval?.revision ?? "") as
        NonNullable<PlanApprovalRecordView["approval"]>["recovery"] | undefined;
      const resume = recovery ? db.prepare(`SELECT state,requested_at AS requestedAt,command_id AS commandId,queued_at AS queuedAt
        FROM implementation_plan_recovery_resumes WHERE account_id=? AND identity_key=? AND revision=?`)
        .get(accountId,request.identity_key,approval!.revision) as NonNullable<NonNullable<PlanApprovalRecordView['approval']>['recovery']>['resume']|undefined : undefined;
      const scopeJson = request.scope_json ?? approval?.scope_json ?? "[]";
      const keys = (JSON.parse(scopeJson) as Array<{ key: string }>).map((entry) => entry.key);
      let scopeValid = false;
      try { scopeValid = this.plans.scope(keys) === scopeJson; } catch { /* A scoped item disappearing invalidates the frozen scope. */ }
      let approved = false;
      if (scopeValid) {
        try { approved = this.plans.approved(accountId, request.identity_key, request.revision); } catch { approved = false; }
      }
      return {
        identity: request.identity_key,
        revision: request.revision,
        keys,
        plan: proposal?.plan ?? approval?.plan_text ?? "",
        validation: proposal?.validation ?? approval?.validation_text ?? "",
        ...(approval ? { approval: {
          revision: approval.revision,
          current: approval.revision === request.revision,
          planHash: approval.plan_hash,
          source: approval.source,
          approvedAt: approval.approved_at,
          ...(approval.command_id ? { commandId: approval.command_id } : {}),
          ...(recovery ? { recovery:{...recovery,...(resume ? {resume} : {})} } : {}),
        } } : {}),
        approved,
        scopeValid,
      };
    });
    return { available: true, records };
  }

  /** Resolve one conversation ID for the MCP layer: linkage validation plus every product the conversation spans. */
  resolveForRead(accountId: string, sessionId: string, itemKey?: string): { summary: AgentSessionListItem; members: readonly AgentSessionListItem[]; productIds: readonly string[] } {
    let members: readonly AgentSessionListItem[];
    try {
      members = this.console.members(accountId, sessionId);
    } catch {
      throw notFound("Agent session");
    }
    const summary = this.console.getSummary(accountId, sessionId);
    if (itemKey) {
      const key = itemKey.toUpperCase();
      if (!summary.items.some((item) => item.key === key)) throw notFound("Session item");
    } else if (!members.some((row) => row.productId)) {
      throw invalidInput(
        "Reading a conversation requires the item key it was linked through; only explicitly specified project conversations can be read without one.",
        "conversation_item_key_required",
      );
    }
    const productIds = [...new Set([
      ...members.flatMap((row) => row.productId ? [row.productId] : []),
      ...summary.items.map((item) => item.productId),
    ])];
    return { summary, members, productIds };
  }

  private resolveConversation(accountId: string, sessionId: string, itemKey?: string): { summary: AgentSessionListItem; members: readonly AgentSessionListItem[] } {
    const { summary, members } = this.resolveForRead(accountId, sessionId, itemKey);
    return { summary, members };
  }

  private mergedMessages(members: readonly AgentSessionListItem[]): SessionMessageView[] {
    const db = this.store.database.connection;
    const messages: SessionMessageView[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      if (member.source === "external") {
        const reports = db.prepare("SELECT id, item_key, status, text, created_at FROM external_agent_session_reports WHERE session_id = ? ORDER BY created_at, rowid")
          .all(member.id) as unknown as ProgressReportRow[];
        for (const report of reports) {
          messages.push({
            id: report.id, recordId: member.id, recordSource: "progress_report", role: "agent",
            text: report.text ?? report.status, occurredAt: report.created_at,
            progressStatus: report.status, progressItemKey: report.item_key,
          });
        }
        const native = db.prepare("SELECT id, source_id, payload_json FROM external_native_messages WHERE session_id = ? AND COALESCE(json_extract(payload_json,'$.phase'),'') <> 'execution' ORDER BY position, rowid")
          .all(member.id) as unknown as NativeMessageRow[];
        for (const row of native) {
          const payload = JSON.parse(row.payload_json) as {
            role: "user" | "agent" | "plan"; text: string; occurredAt?: string; turnId?: string; phase?: string; questions?: readonly SessionQuestionView[];
          };
          const key = JSON.stringify([payload.role, row.source_id]);
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push({
            id: row.id, sourceId: row.source_id, recordId: member.id, recordSource: "native_sync", role: payload.role, text: payload.text,
            ...(payload.turnId ? { turnId: payload.turnId } : {}), ...(payload.phase ? { phase: payload.phase } : {}),
            ...(payload.occurredAt ? { occurredAt: payload.occurredAt } : {}),
            ...(payload.questions ? { questions: payload.questions } : {}),
          });
        }
      } else if (member.agentSessionId) {
        const rows = db.prepare(`SELECT id, source_id, turn_id, role, phase, text, questions_json, occurred_at
          FROM agent_session_messages WHERE session_id = ? AND (phase IS NULL OR phase <> 'execution') ORDER BY position, observed_at, rowid`)
          .all(member.agentSessionId) as unknown as DispatchMessageRow[];
        for (const row of rows) {
          const key = JSON.stringify([row.role, row.source_id]);
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push({
            id: row.id, sourceId: row.source_id, recordId: member.agentSessionId!, recordSource: "dispatch_sync", role: row.role, text: row.text,
            ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.phase ? { phase: row.phase } : {}),
            occurredAt: row.occurred_at,
            ...(row.questions_json ? { questions: JSON.parse(row.questions_json) as readonly SessionQuestionView[] } : {}),
          });
        }
      }
    }
    return messages
      .map((message, index) => ({ message, index }))
      .sort((a, b) => (a.message.occurredAt ?? "").localeCompare(b.message.occurredAt ?? "") || a.index - b.index)
      .map(({ message }) => message);
  }

  private attachments(members: readonly AgentSessionListItem[]): SessionAttachmentView[] {
    const db = this.store.database.connection;
    const result: SessionAttachmentView[] = [];
    for (const member of members) {
      const external = member.source === "external";
      const recordId = external ? member.id : member.agentSessionId;
      if (!recordId) continue;
      const table = external ? "external_session_attachments" : "agent_session_attachments";
      const rows = db.prepare(`SELECT id, command_id, filename, kind, content_type, size_bytes, sha256, created_at
        FROM ${table} WHERE session_id = ? AND command_id IS NOT NULL ORDER BY created_at, rowid`)
        .all(recordId) as unknown as AttachmentRow[];
      if (!rows.length) continue;
      const commandTable = external ? "external_native_commands" : "agent_session_commands";
      const commandRows = db.prepare(`SELECT id, text, status, created_at FROM ${commandTable} WHERE id IN (${rows.map(() => "?").join(",")})`)
        .all(...rows.map((row) => row.command_id)) as unknown as CommandRow[];
      const commands = new Map(commandRows.map((command) => [command.id, command]));
      for (const row of rows) {
        const command = row.command_id ? commands.get(row.command_id) : undefined;
        result.push({
          id: row.id, filename: row.filename, kind: row.kind, contentType: row.content_type,
          sizeBytes: row.size_bytes, sha256: row.sha256, createdAt: row.created_at, recordId,
          ...(row.command_id ? { commandId: row.command_id } : {}),
          ...(command ? { command: { text: command.text, status: command.status, createdAt: command.created_at } } : {}),
        });
      }
    }
    return result;
  }
}

function toolPermission(approval: AgentApproval | undefined): { kind: "manual" | "auto"; status: string; action: string; reason?: string; decision?: string } | undefined {
  if (!approval) return undefined;
  return {
    kind: approval.kind, status: approval.status, action: approval.action,
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(approval.decision ? { decision: approval.decision } : {}),
  };
}
