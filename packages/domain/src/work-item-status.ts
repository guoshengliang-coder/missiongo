import type { WorkItemStatus } from "./work-item.js";

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const TRANSITION_REASONS = [
  "triaged",
  "claim",
  "request_human_input",
  "resume",
  "resolution_submitted",
  "verification_passed",
  "verification_failed",
  "lease_expired",
  "released",
  "cancelled",
  "reopened",
  "restored",
  "manual_override",
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

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
    // One of the two edges an agent may walk: it picks work up here. `resume` is
    // deliberately absent -- it belongs to on_hold, and leaving it in this list
    // handed an agent a second path it was never meant to have, because a rule
    // is the cartesian product of its actors and its reasons.
    in_progress: rule(["agent", "human"], ["claim"]),
    on_hold: rule(["human"], ["request_human_input"]),
    inbox: rule(["human"], ["reopened"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  in_progress: {
    on_hold: rule(["human"], ["request_human_input"]),
    // The other agent edge: the change is merged, so the work is a person's to
    // verify. An agent may say that much because a merged pull request is a fact
    // it can check. What the change is worth, whether it shipped, and whether it
    // should have been abandoned instead are judgements, and they stay below.
    pending_verification: rule(["agent", "human"], ["resolution_submitted"]),
    ready: rule(["human"], ["released"]),
    cancelled: rule(["human"], ["cancelled"]),
  },
  on_hold: {
    in_progress: rule(["human"], ["resume"]),
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

/**
 * The table above is the pipeline: it is what an agent may do, and it is how a
 * person moves an item when the pipeline describes what actually happened. But
 * a person also knows things the pipeline does not — an item was already fixed,
 * or was filed under the wrong status — and making them walk three transitions
 * to say so is busywork. `manual_override` lets a person move an item straight
 * to any other status, and names itself in the timeline so a jump is never
 * mistaken for a step that was really taken. Agents and the system stay bound
 * by the table, so "only a person closes verification" still holds.
 */
function isManualOverride(request: WorkItemTransitionRequest): boolean {
  return request.actor === "human" && request.reason === "manual_override" && request.from !== request.to;
}

export function evaluateWorkItemTransition(request: WorkItemTransitionRequest): WorkItemTransitionDecision {
  const transition = TRANSITIONS[request.from]?.[request.to];

  if (isManualOverride(request)) {
    return { allowed: true, code: "allowed", message: "Transition is allowed." };
  }

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
