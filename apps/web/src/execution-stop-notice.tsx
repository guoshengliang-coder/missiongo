import type { ItemExecutionBlocker } from "./api";
import { agentConsoleUrl } from "./navigation";
import { useI18n } from "./i18n";

const reasonKeys = {active:"executionStopActive",commands_pending:"executionStopCommands",
  connection_unknown:"executionStopUnknown",execution_open:"executionStopOpen"} as const;

// Absent flags from older servers remain conservative until the server is upgraded.
export const blocksExecution = (row:ItemExecutionBlocker) => row.blocking ?? true;

export function ExecutionStopNotice({blockers,manualClaim=false}: {
  itemKey:string;blockers:readonly ItemExecutionBlocker[];onRefresh:()=>Promise<unknown>;manualClaim?:boolean;
}) {
  const {t} = useI18n();
  if (!blockers.length) return null;
  const blocking=blockers.some(blocksExecution);
  // AND-420: the takeover variant is an FYI, not a blocker -- it renders as a
  // slim note so the blocking variant keeps the visual weight for itself.
  return <section className={`execution-stop-notice${blocking ? "" : " execution-stop-notice-takeover"}`} aria-label={t("executionStopHeading")}>
    <strong>{t(manualClaim ? "manualClaimBlocked" : blocking ? "executionStopBlocked" : "executionTakeoverHeading")}</strong>
    {manualClaim && <p>{t("manualClaimParallelHelp")}</p>}
    {!blocking && <p>{t("executionTakeoverHelp")}</p>}
    {blockers.map(blocker=><div className="execution-stop-observation" key={blocker.id}>
      <p>{blocker.nodeName && <strong>{blocker.nodeName} · </strong>}{t(reasonKeys[blocker.reason])}</p>
      {blocker.superseded && <p>{t("executionTakenOverHistory")}</p>}
      <p>{t("executionStopSession",{id:blocker.sessionId ?? blocker.executionId})}</p>
      {blocker.sessionId && blocker.canOpenSession === true
        ? <a className="secondary-button" href={agentConsoleUrl(blocker.sessionId)} target="_blank" rel="noopener noreferrer">{t("executionOpenOriginal")}</a>
        : <p>{t("executionOriginalUnavailable")}</p>}
      {blocker.scope && <p>{blocker.scope}</p>}
      <p>{t("executionStopStatus",{status:blocker.status,progress:blocker.progressStatus ?? "—"})}</p>
      {blocker.lastObservedAt && <p>{t("executionStopObserved",{time:new Date(blocker.lastObservedAt).toLocaleString()})}</p>}
      {blocker.error && <details><summary>{t("executionStopDiagnostic")}</summary><p>{blocker.error}</p></details>}
    </div>)}
  </section>;
}
