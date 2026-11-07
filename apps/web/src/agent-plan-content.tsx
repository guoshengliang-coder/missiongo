import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { planApprovalStatusKey } from "./agent-session-view";
import { useI18n } from "./i18n";
import type { AgentSession, AgentSessionMessage } from "./types";

export function currentPlan(session: AgentSession | undefined) {
  const offer = session?.planApproval;
  const saved = session?.implementationPlan;
  return offer && offer.revision !== saved?.revision ? offer : saved ?? offer;
}

/** The durable approval remains readable; its acknowledgement ends on actual native progress. */
export function planContinuationObserved(session: AgentSession | undefined): boolean {
  const approved = session?.planApprovalState;
  if (!session || !approved) return false;
  const plan = currentPlan(session);
  if (plan && plan.revision !== approved.revision) return false;
  const command = session.command;
  const time = Date.parse(session.implementationPlan?.approvedAt
    ?? (approved.continuationQueued && command?.text === "批准" ? command.createdAt : ""));
  if (!Number.isFinite(time)) return false;
  // Source adapters may round native timestamps to whole seconds.
  const boundary = Math.floor(time / 1000) * 1000;
  return session.messages.some(message => message.role === "agent" && !message.questions?.length
    && Date.parse(message.occurredAt) >= boundary)
    || Date.parse(session.turnState?.lastOutputAt ?? "") >= boundary
    || session.turnState?.turnActive === true && Date.parse(session.turnState.turnStartedAt ?? "") >= boundary;
}

/** Match the complete frozen body and validation, never a similar summary.
 * Extra prose remains visible on the original message. */
export function inlinePlanTranscript<T extends AgentSessionMessage>(messages: readonly T[], session: AgentSession | undefined): {
  messages: readonly (T | (AgentSessionMessage & { readonly attachmentData?: undefined }))[]; planMessageId?: string;
} {
  const plan = currentPlan(session);
  if (!plan?.plan?.trim()) return { messages };
  const body = plan.plan.trim();
  const validation = plan.validation?.trim();
  const matches = messages.filter(message => ["agent", "plan"].includes(message.role)
    && (message.text.trim() === body || message.text.trim().startsWith(body + "\n") && (!validation || message.text.includes(validation))));
  // Multiple source messages are genuine history. Attach to the latest complete
  // proposal, without deleting earlier messages or unrelated explanations.
  const original = matches.at(-1);
  if (original) return { messages: validation && !original.text.includes(validation)
    ? messages.map(message => message.id === original.id ? { ...message, text: message.text + "\n\n" + validation } : message)
    : messages, planMessageId: original.id };
  const id = `submitted-plan:${plan.revision}`;
  const fallback: AgentSessionMessage & { readonly attachmentData?: undefined } = { id, sourceId: id, role: "agent",
    text: [body, validation].filter(Boolean).join("\n\n"),
    occurredAt: session?.implementationPlan?.submittedAt ?? session?.implementationPlan?.approvedAt ?? messages[0]?.occurredAt ?? "" };
  const index = messages.findIndex(message => message.occurredAt >= fallback.occurredAt);
  const at = index < 0 ? messages.length : index;
  return { messages: [...messages.slice(0, at), fallback, ...messages.slice(at)], planMessageId: id };
}

/** Approval is attached to the message; the server still binds the revision,
 * permissions and at-most-once continuation. */
export function InlinePlanApproval({ session, blocked = false, onRequestChanges }: { session: AgentSession; blocked?: boolean; onRequestChanges?: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const plan = currentPlan(session);
  const lock = useRef(false);
  const approve = useMutation({
    mutationFn: () => api.approveAgentSessionPlan(session.id, plan!.revision),
    onError: () => { lock.current = false; void client.invalidateQueries({ queryKey: ["agent-session", session.id] }); },
    onSuccess: result => {
      client.setQueryData<AgentSession>(["agent-session", session.id], current => current
        ? "approved" in result
          ? { ...current, planApprovalState: result, canApprovePlan: false, planApprovalStatus: { code: "approved" } }
          : { ...current, command: result, canApprovePlan: false, planApprovalStatus: { code: "reply_pending" } } : current);
      void client.invalidateQueries({ queryKey: ["agent-session", session.id] });
      void client.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });
  if (!plan) return null;
  const approved = session.planApprovalState?.revision === plan.revision
    || session.implementationPlan?.revision === plan.revision && session.implementationPlan.approved;
  const invalid = session.implementationPlan?.revision === plan.revision && !session.implementationPlan.valid;
  const enabled = !blocked && !invalid && (session.canApprovePlan ?? session.canReply)
    && session.planApproval?.revision === plan.revision && session.planApprovalStatus?.code === "ready";
  return <footer className="agent-plan-inline-approval" aria-label={t("agentPlanReview")}>
    {plan.itemKeys?.length ? <span>{plan.itemKeys.join("、")}</span> : null}
    {approved ? <small>{t("agentPlanApproved")}</small> : invalid ? <small>{t("agentPlanScopeChanged")}</small>
      : <button type="button" className="primary-button" disabled={!enabled || approve.isPending || approve.isSuccess}
        onClick={() => { if (!lock.current) { lock.current = true; approve.mutate(); } }}>{t("agentPlanApprove")}</button>}
    {!approved && !invalid && onRequestChanges && <button type="button" className="secondary-button" disabled={blocked || !session.canReply || approve.isPending || approve.isSuccess} onClick={onRequestChanges}>{t("agentPlanRequestChanges")}</button>}
    {!approved && !invalid && !enabled && <small>{t(planApprovalStatusKey(session.planApprovalStatus?.code ?? "reply_unavailable"))}</small>}
    {approved && !planContinuationObserved(session) && session.planApprovalState && <small>{t(session.planApprovalState.continuationQueued
      ? "agentPlanApprovedQueued" : session.planApprovalState.continuationPending ? "agentPlanApprovedWaiting" : "agentPlanApprovedNoReply")}</small>}
    {approve.isError && <p role="alert">{localizedErrorText(approve.error, t)}</p>}
  </footer>;
}
