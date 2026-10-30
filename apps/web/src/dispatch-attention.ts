import type { ItemDispatchSummary, WorkItemStatus } from "./types";

/** A stale poll from a different work stage cannot raise a current alert. */
export function currentDispatchForStatus(
  status: WorkItemStatus,
  current: ItemDispatchSummary | undefined,
): ItemDispatchSummary | undefined {
  return (status === "ready" || status === "in_progress") && current?.itemStatus === status
    ? current : undefined;
}

export function dispatchIssueLabelKey(issue: NonNullable<ItemDispatchSummary["issue"]>) {
  return issue.kind === "execution" ? "executionIssueBadge" as const : "failedDispatchBadge" as const;
}
