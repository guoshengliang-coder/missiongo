import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownText } from "./markdown-text";
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

/** Associate controls with the immutable document reference, never synthesize chat.
 * Legacy records may match their exact complete body; unmatched records remain
 * separately readable without inventing a source message. */
export function inlinePlanTranscript<T extends AgentSessionMessage>(messages: readonly T[], session: AgentSession | undefined): {
  messages: readonly T[]; planMessageId?: string;
} {
  const plan = currentPlan(session);
  if (!plan?.plan?.trim()) return { messages };
  const body = plan.plan.trim();
  const validation = plan.validation?.trim();
  const matches = messages.filter(message => {
    if (!["agent", "plan"].includes(message.role)) return false;
    if (plan.documentId) {
      // The document id is the frozen version identifier. Prefix commentary,
      // split messages and translated link labels do not change the reference.
      return [...message.text.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?\)/g)].some(match => {
        try {
          const url = new URL(match[1]!, "https://plan.invalid");
          return url.pathname === "/" && url.searchParams.get("planDocument") === plan.documentId;
        } catch { return false; }
      });
    }
    return (message.text.trim() === body || message.text.trim().startsWith(body + "\n"))
      && (!validation || message.text.includes(validation));
  });
  // A later progress reference must not move controls away from the formal answer.
  // Phase-less legacy clients remain supported; source messages stay untouched.
  const original = [...matches].reverse().find(message => message.phase === "final_answer") ?? matches.at(-1);
  return { messages, ...(original ? {planMessageId: original.id} : {}) };
}

/** A saved record is not a source message. Settled records belong in details. */
export function isUnlinkedPlanPending(session:AgentSession):boolean {
  const plan=currentPlan(session);
  const code=session.planApprovalStatus?.code;
  return Boolean(plan?.plan?.trim() && !session.archivedAt
    && session.planApprovalState?.revision!==plan.revision
    && !(session.implementationPlan?.revision===plan.revision && (session.implementationPlan.approved || !session.implementationPlan.valid))
    && code && ["ready","awaiting_source","connection_unavailable","reply_unavailable","permission_required","reply_pending"].includes(code));
}

export function UnlinkedPlanRecord({session, blocked = false}: {session: AgentSession; blocked?: boolean}) {
  const {t}=useI18n();
  const plan=currentPlan(session);
  const state=session.planApprovalState;
  if(!session.archivedAt && plan && state?.revision===plan.revision && !planContinuationObserved(session)
    && (state.continuationPending || state.continuationQueued)) {
    // Unsent/uncertain continuation is operational feedback, not a historical plan card.
    return <p className="agent-session-muted" role="status">{t(state.continuationQueued ? "agentPlanApprovedQueued" : "agentPlanApprovedWaiting")}</p>;
  }
  return isUnlinkedPlanPending(session) && plan ? <PendingPlanRecord key={`${session.id}:${plan.revision}`} session={session} blocked={blocked} /> : null;
}

function PendingPlanRecord({session,blocked}:{session:AgentSession;blocked:boolean}) {
  const {t}=useI18n();
  const [elapsed,setElapsed]=useState(false);
  useEffect(()=>{const timer=setTimeout(()=>setElapsed(true),5000);return ()=>clearTimeout(timer);},[]);
  const plan=currentPlan(session)!;
  return <section className="agent-plan-record" aria-label={t("agentPlanRecord")}>
    <p className="agent-session-muted">{t(elapsed ? "agentPlanUnlinked" : "agentPlanSyncing")}</p>
    {elapsed && <>
      {plan.documentId
        ? <a href={`/?planDocument=${encodeURIComponent(plan.documentId)}`} target="_blank" rel="noopener noreferrer">{t("agentPlanViewSaved")}</a>
        : <details><summary>{t("agentPlanViewSaved")}</summary><MarkdownText>{[plan.plan,plan.validation].filter(Boolean).join("\n\n")}</MarkdownText></details>}
      {!plan.documentId && <InlinePlanApproval session={session} blocked={blocked} />}
    </>}
  </section>;
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
