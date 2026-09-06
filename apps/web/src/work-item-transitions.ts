import { ITEM_STATUSES, type TransitionAction, type WorkItemStatus } from "./types";

// The domain allows a human to cancel from every status except `done` and
// `cancelled` itself; keep this table in sync with packages/domain/src/work-item-status.ts.
const CANCEL_ACTION: TransitionAction = { label: "Cancel", to: "cancelled", reason: "cancelled", tone: "danger" };

export const TRANSITIONS: Record<WorkItemStatus, readonly TransitionAction[]> = {
  inbox: [
    { label: "Move to ready", to: "ready", reason: "triaged", tone: "primary" },
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
      label: "Submit for verification",
      to: "pending_verification",
      reason: "resolution_submitted",
      tone: "primary",
    },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    { label: "Release", to: "ready", reason: "released" },
    CANCEL_ACTION,
  ],
  on_hold: [
    { label: "Resume work", to: "in_progress", reason: "resume", tone: "primary" },
    { label: "Return to ready", to: "ready", reason: "reopened" },
    CANCEL_ACTION,
  ],
  pending_verification: [
    { label: "Verify & close", to: "done", reason: "verification_passed", tone: "positive" },
    { label: "Needs more work", to: "ready", reason: "verification_failed" },
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
export function manualMoves(from: WorkItemStatus): readonly TransitionAction[] {
  const offered = new Set(TRANSITIONS[from].map((action) => action.to));
  return ITEM_STATUSES.filter((status) => status !== from && !offered.has(status)).map((status) => ({
    label: status,
    to: status,
    reason: "manual_override" as const,
  }));
}
