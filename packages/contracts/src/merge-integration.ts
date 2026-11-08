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
  publication?: { state: "publishing" | "failed" | "ended"; checkedAt: string; expiresAt: string; resultsDigest: string; detail: string };
  recoveredAuthorization?: { dispatchId: string; promptDigest: string };
  plans: (IntegrationPlan & { at: string })[];
  entries: Record<string, IntegrationEntry>;
  events: { id: string; digest: string; action: string; deliveryId?: string; at: string; detail: string }[];
  finalValidation?: { head: string; checkedAt: string; validation: string; source: string; selectionDigest: string };
}
