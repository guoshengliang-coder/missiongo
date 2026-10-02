import { useEffect, useState } from "react";
import type { CodexSessionFailure } from "@missiongo/domain";
import { useI18n } from "./i18n";
import { failureDiagnostic, sessionFailureView } from "./agent-session-failure";

export function AgentSessionFailureNotice({ status, failure, legacyError }: {
  readonly status: string;
  readonly failure?: CodexSessionFailure | undefined;
  readonly legacyError?: string | undefined;
}) {
  const { t } = useI18n();
  const view = sessionFailureView(status, failure, legacyError);
  const diagnostic = view ? failureDiagnostic(view, t("agentFailureNoDetail")) : "";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => setCopyState("idle"), [diagnostic]);
  if (!view) return null;
  return <section className="agent-console-failure" role="alert">
    <strong>{t(view.summary)}</strong>
    <p>{t(view.recovery)}</p>
    <small>{view.code}</small>
    <div className="agent-console-failure-actions">
      <details>
        <summary>{t("agentFailureDetails")}</summary>
        <pre>{diagnostic}</pre>
      </details>
      <button type="button" className="text-button" onClick={async () => {
        try { await navigator.clipboard.writeText(diagnostic); setCopyState("copied"); }
        catch { setCopyState("failed"); }
      }}>{t("agentFailureCopy")}</button>
    </div>
    {copyState !== "idle" && <p role="status">{t(copyState === "copied" ? "copied" : "agentFailureCopyFailed")}</p>}
  </section>;
}
