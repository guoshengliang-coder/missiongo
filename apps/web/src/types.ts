export const ITEM_TYPES = ["bug", "requirement", "idea", "task", "note"] as const;
export type WorkItemType = (typeof ITEM_TYPES)[number];

export const ITEM_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type WorkItemPriority = (typeof ITEM_PRIORITIES)[number];

export const ITEM_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
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
}

export interface Product {
  readonly id: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the product is retired; it leaves the switcher but keeps its items. */
  readonly archivedAt?: string;
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
  readonly title: string;
  readonly description: string;
  readonly report?: WorkItemReport;
  readonly diagnosticSummary: WorkItemDiagnosticSummary;
  readonly environment?: WorkItemEnvironment;
  readonly attachments: readonly WorkItemAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkItemEvent {
  readonly id: string;
  readonly itemKey: string;
  readonly eventType: string;
  readonly actorKind: "human" | "agent" | "system";
  readonly fromStatus?: WorkItemStatus;
  readonly toStatus?: WorkItemStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
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
