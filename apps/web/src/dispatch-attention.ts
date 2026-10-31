import type { ItemDispatchSummary, WorkItemStatus, WorkItem } from "./types";
import type { MessageKey } from "./i18n";

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

export function itemProgressKeys(item: Pick<WorkItem,"status"|"deliveryProgress">, current?: ItemDispatchSummary) {
  const keys: MessageKey[] = [];
  if (current?.waitingForInput) keys.push("itemWaitingAnswer" as const);
  if (item.deliveryProgress) {
    keys.push(({
      waiting_merge:"itemWaitingMerge",waiting_release:"itemWaitingRelease",needs_scope:"itemReleaseScopeNeeded",
      no_release:"itemNoRelease",review_required:"itemDeliveryReview",blocked:"itemDeliveryBlocked",
    } as const)[item.deliveryProgress]);
  } else if (current) {
    if (item.status === "ready" || item.status === "inbox") keys.push(current.claimed ? "itemClaimed" as const : "itemUnclaimed" as const);
    else if (current.sessionStatus === "idle") keys.push("agentSessionIdle" as const);
    else if (!current.waitingForInput && current.sessionStatus === "active") keys.push("agentSessionActive" as const);
  }
  return keys;
}
