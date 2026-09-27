import type { ManagedDecisionGuard } from "./managed-decision.js";
import type { ManagedStageRole } from "./managed-run.js";

export interface ExecutionRequest extends ManagedDecisionGuard {
  runId: string; decisionId: string; stageKey: string; role: ManagedStageRole;
  inputCommit: string; nodeId: string; permissionMode: "read-only" | "workspace-write";
}
export interface ExecutionObservation {
  sequence: number; generation: number; state: "bound" | "running" | "waiting" | "unknown";
  sessionRef?: string | undefined; resolvedModel?: string | undefined;
}
export interface ExecutionObservationReceipt {
  accepted: true;
  terminal?: {
    intentId: string; generation: number; sequence: number; state: "terminal";
    sessionRef: string; resolvedModel: string;
  };
}
export interface ExecutionIntent {
  id: string; binding: ExecutionRequest; stageId: string; generation: number;
  state: "requested" | "acknowledged" | "starting" | "bound" | "turn_starting" | "running" | "waiting" | "unknown" | "terminal";
  ownershipHeld: boolean; attemptId: string | null; attemptGeneration: number | null; sessionId: string | null;
  stopRequested: boolean; outcome: "cancelled" | "succeeded" | "failed" | null;
  cleanup: string | null; resultDigest?: string; updatedAt: string;
}
