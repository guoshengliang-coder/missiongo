import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { questionAnswerText } from "./agent-session-view";
import { useI18n } from "./i18n";
import type { AgentSessionMessage, AgentSessionStatus } from "./types";

function messageLabel(
  role: AgentSessionMessage["role"],
  agentKind: "codex" | "claude_code",
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (role === "user") return t("agentSessionYou");
  if (role === "plan") return t("agentSessionPlan");
  return t(agentKind === "claude_code" ? "agentClaudeCode" : "agentSessionCodex");
}

function statusLabel(status: AgentSessionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "active") return t("agentSessionActive");
  if (status === "idle") return t("agentSessionIdle");
  if (status === "failed") return t("agentSessionFailed");
  return t("agentSessionUnavailable");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentSessionPanel({ sessionId, canReply }: { sessionId: string; canReply: boolean }) {
  const { t } = useI18n();
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
          {session.isError && <p className="inline-error">{errorText(session.error)}</p>}
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
                    <small>{messageLabel(message.role, session.data.agentKind, t)}</small>
                    <p>{message.text}</p>
                    {message.questions?.map((question) => (
                      <div key={question.title} className="agent-session-question">
                        {question.header && <small>{question.header}</small>}
                        <strong>{question.title}</strong>
                        {question.options && (
                          <div className="agent-session-options">
                            {question.options.map((option) => (
                              <button
                                key={option}
                                type="button"
                                disabled={!canReply}
                                onClick={() => setReply((current) => questionAnswerText(
                                  current,
                                  question,
                                  option,
                                  message.questions?.length ?? 1,
                                ))}
                              >{option}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
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
                    <textarea
                      rows={3}
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      placeholder={t("agentSessionReplyPlaceholder")}
                      disabled={pending || send.isPending}
                    />
                    <button type="submit" className="primary-button" disabled={!reply.trim() || pending || send.isPending}>
                      {send.isPending ? t("agentSessionSending") : t("agentSessionSend")}
                    </button>
                  </form>
                  {send.isError && <p className="inline-error">{errorText(send.error)}</p>}
                  {cancel.isError && <p className="inline-error">{errorText(cancel.error)}</p>}
                </>
              ) : (
                <p className="agent-session-muted" role="note">{t("agentSessionReadOnly")}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
