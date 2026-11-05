import { AgentStopFeedback } from "./agent-stop-feedback.js";
import { useState, useEffect, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentHistoryNotice, AgentReplyFeedback, AgentRunDetails, SessionStatusIcon, isHistoryLimited } from "./agent-session-feedback";
import { MarkdownText } from "./markdown-text";
import { AgentArtifactMarkdown } from "./agent-artifact-viewer";
import { api } from "./api";
import { activityLabelKey, agentSessionDetailRefetchInterval, formatAgentMessageTime, isWithdrawnCard, replyBlockedLabelKey } from "./agent-session-view";
import { AgentSessionQuestions } from "./agent-session-questions";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import type { AgentSessionMessage, AgentSessionStatus } from "./types";
import { AutoGrowTextarea } from "./auto-grow-textarea";

function messageLabel(
  role: AgentSessionMessage["role"],
  agentKind: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (role === "user") return t("agentSessionYou");
  if (role === "plan") return t("agentSessionPlan");
  if (agentKind === "other") return t("agentExternalOther");
  if (agentKind === "hermes") return t("agentHermes");
  return t(agentKind === "claude_code" ? "agentClaudeCode" : agentKind === "opencode" ? "agentOpenCode" : "agentSessionCodex");
}

function statusLabel(status: AgentSessionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "active") return t("agentSessionActive");
  if (status === "idle") return t("agentSessionIdle");
  if (status === "suspended") return t("agentSessionSuspended");
  if (status === "stalled") return t("agentSessionStalled");
  if (status === "failed") return t("agentSessionFailed");
  return t("agentSessionUnavailable");
}

