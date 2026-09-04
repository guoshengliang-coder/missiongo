export const TASK_TYPES = ["bug", "idea"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "waiting_for_human",
  "ready_for_verification",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskEnvironment {
  readonly platform: "android" | "macos" | "web" | "other";
  readonly appVersion?: string;
  readonly buildNumber?: string;
  readonly sourceRevision?: string;
  readonly osVersion?: string;
  readonly deviceModel?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TaskSnapshot {
  readonly id: string;
  readonly key: string;
  readonly productId: string;
  readonly sourceComponentId?: string;
  readonly affectedComponentIds: readonly string[];
  readonly areaId?: string;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly title: string;
  readonly description: string;
  readonly environment?: TaskEnvironment;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const PRODUCT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export function createTaskKey(productPrefix: string, sequence: number): string {
  if (!PRODUCT_PREFIX_PATTERN.test(productPrefix)) {
    throw new Error("Product prefix must be 2-10 uppercase letters or digits and start with a letter.");
  }

  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Task sequence must be a positive safe integer.");
  }

  return `${productPrefix}-${sequence}`;
}
