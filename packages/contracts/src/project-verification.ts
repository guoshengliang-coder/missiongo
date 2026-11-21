/** Executor-observed project rules, bound by the containing head/base evidence. */
export interface ProjectVerification {
  repository: string; targetBranch: string;
  rulesSource: string; rulesDigest: string;
  ci: "required" | "not_required"; local: "required" | "not_required";
  reason: string;
  platformRead: "complete";
  requiredChecks: string[]; observedChecks: string[];
  autoMerge: boolean; protectedChecks: boolean;
  mergeMethod: "merge" | "squash" | "rebase" | "queue";
}
export type ProjectCheckState = "passed" | "pending" | "failed" | "unknown" | "not_applicable";
/** Unknown never means absent; a policy snapshot never turns failure into success. */
export function projectCheckSatisfied(status: string | undefined, policy?: ProjectVerification, local = false): boolean {
  if (status === "passed") return true;
  if (status !== "not_applicable" || !policy || policy.platformRead !== "complete"
    || !policy.rulesSource || !/^[a-f0-9]{64}$/.test(policy.rulesDigest) || !policy.reason) return false;
  return local ? policy.local === "not_required"
    : policy.ci === "not_required" && policy.requiredChecks.length === 0 && policy.observedChecks.length === 0;
}

/** Pending work may be delegated only when every observed/required check is protected. */
export function projectAutoMergeReady(policy?: ProjectVerification): boolean {
  return Boolean(policy && policy.platformRead === "complete" && policy.ci === "required"
    && policy.autoMerge === true && policy.protectedChecks === true && policy.requiredChecks.length > 0
    && policy.requiredChecks.every(name=>policy.observedChecks.includes(name))
    && policy.observedChecks.every(name=>policy.requiredChecks.includes(name)));
}
