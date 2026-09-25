import type { AgentKind, DispatchStatus } from "@missiongo/domain";

export const ITEM_TYPES = ["bug", "requirement", "idea", "task", "note"] as const;
export type WorkItemType = (typeof ITEM_TYPES)[number];

export const ITEM_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type WorkItemPriority = (typeof ITEM_PRIORITIES)[number];

export const ITEM_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
  "development_complete",
  "on_hold",
  "pending_verification",
  "done",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof ITEM_STATUSES)[number];

export const OCCURRENCE_FREQUENCIES = ["unknown", "once", "intermittent", "frequent", "always"] as const;
export type WorkItemOccurrenceFrequency = (typeof OCCURRENCE_FREQUENCIES)[number];

export interface WorkItemReport {
  readonly overview: string;
  readonly reproductionSteps?: string;
  readonly expectedOutcome?: string;
  readonly impact?: string;
  readonly occurrenceFrequency?: WorkItemOccurrenceFrequency;
}

export interface WorkItemDiagnosticSummary {
  readonly logCount: number;
  readonly logFileCount?: number;
  readonly contextEntryCount: number;
}

export interface WorkItemEnvironment {
  readonly platform: "android" | "macos" | "web" | "server" | "shared" | "other";
  readonly appVersion?: string;
  readonly buildNumber?: string;
  readonly sourceRevision?: string;
  readonly osVersion?: string;
  readonly deviceModel?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface WorkItemAttachment {
  readonly id: string;
  readonly itemKey: string;
  readonly kind: "image" | "video" | "log" | "document";
  readonly displayNumber: number;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  /** Changes when the stored bytes do, e.g. after annotating; part of the thumbnail URL. */
  readonly revision: string;
}

export interface Product {
  readonly id: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the product is retired; it leaves the switcher but keeps its items. */
  readonly archivedAt?: string;
  /**
   * The account that created it. Only that account, or an administrator, can
   * archive it -- so the archive button is drawn from this. Absent on a product
   * that predates accounts.
   */
  readonly createdByAccountId?: string;
  /**
   * What the signed-in account may do with this product (AND-68). Absent from a
   * server that predates it; the routes decide either way, this only decides
   * what the console offers.
   */
  readonly access?: { readonly canOperate: boolean; readonly canUseAi: boolean };
  /**
   * Whether an icon has been uploaded. The bytes are fetched separately, from
   * `/api/v1/products/:id/icon`, so the product listing stays small enough not to
   * delay the first paint. False means the generated badge is used.
   */
  readonly hasIcon: boolean;
}

export const COMPONENT_KINDS = ["android", "macos", "web", "server", "shared", "other"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface Component {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the module is retired; existing items still resolve it. */
  readonly archivedAt?: string;
}

export interface WorkItem {
  readonly id: string;
  readonly key: string;
  readonly productId: string;
  readonly sourceComponentId?: string;
  readonly affectedComponentIds: readonly string[];
  readonly areaId?: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly status: WorkItemStatus;
  readonly verificationReturn?: { readonly at: string; readonly note?: string };
  readonly title: string;
  readonly description: string;
  readonly report?: WorkItemReport;
  readonly diagnosticSummary: WorkItemDiagnosticSummary;
  readonly environment?: WorkItemEnvironment;
  readonly attachments: readonly WorkItemAttachment[];
  /** The item this one was split off from (AND-50). */
  readonly derivedFrom?: WorkItemReference;
  /** Items split off from this one. Absent when there are none. */
  readonly derivedItems?: readonly WorkItemReference[];
  /** Who created it (AND-67). Absent when the creation was never attributed. */
  readonly createdBy?: WorkItemCreator;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkItemReference {
  readonly key: string;
  readonly title: string;
  readonly status: WorkItemStatus;
}

export type ActorKind = "human" | "agent" | "system";

/** Mirrors WorkItemCreator in packages/domain: a person, an SDK token, or an AI client. */
export type WorkItemCreator =
  | { readonly kind: "human"; readonly accountId: string; readonly name?: string }
  | { readonly kind: "sdk"; readonly name?: string }
  | {
    readonly kind: "agent";
    readonly accountId?: string;
    readonly clientId?: string;
    readonly clientName?: string;
    readonly agentName?: string;
  };

export interface WorkItemEvent {
  readonly id: string;
  readonly itemKey: string;
  readonly eventType: string;
  readonly actorKind: ActorKind;
  readonly fromStatus?: WorkItemStatus;
  readonly toStatus?: WorkItemStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Present on agent writes: which account authorized it and through which client. */
  readonly accountId?: string;
  readonly clientId?: string;
  /** The client's registered name, decoded server-side from clientId. Not self-reported. */
  readonly clientName?: string;
  /** What the account behind accountId calls itself. Resolved server-side, not stored. */
  readonly accountName?: string;
  readonly executionId?: string;
  readonly createdAt: string;
}

export type CommentBodyKind = "structured" | "free";

export interface WorkItemComment {
  readonly id: string;
  readonly itemKey: string;
  readonly actorKind: ActorKind;
  readonly bodyKind: CommentBodyKind;
  readonly body: Readonly<Record<string, unknown>>;
  readonly accountId?: string;
  readonly clientId?: string;
  readonly accountName?: string;
  readonly createdAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawnBy?: string;
}

export interface CreateWorkItemInput {
  readonly productId: string;
  readonly status?: "inbox" | "ready";
  readonly sourceComponentId?: string;
  readonly affectedComponentIds?: readonly string[];
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
  readonly report?: WorkItemReport;
  readonly environment?: WorkItemEnvironment;
}

export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly description?: string;
  readonly report?: WorkItemReport;
  readonly type?: WorkItemType;
  readonly priority?: WorkItemPriority;
  readonly sourceComponentId?: string | null;
  readonly affectedComponentIds?: readonly string[];
  readonly environment?: WorkItemEnvironment | null;
}

export interface TransitionAction {
  readonly label: string;
  readonly to: WorkItemStatus;
  readonly reason:
    | "triaged"
    | "claim"
    | "request_human_input"
    | "resume"
    | "resolution_submitted"
    | "release_verified"
    | "verification_passed"
    | "verification_failed"
    | "released"
    | "reopened"
    | "restored"
    | "cancelled"
    | "manual_override";
  readonly tone?: "primary" | "positive" | "danger";
}

export interface SdkToken {
  readonly id: string;
  readonly name: string;
  readonly productId: string;
  readonly platform: "android";
  readonly sourceComponentId?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
}

/** The plaintext token is returned once, at creation, and never stored client-side. */
export interface CreatedSdkToken extends SdkToken {
  readonly token: string;
}

/** One model a Mac's agent offers, as that Mac reported it (AND-130). */
export interface NodeAgentModel {
  readonly id: string;
  readonly label: string;
  /** The vendor the agent listed the model under; absent when it has no such grouping. */
  readonly provider?: string;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly isDefault?: boolean;
}

export interface NodeAgentReport {
  readonly kind: AgentKind;
  readonly version?: string;
  /** Absent: this Mac's client cannot choose a model or change a running session. */
  readonly models?: readonly NodeAgentModel[];
  /**
   * Whether the machine says this agent can take work (AND-151). Absent from an
   * older client, which the server treats as ready.
   */
  readonly ready?: boolean;
  /** The machine's own wording for why it is paused; only present with `ready: false`. */
  readonly unavailableReason?: string;
}

/** Where the dispatch dialog starts for this account (AND-130). */
export interface DispatchDefaults {
  readonly nodeId?: string;
  readonly agentKind?: AgentKind;
  readonly agents: Partial<Record<AgentKind, { readonly mode?: string; readonly model?: string; readonly effort?: string }>>;
}

/** A conversation's mode, model and effort, and any change still on its way. */
export interface AgentSessionSettings {
  readonly mode: string;
  readonly model?: string;
  readonly effort?: string;
  /** Host of the custom endpoint the agent's requests go to; absent = official API (AND-161). */
  readonly modelEndpoint?: string;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  readonly pending?: { readonly revision: number; readonly mode?: string; readonly model?: string; readonly effort?: string };
  readonly error?: string;
  readonly adjustable: boolean;
}

/**
 * Where a product's checkout lives on one machine. `productKey` travels with the
 * mapping so a node row can name the product without the product list, which the
 * settings panel has but the dispatch dialog does not always.
 */
export interface NodeRepoMapping {
  readonly productId: string;
  readonly productKey: string;
  readonly repoPath: string;
}

/**
 * A checkout the machine reported it can already work in, newest use first.
 *
 * A convenience for choosing a mapping, never a permission: the machine reports
 * where it has been opened, and a person still decides which product lives
 * there. `name` is the directory name only — the machine deliberately does not
 * report git remotes, so it is all the matching has to go on.
 */
export interface RepoCandidate {
  readonly path: string;
  readonly name: string;
  readonly lastUsedAt?: string;
}

/**
 * A developer machine that pulls dispatched work. `online` is the server's
 * verdict rather than something derived here: it owns the heartbeat window, and
 * a clock skewed on this device must not make a silent machine look reachable.
 */
export interface DispatchNode {
  readonly id: string;
  /** What to call the machine everywhere: the nickname when one is set, the device name otherwise. */
  readonly name: string;
  /** What the Mac calls itself; the fallback, and what the nickname field shows as its placeholder. */
  readonly deviceName: string;
  /** The one name somebody chose, from this console or the macOS client. Absent when unset. */
  readonly nickname?: string;
  readonly hostname?: string;
  readonly agents: readonly NodeAgentReport[];
  readonly repos: readonly NodeRepoMapping[];
  /** Empty until the machine's first heartbeat on a build that reports them. */
  readonly repoCandidates: readonly RepoCandidate[];
  readonly lastSeenAt?: string;
  readonly online: boolean;
  readonly revokedAt?: string;
  readonly createdAt: string;
}

/**
 * One hand-off: the items, the machine, and what it was asked to start. The
 * status here is the session's, never the items' — those still move only when
 * the session claims them.
 */
export interface Dispatch {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly agentKind: AgentKind;
  readonly mode: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status: DispatchStatus;
  readonly itemKeys: readonly string[];
  readonly sessionName?: string;
  readonly sessionUrl?: string;
  readonly agentSessionId?: string;
  readonly error?: string;
  readonly failureCode?: string;
  readonly failureStage?: string;
  readonly diagnosticSnapshot?: {
    readonly nodeClientVersion?: string;
    readonly agentVersion?: string;
    readonly skill?: { readonly localVersion?: string; readonly expectedVersion?: string; readonly syncState?: string };
    readonly resource?: { readonly pid?: number; readonly openFiles?: number; readonly softLimit?: number; readonly status?: string; readonly reason?: string };
  };
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
}

export interface DispatchHealthGroup {
  readonly key: string;
  readonly total: number;
  readonly failed: number;
  readonly failureRate: number;
}

export interface DispatchHealthSnapshot {
  readonly windowDays: number;
  readonly total: number;
  readonly launched: number;
  readonly failed: number;
  readonly failureRate: number;
  readonly groups: {
    readonly nodes: readonly DispatchHealthGroup[];
    readonly agents: readonly DispatchHealthGroup[];
    readonly versions: readonly DispatchHealthGroup[];
    readonly codes: readonly DispatchHealthGroup[];
  };
  readonly recentFailures: readonly Dispatch[];
}

export type AgentSessionStatus = "active" | "idle" | "suspended" | "stalled" | "unavailable" | "failed";
export type AgentSessionReplyBlockedReason =
  | "work_finished"
  | "archived"
  | "source_archived"
  | "node_revoked"
  | "operate_permission"
  | "ai_permission";

export interface AgentSessionQuestion {
  readonly header?: string;
  readonly title: string;
  readonly options?: readonly string[];
  readonly multiSelect?: boolean;
  /** Reply key when a field's answer is matched on something other than its title. */
  readonly key?: string;
  /** Non-choice control; absent means a choice built from `options`. */
  readonly kind?: "text" | "number" | "boolean";
  readonly placeholder?: string;
}

export interface AgentSessionActivity {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}

export interface AgentSessionMessage {
  readonly id: string;
  readonly sourceId: string;
  readonly turnId?: string;
  readonly role: "user" | "agent" | "plan";
  readonly phase?: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly questions?: readonly AgentSessionQuestion[];
}

export interface AgentSessionCommand {
  readonly id: string;
  readonly kind: "message" | "interrupt";
  readonly text: string;
  readonly attachments?: readonly AgentSessionAttachment[];
  readonly turnId?: string;
  readonly status: "queued" | "delivering" | "delivery_unknown" | "delivered" | "failed" | "cancelled";
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly cancelledAt?: string;
}

export interface AgentSessionAttachment {
  readonly id: string;
  readonly filename: string;
  readonly kind: "image" | "video" | "document" | "log";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface AgentSession {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentKind: "codex" | "claude_code" | "opencode";
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly messages: readonly AgentSessionMessage[];
  readonly attachmentMessages?: readonly {
    readonly commandId: string;
    readonly text: string;
    readonly createdAt: string;
    readonly status: AgentSessionCommand["status"];
    readonly attachments: readonly AgentSessionAttachment[];
  }[];
  readonly activities: readonly AgentSessionActivity[];
  readonly command?: AgentSessionCommand;
  readonly canReply: boolean;
  readonly canResolveDelivery: boolean;
  readonly canAttach?: boolean;
  readonly replyBlockedReason?: AgentSessionReplyBlockedReason;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly agentSessionId?: string;
  readonly dispatchId: string;
  readonly agentKind: AgentKind;
  readonly status: AgentSessionStatus;
  readonly lastError?: string;
  readonly updatedAt: string;
  /** Last user-visible activity; unlike updatedAt, unchanged mirror polls do not move it. */
  readonly activityAt?: string;
  readonly archivedAt?: string;
  readonly archivedSource?: "missiongo" | "source";
  readonly nodeName: string;
  readonly nodeConnectionState: "online" | "unstable" | "offline";
  readonly nodeLastSeenAt?: string;
  readonly nodeRevoked: boolean;
  readonly mode: string;
  readonly dispatchStatus: DispatchStatus;
  readonly sessionName?: string;
  readonly sessionUrl?: string;
  readonly createdAt: string;
  readonly items: readonly {
    readonly key: string;
    readonly title: string;
    readonly productId: string;
  }[];
  readonly latestMessage?: Pick<AgentSessionMessage, "role" | "text">;
  readonly command?: AgentSessionCommand;
  readonly activities: readonly AgentSessionActivity[];
  readonly canReply: boolean;
  readonly replyBlockedReason?: AgentSessionReplyBlockedReason;
  readonly attention: {
    readonly state: "pending" | "needed" | "not_needed";
    readonly kind?: "answer" | "approval" | "action" | "instruction" | "uncertain";
    readonly reason?: string;
    readonly model?: string;
    readonly revision?: string;
    readonly dismissed?: boolean;
  };
  readonly needsAttention: boolean;
  /** Compatibility alias for older clients; prefer needsAttention. */
  readonly waitingForReply: boolean;
  readonly canRetry: boolean;
  readonly canStop: boolean;
  readonly canArchive: boolean;
  readonly nodeId: string;
  readonly settings: AgentSessionSettings;
  /** Server-side, per account: something to look at arrived since this conversation was last opened. */
  readonly unread: boolean;
  /** The unread clock value; marking read sends it back so later arrivals stay unread. */
  readonly unreadAt?: string;
}

export interface CreateDispatchInput {
  readonly nodeId: string;
  readonly agentKind: AgentKind;
  readonly mode: string;
  /** Absent: the Mac's own configured model and effort. */
  readonly model?: string;
  readonly effort?: string;
  readonly itemKeys: readonly string[];
  /**
   * Dispatch even though some of these items were already sent and not yet
   * claimed. Only set after a person has said the earlier session is gone: the
   * server otherwise refuses, because two sessions would start on one item.
   */
  readonly force?: boolean;
}

/** A ready item's newest dispatch attempt in its current ready cycle. */
export interface ItemDispatchSummary {
  readonly dispatchId: string;
  readonly itemKey: string;
  readonly nodeName: string;
  readonly status: Extract<DispatchStatus, "queued" | "delivered" | "launched" | "failed">;
  readonly createdAt: string;
}

/** An in-progress item's dispatch origin: the agent whose session claimed it. */
export interface ItemDispatchHandler {
  readonly dispatchId: string;
  readonly itemKey: string;
  readonly nodeName: string;
  readonly agentKind: AgentKind;
  readonly createdAt: string;
}

/** The subset that can still start or already represents an unclaimed session. */
export interface ActiveDispatch extends Omit<ItemDispatchSummary, "status"> {
  readonly status: Extract<DispatchStatus, "queued" | "delivered" | "launched">;
}
