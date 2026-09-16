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
  /** Why the item is moving. Required on the edges `transitionRequiresNote` names. */
  readonly note?: string;
}

export interface WorkItemTransitionDecision {
  readonly allowed: boolean;
  readonly code: "allowed" | "invalid_transition" | "actor_not_allowed" | "reason_mismatch" | "note_required";
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
 * How much room a transition note has. Long enough for what failed and what the
 * next attempt needs to know; short enough that the timeline stays readable.
 *
 * Deliberately below the 4,000 a pull-request summary gets: that one is written
 * once by a machine, this one is typed by a person who is annoyed.
 */
export const TRANSITION_NOTE_MAX_LENGTH = 2_000;

/**
 * Coming back to `ready` from one of these means work was already done and the
 * result did not hold. Whoever dispatches the item next -- and whichever AI
 * picks it up -- has no other place to learn why, so the move has to say it.
 *
 * `inbox` is absent on purpose: triaging a draft into the queue is the first
 * pass, not a retreat from one.
 */
const NOTE_REQUIRED_FROM = new Set<WorkItemStatus>(["in_progress", "pending_verification", "on_hold", "done"]);

/**
 * Whether this edge has to carry a note.
 *
 * Keyed on from/to rather than on the reason, because `reopened` serves both
 * `on_hold -> ready` and `ready -> inbox`, and only the first of those is a
 * retreat. Keying on the reason would demand a note for sending a queued item
 * back to drafts, which explains nothing to anybody.
 */
export function transitionRequiresNote(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return to === "ready" && NOTE_REQUIRED_FROM.has(from);
}

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

/** The note this edge needs and did not get. */
function noteMissing(request: WorkItemTransitionRequest): boolean {
  return transitionRequiresNote(request.from, request.to) && !(request.note ?? "").trim();
}

const NOTE_REQUIRED = (request: WorkItemTransitionRequest): WorkItemTransitionDecision => ({
  allowed: false,
  code: "note_required",
  message: `Moving a work item from ${request.from} back to ready requires a note saying why.`,
});

export function evaluateWorkItemTransition(request: WorkItemTransitionRequest): WorkItemTransitionDecision {
  const transition = TRANSITIONS[request.from]?.[request.to];

  if (isManualOverride(request)) {
    // Checked here too, and not once at the top, so that an edge an actor may not
    // walk at all still says so rather than complaining about a missing note. The
    // requirement belongs to the edge, not to the reason written on it: leaving
    // the override exempt would keep one path back to `ready` that explains
    // nothing, and that is the path somebody in a hurry would find.
    return noteMissing(request)
      ? NOTE_REQUIRED(request)
      : { allowed: true, code: "allowed", message: "Transition is allowed." };
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

  if (noteMissing(request)) return NOTE_REQUIRED(request);

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
