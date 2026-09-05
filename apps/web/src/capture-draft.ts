import {
  ITEM_PRIORITIES,
  ITEM_TYPES,
  type WorkItemEnvironment,
  type WorkItemPriority,
  type WorkItemOccurrenceFrequency,
  type WorkItemType,
  type WorkItemReport,
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
  readonly reproductionSteps: string;
  readonly expectedOutcome: string;
  readonly impact: string;
  readonly occurrenceFrequency: WorkItemOccurrenceFrequency;
  readonly diagnosticLog: string;
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
  reproductionSteps: "",
  expectedOutcome: "",
  impact: "",
  occurrenceFrequency: "unknown",
  diagnosticLog: "",
  type: "bug",
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
    draft.reproductionSteps.trim() ||
    draft.expectedOutcome.trim() ||
    draft.impact.trim() ||
    draft.occurrenceFrequency !== "unknown" ||
    draft.diagnosticLog.trim() ||
    draft.sourceComponentId ||
    draft.type !== "bug" ||
    draft.priority !== "normal" ||
    Object.values(draft.environment).some((value) => value.trim()),
  );
}

export function workItemReportPayload(draft: CaptureDraft): WorkItemReport {
  const overview = draft.description.trim();
  if (draft.type !== "bug") return { overview };
  const reproductionSteps = draft.reproductionSteps.trim();
  const expectedOutcome = draft.expectedOutcome.trim();
  const impact = draft.impact.trim();
  return {
    overview,
    ...(reproductionSteps ? { reproductionSteps } : {}),
    ...(expectedOutcome ? { expectedOutcome } : {}),
    ...(impact ? { impact } : {}),
    ...(draft.occurrenceFrequency !== "unknown" ? { occurrenceFrequency: draft.occurrenceFrequency } : {}),
  };
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
      reproductionSteps: typeof value.reproductionSteps === "string" ? value.reproductionSteps : "",
      expectedOutcome: typeof value.expectedOutcome === "string" ? value.expectedOutcome : "",
      impact: typeof value.impact === "string" ? value.impact : "",
      occurrenceFrequency: ["unknown", "once", "intermittent", "frequent", "always"].includes(value.occurrenceFrequency ?? "")
        ? value.occurrenceFrequency as WorkItemOccurrenceFrequency
        : "unknown",
      diagnosticLog: typeof value.diagnosticLog === "string" ? value.diagnosticLog : "",
      type: ITEM_TYPES.includes(value.type as WorkItemType) ? value.type as WorkItemType : "bug",
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
