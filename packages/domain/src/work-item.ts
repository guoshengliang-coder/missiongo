export const WORK_ITEM_TYPES = ["bug", "requirement", "idea", "task", "note"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const WORK_ITEM_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
  "development_complete",
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
  /** Structured entries the host sent with the report, bounded and stored inline. */
  readonly logCount: number;
  /** Attached log files. Counted apart: one file can hold thousands of lines. */
  readonly logFileCount: number;
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
  /**
   * Changes whenever the stored bytes do. Annotating an image replaces its
   * content under the same id, so anything cached by id alone -- a thumbnail
   * URL above all -- needs this to tell the edited image from the original.
   */
  readonly revision: string;
}

/** Just enough of another item to name it and link to it. */
export interface WorkItemReference {
  readonly key: string;
  readonly title: string;
  readonly status: WorkItemStatus;
}

/**
 * Who put an item on the board (AND-67), read off its `item_created` event.
 *
 * Three shapes because there are three doors, and they must not be confused:
 * - `human`: a person in the console. `name` is their nickname, resolved on read.
 * - `sdk`: a report sent from an app through a feedback SDK token. No account
 *   is behind it; `name` is the token's name.
 * - `agent`: an AI recording a follow-up (AND-50). The authorizing account is
 *   kept, but the byline is the client and the agent -- an AI's item is not
 *   signed as the person who connected it, the same rule comments follow.
 *
 * Absent on items whose creation was never attributed: ones written before
 * events carried accounts, or through the operator token.
 */
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
  /** Most recent entry into Ready, only when it came directly from verification. */
  readonly verificationReturn?: { readonly at: string; readonly note?: string };
  readonly title: string;
  readonly description: string;
  readonly report?: WorkItemReport;
  readonly diagnosticSummary: WorkItemDiagnosticSummary;
  readonly environment?: WorkItemEnvironment;
  readonly attachments: readonly WorkItemAttachment[];
  /**
   * The item this one was split off from while that one was being worked on
   * (AND-50). A relation rather than a key like AND-50.1: keys stay
   * prefix-plus-integer, which sequencing, paging and the Mac client's
   * dispatch check all rely on.
   */
  readonly derivedFrom?: WorkItemReference;
  /** Items split off from this one, oldest first. Absent when there are none. */
  readonly derivedItems?: readonly WorkItemReference[];
  /** Who created it. Names are filled in by the HTTP layer; see WorkItemCreator. */
  readonly createdBy?: WorkItemCreator;
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
