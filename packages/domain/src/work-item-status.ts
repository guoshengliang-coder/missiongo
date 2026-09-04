import type { WorkItemStatus } from "./work-item.js";

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type TransitionReason =
  | "triaged"
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

export interface WorkItemTransitionRequest {
  readonly from: WorkItemStatus;
  readonly to: WorkItemStatus;
  readonly actor: ActorKind;
  readonly reason: TransitionReason;
}

export interface WorkItemTransitionDecision {
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

const TRANSITIONS: Readonly<
  Partial<Record<WorkItemStatus, Readonly<Partial<Record<WorkItemStatus, TransitionRule>>>>>
> = {
  inbox: {
    ready: rule(["human"], ["triaged"]),
    on_hold: rule(["human"], ["request_human_input"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  ready: {
    in_progress: rule(["agent", "human"], ["claim", "resume"]),
    on_hold: rule(["human"], ["request_human_input"]),
    inbox: rule(["human"], ["reopened"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  in_progress: {
    on_hold: rule(["agent", "human"], ["request_human_input"]),
    pending_verification: rule(["agent", "human"], ["resolution_submitted"]),
    ready: rule(["agent", "human", "system"], ["released", "lease_expired"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  on_hold: {
    in_progress: rule(["agent", "human"], ["resume"]),
    ready: rule(["human"], ["reopened"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  pending_verification: {
    done: rule(["human"], ["verification_passed"]),
    ready: rule(["human"], ["verification_failed"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  done: {
    ready: rule(["human"], ["reopened"]),
  },
  cancelled: {
    inbox: rule(["human"], ["restored"]),
  },
};

export function evaluateWorkItemTransition(request: WorkItemTransitionRequest): WorkItemTransitionDecision {
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
      message: `${request.actor} cannot transition a work item from ${request.from} to ${request.to}.`,
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

export function assertWorkItemTransition(request: WorkItemTransitionRequest): void {
  const decision = evaluateWorkItemTransition(request);
  if (!decision.allowed) {
    throw new Error(decision.message);
  }
}
