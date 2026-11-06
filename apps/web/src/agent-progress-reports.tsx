import { MarkdownText } from "./markdown-text";
import { useI18n } from "./i18n";
import type { AgentSession } from "./types";

/** Operational reports are retained separately from the native transcript. */
export function AgentProgressReports({ session }: { session: AgentSession | undefined }) {
  const { t } = useI18n();
  if (!session?.progressReports?.length) return null;
  return <details className="agent-session-muted" data-testid="agent-progress-reports">
    <summary>{t("agentProgressReports")}</summary>
    {session.progressReports.map(report => <article key={report.id}>
      <time dateTime={report.occurredAt}>{report.occurredAt}</time>
      <MarkdownText>{report.text}</MarkdownText>
    </article>)}
  </details>;
}
