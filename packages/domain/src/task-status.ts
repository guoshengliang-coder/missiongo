import type { TaskStatus } from "./task.js";

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type TransitionReason =
  | "claim"
  | "request_human_input"
  | "resume"
  | "resolution_submitted"
  | "verification_passed"
  | "verification_failed"
  | "lease_expired"
  | "released"
  | "cancelled"
  | "reopened"
  | "restored";

export interface TaskTransitionRequest {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly actor: ActorKind;
  readonly reason: TransitionReason;
}

export interface TaskTransitionDecision {
  readonly allowed: boolean;
  readonly code: "allowed" | "invalid_transition" | "actor_not_allowed" | "reason_mismatch";
  readonly message: string;
}

interface TransitionRule {
  readonly actors: readonly ActorKind[];
  readonly reasons: readonly TransitionReason[];
}

const rule = (actors: readonly ActorKind[], reasons: readonly TransitionReason[]): TransitionRule => ({
  actors,
  reasons,
});

const TRANSITIONS: Readonly<Partial<Record<TaskStatus, Readonly<Partial<Record<TaskStatus, TransitionRule>>>>>> = {
  pending: {
    in_progress: rule(["agent", "human"], ["claim", "resume"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  in_progress: {
    waiting_for_human: rule(["agent", "human"], ["request_human_input"]),
    ready_for_verification: rule(["agent", "human"], ["resolution_submitted"]),
    pending: rule(["agent", "human", "system"], ["released", "lease_expired"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  waiting_for_human: {
    in_progress: rule(["agent", "human"], ["resume"]),
    pending: rule(["human"], ["reopened"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  ready_for_verification: {
    completed: rule(["human"], ["verification_passed"]),
    pending: rule(["human"], ["verification_failed"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  completed: {
    pending: rule(["human"], ["reopened"]),
  },
  cancelled: {
    pending: rule(["human"], ["restored"]),
  },
};

export function evaluateTaskTransition(request: TaskTransitionRequest): TaskTransitionDecision {
  const transition = TRANSITIONS[request.from]?.[request.to];

  if (!transition) {
    return {
      allowed: false,
      code: "invalid_transition",
      message: `Transition from ${request.from} to ${request.to} is not allowed.`,
    };
  }

  if (!transition.actors.includes(request.actor)) {
    return {
      allowed: false,
      code: "actor_not_allowed",
      message: `${request.actor} cannot transition a task from ${request.from} to ${request.to}.`,
    };
  }

  if (!transition.reasons.includes(request.reason)) {
    return {
      allowed: false,
      code: "reason_mismatch",
      message: `${request.reason} is not valid for the transition from ${request.from} to ${request.to}.`,
    };
  }

  return {
    allowed: true,
    code: "allowed",
    message: "Transition is allowed.",
  };
}

export function assertTaskTransition(request: TaskTransitionRequest): void {
  const decision = evaluateTaskTransition(request);
  if (!decision.allowed) {
    throw new Error(decision.message);
  }
}
