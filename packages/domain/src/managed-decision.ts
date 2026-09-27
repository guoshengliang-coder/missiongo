import type { ManagedRunScope } from "./managed-run.js";

/** This release cannot authorize merge, release, deployment or production changes. */
export const MANAGED_DECISION_ACTIONS = ["implement", "review", "verify"] as const;
export type ManagedDecisionAction = (typeof MANAGED_DECISION_ACTIONS)[number];
export interface ManagedDecisionContent {
  readonly title: string;
  readonly recommendation: string;
  readonly alternatives: readonly string[];
  readonly costs: string;
  readonly acceptanceCriteria: readonly string[];
  readonly allowedActions: readonly ManagedDecisionAction[];
}
export interface ManagedDecision {
  readonly id: string;
  readonly runId: string;
  readonly decisionKey: string;
  readonly scope: ManagedRunScope;
  readonly scopeDigest: string;
  readonly version: number;
  readonly stateVersion: number;
  readonly contentDigest: string;
  readonly content: ManagedDecisionContent;
  readonly explanation: string;
  readonly status: "pending" | "approved" | "revoked";
  readonly approval: { readonly accountId: string; readonly approvedAt: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ManagedDecisionGuard {
  readonly version: number;
  readonly stateVersion: number;
  readonly contentDigest: string;
  readonly scopeDigest: string;
  readonly contractRevision: number;
  readonly idempotencyKey: string;
}
export interface ManagedDecisionEvent {
  readonly sequence: number;
  readonly operation: string;
  readonly accountId: string;
  readonly version: number;
  readonly stateVersion: number;
  readonly createdAt: string;
}

export function isManagedDecisionContent(value: unknown): value is ManagedDecisionContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fields = ["title", "recommendation", "alternatives", "costs", "acceptanceCriteria", "allowedActions"];
  const text = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 4000;
  const list = (a: unknown) => Array.isArray(a) && a.length > 0 && a.length <= 20 && a.every(text);
  return Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k))
    && text(v.title) && (v.title as string).length <= 200 && text(v.recommendation) && text(v.costs)
    && list(v.alternatives) && list(v.acceptanceCriteria)
    && Array.isArray(v.allowedActions) && v.allowedActions.length > 0
    && v.allowedActions.every((a) => MANAGED_DECISION_ACTIONS.includes(a))
    && new Set(v.allowedActions).size === v.allowedActions.length;
}
