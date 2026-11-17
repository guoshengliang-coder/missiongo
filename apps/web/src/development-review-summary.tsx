import type { DevelopmentReviewEvidence } from "@missiongo/domain";
import { useI18n } from "./i18n";

/** The same read-only summary in both conversation surfaces. Review history is
 * quality evidence, never a running background task or a new stop control. */
export function DevelopmentReviewSummary({ value }: { value?: { required: boolean; unavailable?: boolean; activeTaskId?: string; records: readonly DevelopmentReviewEvidence[] } | undefined }) {
  const { t } = useI18n();
  if (!value?.required) return null;
  const labels = { developing: "developmentReviewDeveloping", reviewing: "developmentReviewRunning", repairing: "developmentReviewRepairing", validating: "developmentReviewValidating",
    passed: "developmentReviewPassed", incomplete: "developmentReviewIncomplete", exhausted: "developmentReviewExhausted", cancelled: "developmentReviewCancelled",
    needs_decision: "developmentReviewNeedsDecision", unsupported: "developmentReviewUnsupported" } as const;
  return <section className="agent-session-background development-review-summary" aria-label={t("developmentReviewTitle")}>
    <strong>{t("developmentReviewTitle")}</strong>
    {value.unavailable && <p role="status">{t("developmentReviewUnavailable")}</p>}
    {!value.records.length ? <p>{t("developmentReviewMissing")}</p> : <ul>{value.records.map(record => <li key={record.taskId}>
      <strong>{t(record.taskId === (value.activeTaskId ?? value.records[0]?.taskId) ? "developmentReviewCurrent" : "developmentReviewHistory")}</strong> ·
      {t("developmentReviewRound", { round: record.round })} · {t(labels[record.status as keyof typeof labels] ?? "developmentReviewIncomplete")}
      <small>{t("developmentReviewChecks", { count: record.blockingFindings, checks: t(record.checksPassed ? "developmentReviewChecksPassed" : "developmentReviewChecksPending") })}</small>
      {record.status === "passed" && (!record.proof?.valid || Date.now()-Date.parse(record.proof.checkedAt)>300000) && <small>{t("developmentReviewVerifyNeeded")}</small>}
      {record.limitations.map((limitation,index) => <p key={index}>{limitation}</p>)}
      {(Boolean(record.findings?.length) || Boolean(record.checks?.length)) && <details>
        <summary>{t("developmentReviewEvidence")}</summary>
        {record.findings?.map(finding => <div key={finding.id}>
          <strong>{finding.path}</strong>
          <p>{t("developmentReviewTrigger")}: {finding.trigger}</p>
          <p>{t("developmentReviewExpected")}: {finding.expected}</p>
          <p>{t("developmentReviewActual")}: {finding.actual}</p>
          <p>{t("developmentReviewEvidence")}: {finding.evidence}</p>
          <p>{t("developmentReviewValidation")}: {finding.validation}</p>
        </div>)}
        {record.checks?.map(check => <div key={check.name}><strong>{check.name} · {t(check.result === "passed" ? "developmentReviewChecksPassed" : check.result === "failed" ? "developmentReviewCheckFailed" : "developmentReviewCheckNotRun")}</strong>
          <p>{check.method}</p><p>{check.evidence}</p>
        </div>)}
      </details>}
    </li>)}</ul>}
    <small>{t("developmentReviewAuthority")}</small>
  </section>;
}
