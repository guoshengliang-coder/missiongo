import { AlertTriangle, Info } from "lucide-react";

import { useI18n, type MessageKey } from "./i18n";
import type { WorkItemStatus } from "./types";

export type DetailStatusTone = "danger" | "warning" | "info";

export interface DetailStatusItem {
  readonly key: string;
  readonly messageKey: MessageKey;
  readonly tone: DetailStatusTone;
}

const toneRank: Record<DetailStatusTone, number> = { danger: 0, warning: 1, info: 2 };

function progressTone(key: MessageKey): DetailStatusTone {
  if (key === "itemDeliveryBlocked") return "danger";
  if (key === "itemDeliveryReview" || key === "itemWaitingMerge" || key === "itemWaitingRelease" || key === "itemReleaseScopeNeeded") return "warning";
  return "info";
}

/**
 * The work-state messages that sit above the title. Placement is deliberate:
 * these change what the reader should do next, while the title and Builder are
 * identity. Keeping them in one ordered list stops each new state from adding
 * another unstyled line of its own.
 */
export function detailStatusItems(input: {
  readonly status: WorkItemStatus;
  readonly canVerify: boolean | undefined;
  readonly executionDisposition: "keep_running" | "stop_requested" | undefined;
  readonly progressKeys: readonly MessageKey[];
}): DetailStatusItem[] {
  const items: DetailStatusItem[] = [];
  if (input.executionDisposition === "stop_requested") items.push({ key: "execution", messageKey: "executionStopRequested", tone: "warning" });
  else if (input.executionDisposition === "keep_running") items.push({ key: "execution", messageKey: "executionKeepRunning", tone: "info" });
  for (const key of input.progressKeys) items.push({ key, messageKey: key, tone: progressTone(key) });
  if (input.status === "pending_verification" && !input.canVerify) {
    items.push({ key: "verification", messageKey: "verificationNotPermitted", tone: "warning" });
  }
  return items.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
}

export function DetailStatusList({ items }: { items: readonly DetailStatusItem[] }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return <section className="detail-status" aria-label={t("detailStatusLabel")}>
    <ul className="detail-status-list">
      {items.map(item => {
        const Icon = item.tone === "info" ? Info : AlertTriangle;
        return <li key={item.key} className={`detail-status-item tone-${item.tone}`}>
          <Icon size={14} aria-hidden="true" />
          <span>{t(item.messageKey)}</span>
        </li>;
      })}
    </ul>
  </section>;
}
