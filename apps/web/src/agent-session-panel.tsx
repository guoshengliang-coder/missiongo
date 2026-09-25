import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { formatAgentMessageTime, replyBlockedLabelKey } from "./agent-session-view";
import { AgentSessionQuestions } from "./agent-session-questions";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import type { AgentSessionMessage, AgentSessionStatus } from "./types";
import { AutoGrowTextarea } from "./auto-grow-textarea";

function messageLabel(
  role: AgentSessionMessage["role"],
  agentKind: "codex" | "claude_code" | "opencode",
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (role === "user") return t("agentSessionYou");
  if (role === "plan") return t("agentSessionPlan");
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
  const session = useQuery({
    queryKey: ["agent-session", sessionId],
    queryFn: () => api.getAgentSession(sessionId),
    enabled: open,
    refetchInterval: open ? 2_000 : false,
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
  const command = session.data?.command;
  const canReply = session.data?.canReply === true;
  const pending = command?.status === "queued" || command?.status === "delivering";
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
                  {statusLabel(session.data.status, t)}
                </span>
              </header>
              {session.data.messages.length === 0 && (
                <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>
              )}
              <div className="agent-session-messages">
                {session.data.messages.map((message) => (
                  <article key={message.id} className={`agent-session-message agent-session-message-${message.role}`}>
                    <header className="agent-session-message-meta">
                      <small>{messageLabel(message.role, session.data.agentKind, t)}</small>
                      <time dateTime={message.occurredAt}>{formatAgentMessageTime(message.occurredAt, locale)}</time>
                    </header>
                    <p>{message.text}</p>
                    {message.questions && (
                      <AgentSessionQuestions
                        questions={message.questions}
                        reply={reply}
                        canReply={canReply}
                        onChange={setReply}
                      />
                    )}
                  </article>
                ))}
                {session.data.activities.length > 0 && (
                  <section className="agent-session-background" aria-label={t("agentSessionBackgroundTitle")}>
                    <strong>{t("agentSessionBackgroundCount", { count: session.data.activities.length })}</strong>
                    <ul>{session.data.activities.map((activity) => (
                      <li key={activity.id}>{activity.title}</li>
                    ))}</ul>
                  </section>
                )}
              </div>
              {session.data.lastError && <p className="inline-error">{session.data.lastError}</p>}
              {command && (
                <div className={`agent-session-command agent-session-command-${command.status}`}>
                  <span>
                    {command.status === "queued" && t("agentSessionReplyQueued")}
                    {command.status === "delivering" && t("agentSessionReplyDelivering")}
                    {command.status === "delivered" && t("agentSessionReplyDelivered")}
                    {command.status === "failed" && t("agentSessionReplyFailed")}
                    {command.status === "cancelled" && t("agentSessionReplyCancelled")}
                    {command.error ? `: ${command.error}` : ""}
                  </span>
                  {command.status === "queued" && canReply && (
                    <button
                      type="button"
                      className="text-button agent-session-cancel"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate({ commandId: command.id, text: command.text })}
                    >
                      {cancel.isPending ? t("agentSessionCancelling") : t("agentSessionCancelAndEdit")}
                    </button>
                  )}
                </div>
              )}
              {canReply ? (
                <>
                  <form className="agent-session-reply" onSubmit={submit}>
                    <AutoGrowTextarea
                      rows={1}
                      maximumHeight={240}
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
