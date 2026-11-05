import { MarkdownText } from "./markdown-text";
import { useI18n } from "./i18n";
import type { AgentSession, AgentSessionMessage } from "./types";

export function currentPlan(session: AgentSession | undefined) {
  return session?.implementationPlan ?? session?.planApproval;
}

/** Hide only an exact duplicate plan; ordinary commentary is never deduplicated by text. */
export function withoutDuplicatePlan<T extends AgentSessionMessage>(messages: readonly T[], session: AgentSession | undefined): readonly T[] {
  const text = currentPlan(session)?.plan?.trim();
  return text ? messages.filter(message => message.role !== "plan" || message.text.trim() !== text) : messages;
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
