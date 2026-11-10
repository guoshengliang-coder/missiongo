import { createContext, useSyncExternalStore } from "react";
import { useI18n } from "./i18n";
import { localizedErrorText, errorMessageKey } from "./error-text";
import { commandNotDelivered, type SessionSender, type SendAttempt } from "./session-send";

export const SessionSenderContext = createContext<SessionSender | null>(null);

export function useSendAttempt(sender: SessionSender, sessionId: string) {
  return useSyncExternalStore(sender.subscribe, () => sender.get(sessionId), () => sender.get(sessionId));
}
export function sendAttemptLocked(attempt: SendAttempt | undefined) {
  return Boolean(attempt && ["uploading", "submitting", "checking", "unconfirmed"].includes(attempt.phase));
}
export function SessionSendFeedback({ attempt, recover }: {
  attempt: SendAttempt | undefined; recover: (mode: "check" | "retry") => void;
}) {
  const { t } = useI18n();
  if (!attempt) return null;
  if (attempt.phase === "sent") return commandNotDelivered(attempt.command)
    ? <p className="agent-session-muted" role="status">{t("agentSendNotDelivered")}</p> : null;
  if (attempt.phase === "failed") return <div className="inline-error" role="alert">
    <p>{errorMessageKey(attempt.error) ? localizedErrorText(attempt.error, t) : t("agentSendRejected")}</p>
    {!errorMessageKey(attempt.error) && attempt.error instanceof Error && <details>
      <summary>{t("executionStopDiagnostic")}</summary><p>{attempt.error.message}</p>
    </details>}
    <button type="button" className="text-button" onClick={() => recover("retry")}>{t("agentSendRetrySame")}</button>
  </div>;
  return <div className="agent-session-muted" role="status">
    <p>{attempt.phase === "uploading" && attempt.files.length
      ? t("agentSendUploading", { current: Math.min(attempt.uploaded.length + 1, attempt.files.length), total: attempt.files.length })
      : t(attempt.phase === "checking" ? "agentSendChecking" : attempt.phase === "unconfirmed" ? "agentSendUnconfirmed" : "agentSendSubmitting")}</p>
    {attempt.phase === "unconfirmed" && <>
      <button type="button" className="text-button" onClick={() => recover("check")}>{t("agentSendCheck")}</button>
      <button type="button" className="text-button" onClick={() => recover("retry")}>{t("agentSendRetrySame")}</button>
    </>}
  </div>;
}
