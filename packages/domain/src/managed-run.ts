export interface ManagedRunScope {
  readonly productId: string;
  /** An opaque, frozen mapping reference, not a writable filesystem path. */
  readonly repositoryRef: string;
  readonly itemKeys: readonly string[];
  readonly contractRevision: number;
}

export interface ManagedRun {
  readonly id: string;
  readonly accountId: string;
  readonly scope: ManagedRunScope;
  readonly scopeDigest: string;
  readonly version: number;
  readonly createdAt: string;
}

export const MANAGED_STAGE_ROLES = ["implement", "review", "verify"] as const;
export type ManagedStageRole = (typeof MANAGED_STAGE_ROLES)[number];
export type ManagedAttemptStatus = "running" | "waiting_for_human" | "unknown" | "succeeded" | "failed";

export interface ManagedStage {
  readonly id: string;
  readonly runId: string;
  readonly stageKey: string;
  readonly role: ManagedStageRole;
  readonly inputCommit: string;
  readonly currentGeneration: number;
  readonly status: "ready" | ManagedAttemptStatus;
}

export interface ManagedExecutor {
  readonly agentKind: string;
  readonly sessionRef: string;
  readonly resolvedModel: string;
}

export interface ManagedAttemptResult {
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface ManagedAttempt {
  readonly id: string;
  readonly runId: string;
  readonly stageId: string;
  readonly generation: number;
  readonly status: ManagedAttemptStatus;
  readonly executor: ManagedExecutor;
  readonly result: ManagedAttemptResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedRunCommand {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly contractRevision: number;
  readonly scopeDigest: string;
  readonly idempotencyKey: string;
}

export interface ManagedRunEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly result: unknown;
}

export function isManagedRunScope(value: unknown): value is ManagedRunScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const keys = ["productId", "repositoryRef", "itemKeys", "contractRevision"];
  return Object.keys(scope).length === keys.length && keys.every((key) => Object.hasOwn(scope, key))
    && [scope.productId, scope.repositoryRef].every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))
    && Array.isArray(scope.itemKeys) && scope.itemKeys.length > 0 && scope.itemKeys.length <= 20
    && scope.itemKeys.every((key) => typeof key === "string" && /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(key) && key.length <= 50)
    && new Set(scope.itemKeys).size === scope.itemKeys.length
    && Number.isSafeInteger(scope.contractRevision) && (scope.contractRevision as number) > 0;
}
