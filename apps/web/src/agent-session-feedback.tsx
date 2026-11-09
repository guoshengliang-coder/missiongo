import { useId, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, CircleCheck, CircleDot, CirclePause, LoaderCircle } from "lucide-react";
import { useI18n } from "./i18n";
import type { AgentSessionStatus } from "./types";
import type { OutgoingReply } from "./agent-session-view";

export function isHistoryLimited(error: string | undefined): boolean {
  return error?.startsWith("codex_history_limited:") === true || error?.startsWith("agent_history_limited:") === true;
}

export function isThreadNotLoaded(error:string|undefined):boolean {
  return Boolean(error && (/thread not loaded/i.test(error) || error.includes("会话未在当前 Codex 运行时加载")));
}

/** Keep the actionable recovery instruction separate from the source diagnostic. */
export function AgentSessionError({error,onRetry}:{error:string;onRetry:()=>void}) {
  const {t}=useI18n();
  if(!isThreadNotLoaded(error)) return <p className="inline-error">{error}</p>;
  return <div className="inline-error"><p role="status">{t("agentThreadNotLoaded")}</p>
    <details><summary>{t("executionStopDiagnostic")}</summary><p>{error}</p></details>
    <button type="button" className="secondary-button" onClick={onRetry}>{t("retry")}</button></div>;
}

/** History availability is independent of runtime and message delivery. */
export function AgentHistoryNotice({ error }: { error: string | undefined }) {
  const { t } = useI18n();
  return isHistoryLimited(error)
    ? <p className="agent-console-attention-banner" role="status">{t("agentHistoryLimited")}</p> : null;
}

/** Delivery sits outside the message bubble and never implies execution. */
const replyFeedbackKeys = {
  sending: "agentReplySendingShort",
  queued: "agentReplyQueuedShort",
  delivering: "agentReplyDeliveringShort",
  delivered: "agentReplyDeliveredShort",
} as const;

export function AgentReplyFeedback({ status, cancelling = false, onEdit }: {
  status: OutgoingReply["status"]; cancelling?: boolean; onEdit?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  if (status === "failed" || status === "delivery_unknown") return null;
  const Icon = status === "delivered" ? CircleCheck : LoaderCircle;
  return <footer className="agent-reply-feedback">
    <span className="agent-reply-current">
      <span className="agent-reply-state" role="status">
        <Icon className={status === "delivered" ? undefined : "agent-reply-spin"} size={12} aria-hidden="true" />
        {t(replyFeedbackKeys[status])}
      </span>
      {status === "queued" && onEdit && <button type="button" className="agent-reply-edit" disabled={cancelling} onClick={onEdit}>
        {t(cancelling ? "agentSessionCancelling" : "agentReplyEditShort")}
      </button>}
    </span>
  </footer>;
}

/**
 * Foreground and background activity both run; waiting for input is its own
 * state (AND-448): the turn has ended, so a spinner would misreport it, but a
 * check mark reads as finished work. A paused icon says "your move".
 */
export function SessionStatusIcon({ status }: { status: AgentSessionStatus | "waiting" }) {
  if (status === "active") return <LoaderCircle className="spin agent-session-running" size={14} />;
  if (status === "waiting") return <CirclePause className="agent-session-waiting" size={14} />;
  if (status === "idle") return <CircleCheck size={14} />;
  if (status === "failed" || status === "stalled") return <CircleAlert size={14} />;
  return <CircleDot size={14} />;
}

/** One disclosure owns timing and waiting diagnostics; actions stay outside it. */
export function AgentRunDetails({ label, icon, status, children, actions }: {
  label: string; icon?: ReactNode; status: string; children: ReactNode; actions?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const diagnosticsId = useId();
  return <div className="agent-run-group">
    <div className="agent-run-controls">
      <details className="agent-run-details" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary aria-controls={diagnosticsId} aria-label={`${label} · ${t("agentRunDetails")}`} className={`agent-console-activity agent-console-activity-${status}`}>
          {icon && <span className="agent-run-icon" aria-hidden="true">{icon}</span>}
          <span role="status">{label}</span>
          <span className="agent-run-disclosure"><ChevronDown size={12} aria-hidden="true" /></span>
        </summary>
      </details>
      {actions}
    </div>
    <div id={diagnosticsId} className="agent-run-diagnostics" hidden={!open}>{children}</div>
  </div>;
}
