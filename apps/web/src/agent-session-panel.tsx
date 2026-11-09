import { AgentPlanRecords } from "./agent-plan-records";
import { mergePreparationEvidence } from "./merge-preparation";
import { MergePreparationNotice } from "./merge-preparation-notice";
import { AgentProgressReports } from "./agent-progress-reports";
import { permissionReplyText } from "./permission-presentation";
import { DeliveryCards, IntegrationDetails, invalidateSessionDeliveries } from "./merge-console";
import { AgentOperationFeedback, useAgentOperationFeedback } from "./agent-operation-feedback";
import { AgentHistoryLoader, useAgentHistory } from "./agent-history";
import { UnlinkedPlanRecord, InlinePlanApproval, inlinePlanTranscript, currentPlan } from "./agent-plan-content";
import { AgentStopFeedback } from "./agent-stop-feedback.js";
import { useState, useLayoutEffect, useRef, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentHistoryNotice, AgentReplyFeedback, AgentRunDetails, SessionStatusIcon, isHistoryLimited, AgentSessionError } from "./agent-session-feedback";
import { MarkdownText } from "./markdown-text";
import { AgentArtifactMarkdown } from "./agent-artifact-viewer";
import { api } from "./api";
import { activityLabelKey, latestAgentSessionCommand, sessionReplyPresentation, agentSessionDetailRefetchInterval, formatAgentMessageTime, isWithdrawnCard, replyMirrorArrived, replyBlockedLabelKey, runWaitingLabelKey, sessionInlineError, sessionStatusDetail } from "./agent-session-view";
import { hasPendingPermissionQuestion } from "@missiongo/domain";
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

