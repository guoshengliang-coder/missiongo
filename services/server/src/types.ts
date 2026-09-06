import type {
  AttachmentKind,
  ActorKind,
  ExecutionMode,
  ExecutionReport,
  ExecutionStatus,
  ExecutionTriggerSource,
  TransitionReason,
  WorkItemEnvironment,
  WorkItemPriority,
  WorkItemReport,
  WorkItemAttachment,
  WorkItemSnapshot,
  WorkItemStatus,
  WorkItemType,
} from "@missiongo/domain";

export const COMPONENT_KINDS = ["android", "macos", "web", "server", "shared", "other"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface ProductSnapshot {
  readonly id: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the product is retired. Its items stay readable; it leaves the pickers. */
  readonly archivedAt?: string;
  /** An uploaded icon as a PNG data URL. Absent when the product uses its generated badge. */
  readonly icon?: string;
}

export interface ComponentSnapshot {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the module is retired. Existing items keep resolving it. */
  readonly archivedAt?: string;
}

export interface CreateWorkItemInput {
  readonly productId: string;
  readonly status?: "inbox" | "ready";
  readonly sourceComponentId?: string;
  readonly affectedComponentIds?: readonly string[];
  readonly areaId?: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
  readonly report?: WorkItemReport;
  readonly environment?: WorkItemEnvironment;
}

export interface ListWorkItemsInput {
  readonly productId: string;
  readonly status?: WorkItemStatus;
  /** Without a status filter, cancelled items are left out unless this is set. */
  readonly includeCancelled?: boolean;
  readonly type?: WorkItemType;
  readonly search?: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export interface WorkItemListSummaryInput {
  readonly productId: string;
  readonly type?: WorkItemType;
  readonly search?: string;
}

export interface WorkItemListSummary {
  /** Items matching the active type and search filters, across every status. */
  readonly total: number;
  /** Per-status counts under the same filters, so each sidebar entry stays honest. */
  readonly byStatus: Readonly<Record<WorkItemStatus, number>>;
  /** Every item in the product, so the list can say "12 of 40". */
  readonly productTotal: number;
}

export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly description?: string;
  readonly report?: WorkItemReport;
  readonly type?: WorkItemType;
  readonly priority?: WorkItemPriority;
  readonly sourceComponentId?: string | null;
  readonly environment?: WorkItemEnvironment | null;
  readonly affectedComponentIds?: readonly string[];
}

export interface CreateAttachmentMetadataInput {
  readonly itemKey: string;
  readonly kind: AttachmentKind;
  readonly filename: string;
  readonly storageFilename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly feedbackDraftId?: string;
  readonly clientAttachmentId?: string;
  readonly contentSha256?: string;
}

export interface ReplaceAttachmentContentInput {
  readonly itemKey: string;
  readonly attachmentId: string;
  readonly kind: AttachmentKind;
  readonly filename: string;
  readonly storageFilename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface AttachmentRecord extends WorkItemAttachment {
  readonly storageFilename: string;
}

export interface TransitionWorkItemInput {
  readonly itemKey: string;
  readonly to: WorkItemStatus;
  readonly actor: ActorKind;
  readonly reason: TransitionReason;
  readonly note?: string;
}

export interface AppendAnalysisInput {
  readonly itemKey: string;
  readonly conclusion: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly agentName?: string;
  readonly attribution?: EventAttribution;
  readonly idempotencyKey: string;
}

export interface ExecutionSnapshot {
  readonly id: string;
  readonly itemKey: string;
  readonly agentId: string;
  readonly mode: Exclude<ExecutionMode, "analyze">;
  readonly triggerSource: ExecutionTriggerSource;
  readonly status: ExecutionStatus;
  readonly report?: ExecutionReport;
  readonly humanQuestion?: string;
  readonly activeLease?: {
    readonly id: string;
    readonly expiresAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface ClaimExecutionInput {
  readonly itemKey: string;
  readonly agentId: string;
  readonly mode: Exclude<ExecutionMode, "analyze">;
  readonly leaseSeconds: number;
  readonly idempotencyKey: string;
}

/**
 * Which AI wrote an event. `actorKind` says a machine acted; this says which
 * account authorized it, which OAuth client it came through, and which execution
 * it belonged to. Absent on human events -- a single administrator owns this
 * deployment, so `actorKind: "human"` already names the account -- and on every
 * event written before migration 13.
 */
export interface EventAttribution {
  readonly accountId?: string;
  readonly clientId?: string;
  readonly executionId?: string;
}

export const COMMENT_BODY_KINDS = ["structured", "free"] as const;
export type CommentBodyKind = (typeof COMMENT_BODY_KINDS)[number];

/**
 * An agent's formal analysis. The fields are deliberately not diagnosis-shaped:
 * MissionGo holds ideas, requirements, tasks and notes as well as bugs, and
 * "root cause" is not the question to answer for most of them. What is common
 * across all five is: here is what I understood you want, here is what I found,
 * here is what I cannot decide without you.
 */
export interface StructuredCommentBody {
  /** What the agent understood the item to be asking for. */
  readonly understanding: string;
  /** What it found: confirmed, not reproducible, already exists, conflicts with a prior decision. */
  readonly finding: string;
  /** What the finding rests on. Must point at something actually read. */
  readonly evidence: readonly string[];
  /** Suggested way forward. Absent for notes and some ideas, where there is nothing to do. */
  readonly proposal?: string;
  /** What the agent could not settle alone. Answering these is the user's call. */
  readonly openQuestions: readonly string[];
  readonly agentName?: string;
}

/** Everything else people and agents say: questions, answers, side findings. */
export interface FreeCommentBody {
  readonly text: string;
}

export type CommentBody = StructuredCommentBody | FreeCommentBody;

export interface WorkItemCommentSnapshot extends EventAttribution {
  readonly id: string;
  readonly itemKey: string;
  readonly actorKind: ActorKind;
  readonly bodyKind: CommentBodyKind;
  readonly body: CommentBody;
  readonly createdAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawnBy?: string;
}

export interface CreateCommentInput {
  readonly itemKey: string;
  readonly actorKind: ActorKind;
  readonly bodyKind: CommentBodyKind;
  readonly body: CommentBody;
  readonly attribution?: EventAttribution;
  /** Required for agent writes, which are retried; a person pressing send is not. */
  readonly idempotencyKey?: string;
}

export interface WithdrawCommentInput {
  readonly itemKey: string;
  readonly commentId: string;
  readonly accountId?: string;
}

export interface WorkItemEventSnapshot extends EventAttribution {
  readonly id: string;
  readonly itemKey: string;
  readonly eventType: string;
  readonly actorKind: ActorKind;
  readonly fromStatus?: WorkItemStatus;
  readonly toStatus?: WorkItemStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface SdkTokenSnapshot {
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

export interface CreatedSdkToken extends SdkTokenSnapshot {
  readonly token: string;
}

export interface SdkPrincipal {
  readonly tokenId: string;
  readonly productId: string;
  readonly platform: "android";
  readonly sourceComponentId?: string;
}

export interface FeedbackLogEntry {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface FeedbackDraftSnapshot {
  readonly id: string;
  readonly clientDraftId: string;
  readonly productId: string;
  readonly sourceComponentId?: string;
  readonly status: "editing" | "submitted" | "expired";
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
  readonly environment: WorkItemEnvironment;
  readonly context: Readonly<Record<string, string>>;
  readonly logs: readonly FeedbackLogEntry[];
  readonly itemKey?: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertFeedbackDraftInput {
  readonly principal: SdkPrincipal;
  readonly clientDraftId: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
  readonly environment: WorkItemEnvironment;
  readonly context: Readonly<Record<string, string>>;
  readonly logs: readonly FeedbackLogEntry[];
}

export interface FeedbackWebSession {
  readonly token: string;
  readonly expiresAt: string;
}

export type { WorkItemSnapshot };
