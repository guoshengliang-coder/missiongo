import { ITEM_STATUSES, type TransitionAction, type WorkItem, type WorkItemStatus } from "./types";

// The domain allows a human to cancel from every status except `done` and
// `cancelled` itself; keep this table in sync with packages/domain/src/work-item-status.ts.
const CANCEL_ACTION: TransitionAction = { label: "Cancel", to: "cancelled", reason: "cancelled", tone: "danger" };

export const TRANSITIONS: Record<WorkItemStatus, readonly TransitionAction[]> = {
  inbox: [
    { label: "Move to ready", to: "ready", reason: "triaged", tone: "primary" },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    CANCEL_ACTION,
  ],
  ready: [
    { label: "Start work", to: "in_progress", reason: "claim", tone: "primary" },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    { label: "Move to inbox", to: "inbox", reason: "reopened" },
    CANCEL_ACTION,
  ],
  in_progress: [
    {
      label: "Mark development complete",
      to: "development_complete",
      reason: "resolution_submitted",
      tone: "primary",
    },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    { label: "Release", to: "ready", reason: "released" },
    CANCEL_ACTION,
  ],
  development_complete: [
    { label: "Submit published work for verification", to: "pending_verification", reason: "release_verified", tone: "primary" },
    { label: "Needs more work", to: "ready", reason: "released" },
    CANCEL_ACTION,
  ],
  on_hold: [
    { label: "Resume work", to: "in_progress", reason: "resume", tone: "primary" },
    { label: "Return to ready", to: "ready", reason: "resume" },
    { label: "Move to inbox", to: "inbox", reason: "resume" },
    CANCEL_ACTION,
  ],
  pending_verification: [
    { label: "Verify & close", to: "done", reason: "verification_passed", tone: "positive" },
    { label: "Verification failed", to: "ready", reason: "verification_failed" },
    CANCEL_ACTION,
  ],
  done: [{ label: "Reopen", to: "ready", reason: "reopened", tone: "primary" }],
  cancelled: [{ label: "Restore", to: "inbox", reason: "restored", tone: "primary" }],
};

/**
 * Everywhere else a person can send the item. The table above is the pipeline
 * and its labels describe what happened ("Verify & close"); these are the plain
 * jumps for when it already happened somewhere else, so they are labelled with
 * the destination and recorded as `manual_override`. Statuses the pipeline
 * already offers are left out — the semantic action should win.
 */
export function manualMoves(from: WorkItemStatus, actions = TRANSITIONS[from]): readonly TransitionAction[] {
  if (from === "done" || from === "cancelled") return [];
  const offered = new Set(actions.map((action) => action.to));
  return ITEM_STATUSES.filter((status) => status !== from && !offered.has(status)).map((status) => ({
    label: status,
    to: status,
    reason: "manual_override" as const,
  }));
}

/** Share the permission filter across list, detail and manual status menus. */
export function itemTransitionActions(item: WorkItem) {
  const allowed = (action: TransitionAction) => !item.transferred
    && (item.transitionDecisions
      ? item.transitionDecisions.some(d => d.to === action.to && d.reason === action.reason && d.allowed)
      : action.to === "done" ? item.access?.canVerify === true : item.access?.canOperate !== false);
  const offered = item.status === "on_hold" ? TRANSITIONS.on_hold.filter(a=>a.to === "cancelled" || a.to === item.heldFrom) : TRANSITIONS[item.status];
  const primaryAction = offered[0] && allowed(offered[0]) ? offered[0] : undefined;
  return {
    primaryAction,
    secondaryActions: offered.slice(1).filter(allowed),
    manualTargets: manualMoves(item.status,offered.filter(allowed)).filter(allowed),
  };
}

export function canSelectForVerification(item: WorkItem): boolean {
  return item.status === "pending_verification" && !item.transferred && item.access?.canVerify === true;
}
