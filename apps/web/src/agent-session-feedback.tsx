import type { ReactNode } from "react";
import { ChevronDown, CircleCheck, Clock3, Pencil, Send } from "lucide-react";
import { useI18n } from "./i18n";
import type { OutgoingReply } from "./agent-session-view";

/** Delivery describes a message, never whether the Agent has started its turn. */
export function AgentReplyFeedback({ status, cancelling = false, onEdit }: {
  status: OutgoingReply["status"]; cancelling?: boolean; onEdit?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  if (status === "failed" || status === "delivery_unknown") return null;
  const key = { sending: "agentReplySendingShort", queued: "agentReplyQueuedShort",
    delivering: "agentReplyDeliveringShort", delivered: "agentReplyDeliveredShort" } as const;
  const Icon = status === "delivered" ? CircleCheck : status === "queued" ? Clock3 : Send;
  return <footer className="agent-reply-feedback">
    <span className="agent-reply-state" role="status"><Icon size={12} aria-hidden="true" />{t(key[status])}</span>
    {status === "queued" && onEdit && <button type="button" className="agent-reply-edit" disabled={cancelling} onClick={onEdit}>
      <Pencil size={12} aria-hidden="true" />{t(cancelling ? "agentSessionCancelling" : "agentReplyEditShort")}
    </button>}
  </footer>;
}

/** One disclosure owns timing and waiting diagnostics; actions stay outside it. */
export function AgentRunDetails({ label, icon, status, children }: {
  label: string; icon?: ReactNode; status: string; children: ReactNode;
}) {
  const { t } = useI18n();
  return <details className="agent-run-details">
    <summary className={`agent-console-activity agent-console-activity-${status}`}>
      {icon && <span className="agent-run-icon" aria-hidden="true">{icon}</span>}
      <span role="status">{label}</span>
      <span className="agent-run-disclosure">{t("agentRunDetails")}<ChevronDown size={12} aria-hidden="true" /></span>
    </summary>
    <div className="agent-run-diagnostics">{children}</div>
  </details>;
}