export function AgentSessionPanel({ sessionId, productId = "" }: { sessionId: string; productId?: string }) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const session = useQuery({
    queryKey: ["agent-session", sessionId],
    queryFn: () => api.getAgentSession(sessionId),
    enabled: open,
    // The page-wide SSE subscription invalidates this shared session cache.
  });
  const feedback = useAgentOperationFeedback(session.data && !session.isError ? {
    sessionId: session.data.id, checkedAt: session.dataUpdatedAt, detail: true, command: session.data.command,
    approval: session.data.approval, archivedAt: session.data.archivedAt,
  } : undefined);
  const messagesRef = useRef<HTMLDivElement>(null);
  const history = useAgentHistory(sessionId, session.data, messagesRef);
  const followLatest = useRef(true);
  const previousHistoryRevision = useRef(history.revision);
  useLayoutEffect(() => { followLatest.current = true; }, [sessionId, open]);
  useLayoutEffect(() => {
    const prepended = previousHistoryRevision.current !== history.revision;
    previousHistoryRevision.current = history.revision;
    const box = messagesRef.current;
    if (open && box && followLatest.current && !prepended) box.scrollTop = box.scrollHeight;
  }, [open, sessionId, history.messages, history.revision, session.data?.implementationPlan]);
  const send = useMutation({
    mutationFn: (input: { sessionId: string; text: string; preserveDraft?: true }) => api.sendAgentSessionCommand(input.sessionId, input.text),
    onMutate: input => feedback.begin(input.sessionId, "send"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async (_command, _input, operation) => {
      if (!operation) return;
      feedback.finish(operation);
      void invalidateSessionDeliveries(queryClient,operation.sessionId);
      if (currentSessionId.current === operation.sessionId && !_input.preserveDraft) setReply("");
      await queryClient.invalidateQueries({ queryKey: ["agent-session", operation.sessionId] });
    },
  });
  const cancel = useMutation({
    mutationFn: ({ sessionId: originalSessionId, commandId }: { sessionId: string; commandId: string; text: string }) =>
      api.cancelAgentSessionCommand(originalSessionId, commandId),
    onMutate: input => feedback.begin(input.sessionId, "cancel", { id: input.commandId }),
    onError: (error, _input, operation) => {
      feedback.fail(error, operation);
      if (operation) void queryClient.invalidateQueries({ queryKey: ["agent-session", operation.sessionId] });
    },
    onSuccess: async (_command, input, operation) => {
      if (!operation) return;
      feedback.finish(operation);
      if (currentSessionId.current === operation.sessionId) setReply(input.text);
      await queryClient.invalidateQueries({ queryKey: ["agent-session", operation.sessionId] });
    },
  });
  const resolveDelivery = useMutation({
    mutationFn: ({ sessionId: originalSessionId, commandId, outcome }: { sessionId: string; commandId: string; outcome: "received" | "not_received" }) =>
      api.resolveAgentSessionDelivery(originalSessionId, commandId, outcome),
    onMutate: input => feedback.begin(input.sessionId, "resolve", { id: input.commandId }),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async (command, input, operation) => {
      if (!operation) return;
      feedback.finish(operation);
      if (input.outcome === "not_received" && currentSessionId.current === operation.sessionId) setReply(command.text);
      await queryClient.invalidateQueries({ queryKey: ["agent-session", operation.sessionId] });
    },
  });
  const questionPermission = Boolean(session.data && hasPendingPermissionQuestion(session.data.agentKind, history.messages.filter(message => !message.id.startsWith("history:"))));
  const submittedCommand = send.isSuccess && send.variables?.sessionId === sessionId ? send.data : undefined;
  const command = latestAgentSessionCommand(session.data?.command, submittedCommand);
  const replyPresentation = sessionReplyPresentation(session.data?.status ?? "idle", command,
    send.isPending && send.variables?.sessionId === sessionId, session.data?.stopCommand);
  const canReply = session.data?.canReply === true;
  const mergePreparation = !questionPermission ? mergePreparationEvidence(session.data) : undefined;
  // A reply can go to any agent the console runs, so the delivery lines name
  // this session's own one instead of saying Codex (AND-253).
  const agentName = session.data ? messageLabel("agent", session.data.agentKind, t) : "";
  const pending = command?.status === "queued" || command?.status === "delivering"
    || command?.status === "delivery_unknown";
  const waiting = session.data !== undefined && ["active", "idle"].includes(session.data.status)
    && (!pending || session.data.agentKind === "codex") && session.data.turnState?.waitingForInput === true;
  const backgroundOnly = session.data?.agentKind === "claude_code" && session.data.status === "active"
    && session.data.turnState?.turnActive === false && !waiting && session.data.activities.length > 0;
  const visualStatus = replyPresentation?.visualStatus ?? (waiting ? "idle" : session.data?.status ?? "idle");
  const activityText = replyPresentation ? t(replyPresentation.labelKey) : session.data
    ? t(activityLabelKey(session.data.status, command?.status === "queued"), { agent: agentName }) : "";
  const inlineError = session.data ? sessionInlineError(session.data.status, session.data.lastError) : undefined;
  const statusDetail = session.data ? sessionStatusDetail(session.data.status, session.data.lastError, activityText) : activityText;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (text && !pending && !send.isPending) send.mutate({ sessionId, text });
  };

  const planMessages = inlinePlanTranscript(history.messages.filter(message => !isWithdrawnCard(message)), session.data);
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
                <AgentPlanRecords key={sessionId} session={session.data} />
                <IntegrationDetails productId={productId} sessionId={sessionId} />
              </header>
              {history.messages.length === 0 && (
                <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>
              )}
              <div className="agent-session-messages" ref={messagesRef} onScroll={event => {
                followLatest.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight <= 32;
                if (!history.error && event.currentTarget.scrollTop <= 48 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) void history.loadMore();
              }}>
                <AgentHistoryLoader history={history} />
                <AgentProgressReports session={session.data} />
                {planMessages.messages.map((message) => {
                  return (
                    <article key={message.id} data-agent-message-id={`${message.role}:${message.sourceId || message.id}`} className={`agent-session-message agent-session-message-${message.role}`}>
                      <header className="agent-session-message-meta">
                        <small>{messageLabel(message.role, session.data.agentKind, t)}</small>
                        <time dateTime={message.occurredAt}>{formatAgentMessageTime(message.occurredAt, locale)}</time>
                      </header>
                      {(message.role === "user" ? <MarkdownText>{permissionReplyText(session.data.messages.flatMap(message => message.questions ?? []), message.text)}</MarkdownText> : <AgentArtifactMarkdown text={message.text} sessionId={sessionId} messageId={message.id} />)}
                      {message.id === planMessages.planMessageId && <InlinePlanApproval onRequestChanges={()=>document.querySelector<HTMLTextAreaElement>(".agent-session-reply textarea")?.focus()} key={`${session.data.id}:${currentPlan(session.data)?.revision}`} session={session.data} blocked={questionPermission || pending || send.isPending} />}
                      {message.questions && (
                        <AgentSessionQuestions
                          questions={message.questions}
                          sessionId={sessionId}
                          sourceId={message.sourceId}
                          historical={message.id.startsWith("history:")}
                          agentKind={session.data.agentKind}
                          reply={reply}
                          canReply={canReply && !message.id.startsWith("history:") && !pending && !send.isPending}
                          onChange={setReply}
                        />                      )}
                    </article>
                  );
                })}
              </div>
              {!planMessages.planMessageId && <UnlinkedPlanRecord session={session.data} blocked={questionPermission || pending || send.isPending} />}
              <div className="agent-run-status" aria-label={t("agentRunFeedback")}>
                <AgentOperationFeedback failures={feedback.failures} sessionId={sessionId} onDismiss={feedback.finish} />
                <AgentStopFeedback stop={session.data.stopCommand ?? (command?.kind === "interrupt" ? command : undefined)}
                  latestCommand={command} turnActive={session.data.turnState?.turnActive ?? false} backgroundRunning={session.data.activities.length > 0} />
              <AgentRunDetails status={visualStatus} icon={<SessionStatusIcon status={replyPresentation?.iconStatus ?? (waiting ? "waiting" : visualStatus)} />} label={replyPresentation ? t(replyPresentation.labelKey) : waiting
                ? t(questionPermission ? "agentRunApproval" : runWaitingLabelKey(session.data), { agent: agentName })
                : backgroundOnly ? t("agentRunBackground") : session.data.status === "active" ? t("agentRunActive", { agent: agentName }) : statusLabel(session.data.status, t)}>
                <p>{statusDetail}</p>
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
              </div>
              <AgentHistoryNotice error={session.data.lastError} />
              {inlineError && !isHistoryLimited(inlineError) && <AgentSessionError error={inlineError} onRetry={()=>void session.refetch()} />}
              {command?.kind === "message" && !(command.status === "delivered"
                && replyMirrorArrived(command, history.messages, session.data.attachmentMessages ?? [])) && (
                <div className={`agent-session-command agent-session-command-${command.status}`}>
                  <span>
                    {command.status === "delivery_unknown" && t("agentSessionReplyDeliveryUnknown", { agent: agentName })}
                    {command.status === "failed" && t("agentSessionReplyFailed")}
                    {command.status === "cancelled" && t("agentSessionReplyCancelled")}
                    {command.error ? `: ${command.error}` : ""}
                  </span>
                  {command.kind === "message" && command.status !== "cancelled" && <AgentReplyFeedback status={command.status} cancelling={cancel.isPending}
                    onEdit={canReply ? () => cancel.mutate({ sessionId, commandId: command.id, text: command.text }) : undefined} />}
                  {command.status === "delivery_unknown" && session.data.canResolveDelivery && (
                    <>
                      <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                        onClick={() => resolveDelivery.mutate({ sessionId, commandId: command.id, outcome: "received" })}>
                        {t("agentSessionReplyConfirmReceived", { agent: agentName })}
                      </button>
                      <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                        onClick={() => resolveDelivery.mutate({ sessionId, commandId: command.id, outcome: "not_received" })}>
                        {t("agentSessionReplyConfirmNotReceived")}
                      </button>
                    </>
                  )}
                </div>
              )}
              {mergePreparation && <MergePreparationNotice key={mergePreparation.key} productId={productId}
                session={session.data} evidence={mergePreparation} blocked={pending || send.isPending}
                send={text => send.mutateAsync({ sessionId, text, preserveDraft: true })} />}
              <DeliveryCards productId={productId} sessionId={sessionId} blocked={pending || send.isPending} />
              {canReply ? (
                <>
                  <form className="agent-session-reply" onSubmit={submit}>
                    <AutoGrowTextarea
                      rows={1}
                      maximumHeight={240}
                      submitOnEnter
                      value={permissionReplyText(session.data.messages.flatMap(message => message.questions ?? []), reply)}
                      onChange={(event) => setReply(permissionReplyText(session.data.messages.flatMap(message => message.questions ?? []), event.target.value, true))}
                      placeholder={t("agentSessionReplyPlaceholder", {
                        agent: messageLabel("agent", session.data.agentKind, t),
                      })}
                      disabled={pending || send.isPending}
                    />
                    <button type="submit" className="primary-button" disabled={!reply.trim() || pending || send.isPending}>
                      {send.isPending ? t("agentSessionSending") : t("agentSessionSend")}
                    </button>
                  </form>
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
