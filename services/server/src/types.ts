import type {
  AttachmentKind,
  ActorKind,
  TransitionReason,
  WorkItemEnvironment,
  WorkItemPriority,
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
  readonly sourceComponentId?: string;
  readonly affectedComponentIds?: readonly string[];
  readonly areaId?: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly title: string;
  readonly description: string;
  readonly environment?: WorkItemEnvironment;
}

export interface ListWorkItemsInput {
  readonly productId: string;
  readonly status?: WorkItemStatus;
  readonly type?: WorkItemType;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly description?: string;
  readonly type?: WorkItemType;
  readonly priority?: WorkItemPriority;
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

export type { WorkItemSnapshot };
