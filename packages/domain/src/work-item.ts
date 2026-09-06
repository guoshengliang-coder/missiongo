export const WORK_ITEM_TYPES = ["bug", "requirement", "idea", "task", "note"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const WORK_ITEM_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
  "on_hold",
  "pending_verification",
  "done",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_OCCURRENCE_FREQUENCIES = ["unknown", "once", "intermittent", "frequent", "always"] as const;
export type WorkItemOccurrenceFrequency = (typeof WORK_ITEM_OCCURRENCE_FREQUENCIES)[number];

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

// `document` is material a person reads -- a spec, a note, a CSV -- as opposed
// to `log`, which is machine output the diagnostics panel presents as evidence.
export const ATTACHMENT_KINDS = ["image", "video", "log", "document"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface WorkItemAttachment {
  readonly id: string;
  readonly itemKey: string;
  readonly kind: AttachmentKind;
  readonly displayNumber: number;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface WorkItemSnapshot {
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

const PRODUCT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export function createWorkItemKey(productPrefix: string, sequence: number): string {
  if (!PRODUCT_PREFIX_PATTERN.test(productPrefix)) {
    throw new Error("Product prefix must be 2-10 uppercase letters or digits and start with a letter.");
  }

  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Work item sequence must be a positive safe integer.");
  }

  return `${productPrefix}-${sequence}`;
}
