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
}

export interface ComponentSnapshot {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly type?: WorkItemType;
  readonly search?: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export interface WorkItemListSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<WorkItemStatus, number>>;
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

export interface WorkItemEventSnapshot {
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
