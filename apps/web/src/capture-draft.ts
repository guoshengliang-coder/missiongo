import {
  ITEM_PRIORITIES,
  ITEM_TYPES,
  type WorkItemEnvironment,
  type WorkItemPriority,
  type WorkItemType,
} from "./types";

export type EnvironmentPlatform = WorkItemEnvironment["platform"] | "";

export interface EnvironmentDraft {
  readonly platform: EnvironmentPlatform;
  readonly appVersion: string;
  readonly buildNumber: string;
  readonly sourceRevision: string;
  readonly osVersion: string;
  readonly deviceModel: string;
}

export interface CaptureDraft {
  readonly title: string;
  readonly description: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly sourceComponentId: string;
  readonly environment: EnvironmentDraft;
}

export const EMPTY_ENVIRONMENT: EnvironmentDraft = {
  platform: "",
  appVersion: "",
  buildNumber: "",
  sourceRevision: "",
  osVersion: "",
  deviceModel: "",
};

export const EMPTY_CAPTURE_DRAFT: CaptureDraft = {
  title: "",
  description: "",
  type: "idea",
  priority: "normal",
  sourceComponentId: "",
  environment: EMPTY_ENVIRONMENT,
};

export function captureDraftStorageKey(productId: string): string {
  return `missiongo.capture-draft.v1.${productId}`;
}

export function hasCaptureDraftContent(draft: CaptureDraft): boolean {
  return Boolean(
    draft.title.trim() ||
    draft.description.trim() ||
    draft.sourceComponentId ||
    draft.type !== "idea" ||
    draft.priority !== "normal" ||
    Object.values(draft.environment).some((value) => value.trim()),
  );
}

export function parseCaptureDraft(raw: string | null): CaptureDraft {
  if (!raw) return EMPTY_CAPTURE_DRAFT;
  try {
    const value = JSON.parse(raw) as Partial<CaptureDraft>;
    const environment = value.environment && typeof value.environment === "object"
      ? value.environment as Partial<EnvironmentDraft>
      : {};
    const platform = ["", "android", "macos", "web", "server", "shared", "other"].includes(environment.platform ?? "")
      ? environment.platform as EnvironmentPlatform
      : "";
    return {
      title: typeof value.title === "string" ? value.title : "",
      description: typeof value.description === "string" ? value.description : "",
      type: ITEM_TYPES.includes(value.type as WorkItemType) ? value.type as WorkItemType : "idea",
      priority: ITEM_PRIORITIES.includes(value.priority as WorkItemPriority)
        ? value.priority as WorkItemPriority
        : "normal",
      sourceComponentId: typeof value.sourceComponentId === "string" ? value.sourceComponentId : "",
      environment: {
        platform,
        appVersion: typeof environment.appVersion === "string" ? environment.appVersion : "",
        buildNumber: typeof environment.buildNumber === "string" ? environment.buildNumber : "",
        sourceRevision: typeof environment.sourceRevision === "string" ? environment.sourceRevision : "",
        osVersion: typeof environment.osVersion === "string" ? environment.osVersion : "",
        deviceModel: typeof environment.deviceModel === "string" ? environment.deviceModel : "",
      },
    };
  } catch {
    return EMPTY_CAPTURE_DRAFT;
  }
}
