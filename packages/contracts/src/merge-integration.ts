/** Executor-reported integration evidence; the server does not hold Git credentials. */
export interface IntegrationPlan {
  base: string;
  summary: string;
  validation: string;
  entries: { deliveryId: string; head: string; dependsOn: string[]; group: string; reason: string; validation: string }[];
}
export interface IntegrationCheck {
  head: string; base: string; checkedAt: string; source: string;
  checks: "passed" | "pending" | "failed" | "unknown";
  mergeable: "clean" | "conflicting" | "unknown";
  local: "passed" | "failed" | "pending"; validation: string;
}
export interface IntegrationEntry {
  itemKeys: string[]; originalHead: string; head: string;
  progress: "queued" | "investigating" | "repairing" | "waiting_ci" | "ready";
  detail: string;
  repair?: { id: string; fromHead: string; base: string; reason: string };
  repairs: { id: string; fromHead: string; head: string; base: string; reason: string; commits: string[]; validation: string; source: string; at: string }[];
  check?: IntegrationCheck;
}
export interface MergeIntegration {
  protocol: 1; revision: number;
  prerequisites?: IntegrationPrerequisites;
  /** Legacy merge authority may record prerequisites, never acquire repair authority. */
  prerequisitesOnly?: true;
  publication?: { state: "publishing" | "failed" | "ended"; checkedAt: string; expiresAt: string; resultsDigest: string; detail: string };
  recoveredAuthorization?: { dispatchId: string; promptDigest: string };
  plans: (IntegrationPlan & { at: string })[];
  entries: Record<string, IntegrationEntry>;
  events: { id: string; digest: string; action: string; deliveryId?: string; at: string; detail: string }[];
  finalValidation?: { head: string; checkedAt: string; validation: string; source: string; selectionDigest: string };
}

/** Evidence reported by the original executor, never a permission grant. */
export interface IntegrationPrerequisite {
  id: string;
  kind: "main" | "installation_integrity" | "required_capability" | "authorization" | "scope" | "investigation" | "tool_difference" | "version" | "build" | "artifact" | "release_notes";
  category: "blocker" | "fact" | "work" | "notice";
  stage: "pre_merge" | "post_merge" | "pre_publish";
  required: boolean;
  state: "satisfied" | "pending" | "unknown" | "not_required";
  reason: string; owner: string; resumeWhen: string;
  dependencies: ("base" | "heads" | "scope" | "candidates" | "tools" | "capabilities")[];
  dependsOnDeliveries?: { deliveryId: string; head: string }[] | undefined;
  authorizationRef?: string | undefined;
}
export interface IntegrationPrerequisites {
  observation: { batchId:string; heads:{deliveryId:string;head:string}[]; scope:string };
  context: { base: string; candidates: string; tools: string; capabilities: string };
  conditions: (IntegrationPrerequisite & { binding: Record<string,string>; checkedAt: string; source: string })[];
  resolutions: {conditionId:string;deliveryId:string;head:string;via:"base"|"tools"|"capabilities";before:string;after:string;source:string}[];
}
export interface IntegrationPrerequisiteGate {
  required: boolean; ready: boolean;
  blockers: { id: string; code: "missing" | "pending" | "stale" | "cycle"; reason: string; owner: string; resumeWhen: string }[];
}
