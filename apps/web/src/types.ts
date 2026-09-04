export const ITEM_TYPES = ["idea", "requirement", "bug", "task", "note"] as const;
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

export interface Product {
  readonly id: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly environment?: {
    readonly platform: "android" | "macos" | "web" | "other";
    readonly appVersion?: string;
    readonly buildNumber?: string;
    readonly sourceRevision?: string;
    readonly osVersion?: string;
    readonly deviceModel?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  };
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
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
}

export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly description?: string;
  readonly type?: WorkItemType;
  readonly priority?: WorkItemPriority;
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
    | "cancelled";
  readonly tone?: "primary" | "positive" | "danger";
}