export function AgentSessionPanel({ sessionId }: { sessionId: string }) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const session = useQuery({
    queryKey: ["agent-session", sessionId],
    queryFn: () => api.getAgentSession(sessionId),
    enabled: open,
    // AND-383: this panel used to poll every 2s unconditionally; it now shares
    // the console's visibility-aware interval with failure backoff, so a slow
    // server is asked less often instead of being hammered at a fixed rate.
    refetchInterval: (query) => open
      ? agentSessionDetailRefetchInterval(documentVisible, query.state.fetchFailureCount)
      : false,
  });
  const send = useMutation({
    mutationFn: (text: string) => api.sendAgentSessionCommand(sessionId, text),
    onSuccess: async () => {
      setReply("");
      await queryClient.invalidateQueries({ queryKey: ["agent-session", sessionId] });
    },
  });
  const cancel = useMutation({
    mutationFn: ({ commandId }: { commandId: string; text: string }) =>
      api.cancelAgentSessionCommand(sessionId, commandId),
    onSuccess: async (_command, input) => {
      setReply(input.text);
      await queryClient.invalidateQueries({ queryKey: ["agent-session", sessionId] });
    },
  });
  const resolveDelivery = useMutation({
    mutationFn: ({ commandId, outcome }: { commandId: string; outcome: "received" | "not_received" }) =>
      api.resolveAgentSessionDelivery(sessionId, commandId, outcome),
    onSuccess: async (command, input) => {
      if (input.outcome === "not_received") setReply(command.text);
      await queryClient.invalidateQueries({ queryKey: ["agent-session", sessionId] });
    },
  });
  const command = session.data?.command;
  const canReply = session.data?.canReply === true;
  // A reply can go to any agent the console runs, so the delivery lines name
  // this session's own one instead of saying Codex (AND-253).
  const agentName = session.data ? messageLabel("agent", session.data.agentKind, t) : "";
  const pending = command?.status === "queued" || command?.status === "delivering"
    || command?.status === "delivery_unknown";
  const waiting = session.data !== undefined && ["active", "idle"].includes(session.data.status)
    && (!pending || session.data.agentKind === "codex") && session.data.turnState?.waitingForInput === true;
  const backgroundOnly = session.data?.agentKind === "claude_code" && session.data.status === "active"
    && session.data.turnState?.turnActive === false && !waiting && session.data.activities.length > 0;
  const visualStatus = waiting ? "idle" : session.data?.status ?? "idle";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (text && !pending && !send.isPending) send.mutate(text);
  };

  return (
    <div className="agent-session-panel">
      <button type="button" className="text-button agent-session-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? t("agentSessionHide") : t(canReply ? "agentSessionOpen" : "agentSessionOpenReadOnly")}
      </button>
      {open && (
        <div className="agent-session-body">
          {session.isLoading && <small className="agent-session-muted">{t("agentSessionLoading")}</small>}
          {session.isError && <p className="inline-error">{localizedErrorText(session.error, t)}</p>}
          {session.data && (
            <>
              <header className="agent-session-head">
                <strong>{t("agentSessionTitle")}</strong>
                <span className={`status-pill agent-session-status-${session.data.status}`}>
                  {waiting ? t(session.data.agentKind === "codex" ? "agentSessionWaitingApprovalStatus" : "agentSessionWaitingStatus")
                    : backgroundOnly ? t("agentSessionBackgroundStatus") : statusLabel(session.data.status, t)}
                </span>
              </header>
              {session.data.messages.length === 0 && (
                <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>
              )}
              <div className="agent-session-messages">
                {session.data.messages.filter((message) => !isWithdrawnCard(message)).map((message) => (
                  <article key={message.id} className={`agent-session-message agent-session-message-${message.role}`}>
                    <header className="agent-session-message-meta">
                      <small>{messageLabel(message.role, session.data.agentKind, t)}</small>
                      <time dateTime={message.occurredAt}>{formatAgentMessageTime(message.occurredAt, locale)}</time>
                    </header>
                    {message.role === "user" ? <MarkdownText>{message.text}</MarkdownText> : <AgentArtifactMarkdown text={message.text} sessionId={sessionId} messageId={message.id} />}
                    {message.questions && (
                      <AgentSessionQuestions
                        questions={message.questions}
                        reply={reply}
                        canReply={canReply && !pending && !send.isPending}
                        onChange={setReply}
                      />
                    )}
                  </article>
                ))}
              </div>
              <AgentRunDetails status={visualStatus} icon={<SessionStatusIcon status={visualStatus} />} label={waiting
                ? t(session.data.agentKind === "codex" ? "agentRunApproval" : "agentRunWaiting", { agent: agentName })
                : backgroundOnly ? t("agentRunBackground") : session.data.status === "active" ? t("agentRunActive", { agent: agentName }) : statusLabel(session.data.status, t)}>
                <p>{t(activityLabelKey(session.data.status, command?.status === "queued"), { agent: agentName })}</p>
                {session.data.activities.length > 0 && (
                  <section className="agent-session-background" aria-label={t("agentSessionBackgroundTitle")}>
                    <strong>{t("agentSessionBackgroundCount", { count: session.data.activities.length })}</strong>
                    <ul>{session.data.activities.map((activity) => (
                      <li key={activity.id}>{activity.title}
                        {activity.startedAt && <small> · {t("agentSessionBackgroundElapsed", { duration: Math.max(0, Math.floor((Date.now() - Date.parse(activity.startedAt)) / 60_000)) + "m" })}</small>}
                        {canReply && !pending && !send.isPending && <button type="button" className="text-button"
                          onClick={() => setReply(t("agentSessionStopTaskMessage", { title: activity.title, id: activity.id }))}>
                          {t("agentSessionRequestTaskStop")}
                        </button>}
                        {command?.kind === "message" && !["failed", "cancelled"].includes(command.status)
                          && command.text === t("agentSessionStopTaskMessage", { title: activity.title, id: activity.id })
                          && <small>{t("agentSessionTaskStopSent")}</small>}
                      </li>
                    ))}</ul>
                  </section>
                )}
              </AgentRunDetails>
              <AgentHistoryNotice error={session.data.lastError} />
              {session.data.lastError && !isHistoryLimited(session.data.lastError) && <p className="inline-error">{session.data.lastError}</p>}
              <AgentStopFeedback stop={session.data.stopCommand ?? (command?.kind === "interrupt" ? command : undefined)}
                latestCommand={command} turnActive={session.data.turnState?.turnActive ?? false} backgroundRunning={session.data.activities.length > 0} />
              {command?.kind === "message" && (
                <div className={`agent-session-command agent-session-command-${command.status}`}>
                  <span>
                    {command.status === "delivery_unknown" && t("agentSessionReplyDeliveryUnknown", { agent: agentName })}
                    {command.status === "failed" && t("agentSessionReplyFailed")}
                    {command.status === "cancelled" && t("agentSessionReplyCancelled")}
                    {command.error ? `: ${command.error}` : ""}
                  </span>
                  {command.kind === "message" && command.status !== "cancelled" && <AgentReplyFeedback status={command.status} cancelling={cancel.isPending}
                    onEdit={canReply ? () => cancel.mutate({ commandId: command.id, text: command.text }) : undefined} />}
                  {command.status === "delivery_unknown" && session.data.canResolveDelivery && (
                    <>
                      <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                        onClick={() => resolveDelivery.mutate({ commandId: command.id, outcome: "received" })}>
                        {t("agentSessionReplyConfirmReceived", { agent: agentName })}
                      </button>
                      <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                        onClick={() => resolveDelivery.mutate({ commandId: command.id, outcome: "not_received" })}>
                        {t("agentSessionReplyConfirmNotReceived")}
                      </button>
                    </>
                  )}
                </div>
              )}
              {canReply ? (
                <>
                  <form className="agent-session-reply" onSubmit={submit}>
                    <AutoGrowTextarea
                      rows={1}
                      maximumHeight={240}
                      submitOnEnter
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      placeholder={t("agentSessionReplyPlaceholder", {
                        agent: messageLabel("agent", session.data.agentKind, t),
                      })}
                      disabled={pending || send.isPending}
                    />
                    <button type="submit" className="primary-button" disabled={!reply.trim() || pending || send.isPending}>
                      {send.isPending ? t("agentSessionSending") : t("agentSessionSend")}
                    </button>
                  </form>
                  {send.isError && <p className="inline-error">{localizedErrorText(send.error, t)}</p>}
                  {cancel.isError && <p className="inline-error">{localizedErrorText(cancel.error, t)}</p>}
                  {resolveDelivery.isError && <p className="inline-error">{localizedErrorText(resolveDelivery.error, t)}</p>}
                </>
              ) : (
                <p className="agent-session-muted" role="note">
                  {t(replyBlockedLabelKey(session.data.replyBlockedReason))}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
