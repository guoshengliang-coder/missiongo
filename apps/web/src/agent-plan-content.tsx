import { MarkdownText } from "./markdown-text";
import { useI18n } from "./i18n";
import type { AgentSession, AgentSessionMessage } from "./types";

export function currentPlan(session: AgentSession | undefined) {
  return session?.implementationPlan ?? session?.planApproval;
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

/** Hide only an exact duplicate plan; ordinary commentary is never deduplicated by text. */
export function withoutDuplicatePlan<T extends AgentSessionMessage>(messages: readonly T[], session: AgentSession | undefined): readonly T[] {
  const text = currentPlan(session)?.plan?.trim();
  return text ? messages.filter(message => message.role !== "plan" || message.text.trim() !== text) : messages;
}

/** A null entry renders the submitted plan at its source position, never pinned below later replies. */
export function planTranscript<T extends AgentSessionMessage>(messages: readonly T[], session: AgentSession | undefined): readonly (T | null)[] {
  const plan = currentPlan(session);
  if (!plan?.plan) return messages;
  const submitted = session?.implementationPlan?.submittedAt;
  const approved = session?.implementationPlan?.approvedAt;
  const exactIndex = messages.map(message => message.role === "plan" && message.text.trim() === plan.plan?.trim()).lastIndexOf(true);
  // Legacy proposals have no submission time. Prefer their original message;
  // otherwise use the recorded approval boundary. Unknown history stays above the current window.
  let index = exactIndex;
  const time = Date.parse(submitted ?? (exactIndex < 0 ? approved : undefined) ?? "");
  if (Number.isFinite(time)) {
    // Some native adapters report only whole seconds.
    index = messages.findIndex(message => Date.parse(message.occurredAt) >= Math.floor(time / 1000) * 1000);
    if (index < 0) index = messages.length;
  }
  if (index < 0) index = 0;
  return [...withoutDuplicatePlan(messages.slice(0, index), session), null,
    ...withoutDuplicatePlan(messages.slice(index), session)];
}

export function AgentPlanContent({ session, surface }: { session: AgentSession | undefined; surface: "console" | "panel" }) {
  const { t } = useI18n();
  const plan = currentPlan(session);
  if (!plan?.plan) return null;
  const approved = session?.implementationPlan?.approved
    || session?.planApprovalState?.revision === plan.revision;
  const invalid = session?.implementationPlan?.valid === false;
  const prefix = surface === "console" ? "agent-console" : "agent-session";
  return <article className={`${prefix}-message ${prefix}-message-plan`} aria-label={t("agentPlanContentTitle")}>
    <header className={`${prefix}-message-meta`}>
      <small>{t("agentPlanContentTitle")}{plan.itemKeys?.length ? ` · ${plan.itemKeys.join("、")}` : ""}</small>
      {approved && <small>{t("agentPlanApproved")}</small>}
      {invalid && <small>{t("agentPlanScopeChanged")}</small>}
    </header>
    <MarkdownText>{plan.plan}</MarkdownText>
    {plan.validation && <><strong>{t("agentPlanValidation")}</strong><MarkdownText>{plan.validation}</MarkdownText></>}
  </article>;
}
