import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { useI18n } from "./i18n";
import type { AgentSessionMessage, AgentSessionStatus } from "./types";

function messageLabel(role: AgentSessionMessage["role"], t: ReturnType<typeof useI18n>["t"]): string {
  if (role === "user") return t("agentSessionYou");
  if (role === "plan") return t("agentSessionPlan");
  return t("agentSessionCodex");
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
  const pending = session.data?.command?.status === "queued";
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
                    <small>{messageLabel(message.role, t)}</small>
                    <p>{message.text}</p>
                    {message.questions?.map((question) => (
                      <div key={question.title} className="agent-session-question">
                        <strong>{question.title}</strong>
                        {question.options && (
                          <div className="agent-session-options">
                            {question.options.map((option) => (
                              <button key={option} type="button" disabled={!canReply} onClick={() => setReply(option)}>{option}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
              </div>
              {session.data.lastError && <p className="inline-error">{session.data.lastError}</p>}
              {session.data.command && (
                <p className={`agent-session-command agent-session-command-${session.data.command.status}`}>
                  {session.data.command.status === "queued" && t("agentSessionReplyQueued")}
                  {session.data.command.status === "delivered" && t("agentSessionReplyDelivered")}
                  {session.data.command.status === "failed" && t("agentSessionReplyFailed")}
                  {session.data.command.error ? `: ${session.data.command.error}` : ""}
                </p>
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
