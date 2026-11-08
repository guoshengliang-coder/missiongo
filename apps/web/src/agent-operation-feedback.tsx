import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { errorMessageKey, localizedErrorText } from "./error-text";
import { useI18n, type MessageKey } from "./i18n";
import type { AgentApproval, AgentSessionCommand, AgentSessionSummary } from "./types";

export type OperationKind = "settings" | "send" | "retry" | "stop" | "archive" | "dismiss" | "cancel" | "resolve" | "approval" | "approvalRetry";
export interface OperationTarget { id?: string | undefined; archived?: boolean | undefined; commandId?: string | undefined; dispatchStatus?: AgentSessionSummary["dispatchStatus"] | undefined }
export interface Operation {
  sessionId: string;
  kind: OperationKind;
  target: OperationTarget;
  key: string;
  token: number;
  startedAt: number;
}
export interface OperationFailure extends Operation { error: unknown; superseded?: boolean }
export interface OperationSnapshot {
  sessionId: string;
  /** Browser time of a successful read, never a source/server wall clock. */
  checkedAt: number;
  detail?: boolean;
  settingsIdentity?: string;
  stopCommand?: AgentSessionCommand | undefined;
  dispatchId?: string | undefined;
  dispatchStatus?: AgentSessionSummary["dispatchStatus"] | undefined;
  command?: AgentSessionCommand | undefined;
  approval?: AgentApproval | undefined;
  archivedAt?: string | undefined;
  attention?: AgentSessionSummary["attention"] | undefined;
}

/** Missing/failed reads and ordinary progress cannot settle an unrelated action. */
export function operationSuperseded(failure: OperationFailure, snapshot?: OperationSnapshot): boolean {
  if (!snapshot || snapshot.sessionId !== failure.sessionId || snapshot.checkedAt <= failure.startedAt) return false;
  const id = failure.target.id;
  switch (failure.kind) {
    case "settings":
      return snapshot.settingsIdentity !== undefined && snapshot.settingsIdentity !== id;
    case "approval":
    case "approvalRetry": {
      if (!id || !snapshot.detail) return false;
      const approval = snapshot.approval;
      return !approval || approval.id !== id || (failure.kind === "approval"
        ? approval.kind !== "manual" || approval.status !== "pending" || Boolean(approval.decision)
        : approval.kind !== "auto" || approval.status !== "denied" || Boolean(approval.retryId));
    }
    case "cancel":
    case "resolve":
      // A delivered recall target is still a failed recall, not a successful one.
      return Boolean(snapshot.detail && id && snapshot.command && snapshot.command.id !== id);
    case "stop":
      return Boolean(snapshot.stopCommand && snapshot.stopCommand.id !== failure.target.commandId
        && ["queued", "delivering", "delivered"].includes(snapshot.stopCommand.status));
    case "retry":
      return Boolean(id && failure.target.dispatchStatus && snapshot.dispatchId === id
        && snapshot.dispatchStatus !== failure.target.dispatchStatus && snapshot.dispatchStatus !== undefined
        && ["queued", "delivered", "launched"].includes(snapshot.dispatchStatus));
    case "archive":
      return failure.target.archived !== undefined && Boolean(snapshot.archivedAt) === failure.target.archived;
    case "dismiss":
      return Boolean(id && snapshot.attention && (snapshot.attention.revision !== id || snapshot.attention.dismissed));
    default:
      return false;
  }
}

export function operationFailureVisible(failure: OperationFailure, sessionId: string): boolean {
  return failure.sessionId === sessionId;
}

/** Each attempt owns its target. Dismissal/success invalidates only that attempt. */
export function useAgentOperationFeedback(snapshot?: OperationSnapshot, summary?: OperationSnapshot) {
  const versions = useRef(new Map<string, number>());
  const [failures, setFailures] = useState<Readonly<Record<string, OperationFailure>>>({});
  const begin = useCallback((sessionId: string, kind: OperationKind, target: OperationTarget = {}): Operation => {
    const key = JSON.stringify([sessionId, kind, target.id ?? null, target.archived ?? null]);
    const token = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, token);
    setFailures(current => { const next = { ...current }; delete next[key]; return next; });
    return { sessionId, kind, target, key, token, startedAt: Date.now() };
  }, []);
  const fail = useCallback((error: unknown, operation: Operation | undefined) => {
    if (!operation || versions.current.get(operation.key) !== operation.token) return;
    setFailures(current => current[operation.key]?.superseded ? current : { ...current, [operation.key]: { ...operation, error } });
  }, []);
  const finish = useCallback((operation: Operation | undefined) => {
    if (!operation || versions.current.get(operation.key) !== operation.token) return;
    versions.current.set(operation.key, operation.token + 1);
    setFailures(current => { const next = { ...current }; delete next[operation.key]; return next; });
  }, []);
  useEffect(() => {
    setFailures(current => {
      let next: Record<string, OperationFailure> | undefined;
      for (const failure of Object.values(current)) {
        if (!failure.superseded && (operationSuperseded(failure, snapshot) || operationSuperseded(failure, summary))) {
          // A later cached read must never revive a superseded failure.
          next ??= { ...current };
          next[failure.key] = { ...failure, superseded: true };
        }
      }
      return next ?? current;
    });
  }, [snapshot, summary]);
  return { begin, fail, finish, failures: Object.values(failures) };
}

const actionKeys: Record<OperationKind, MessageKey> = {
  settings: "operationSettings", send: "operationSend", retry: "operationRetry", stop: "operationStop", archive: "operationArchive",
  dismiss: "operationDismiss", cancel: "operationCancel", resolve: "operationResolve",
  approval: "operationApproval", approvalRetry: "operationApprovalRetry",
};

/** Kept outside run details: actionable failures must remain visible. */
export function AgentOperationFeedback({ failures, sessionId, onDismiss }: {
  failures: readonly OperationFailure[]; sessionId: string; onDismiss: (failure: OperationFailure) => void;
}) {
  const { t } = useI18n();
  return <>{failures.filter(failure => operationFailureVisible(failure, sessionId)).map(failure => {
    const raw = failure.error instanceof Error ? failure.error.message : undefined;
    const known = errorMessageKey(failure.error);
    return <div className={failure.superseded ? "agent-operation-feedback" : "agent-operation-feedback inline-error"}
      role={failure.superseded ? "status" : "alert"} key={failure.key}>
      <span>{t(actionKeys[failure.kind])}: {failure.superseded ? t("operationSuperseded")
        : known ? localizedErrorText(failure.error, t) : t("operationFailed")}</span>
      <button type="button" className="secondary-button" onClick={event => {
        const container = event.currentTarget.closest(".agent-console-conversation, .agent-session-panel");
        const editor = container?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
        onDismiss(failure);
        editor?.focus();
      }}
        aria-label={t("operationClose", { action: t(actionKeys[failure.kind]) })}>{t("close")}</button>
      {raw && <details className="agent-operation-diagnostic"><summary>{t("executionStopDiagnostic")}</summary><p>{raw}</p>
        {failure.error instanceof ApiError && <small>{failure.error.code}</small>}
      </details>}
    </div>;
  })}</>;
}
