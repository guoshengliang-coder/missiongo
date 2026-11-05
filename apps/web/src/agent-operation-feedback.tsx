import { useCallback, useEffect, useRef, useState } from "react";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import type { AgentSessionCommand } from "./types";

interface Operation {
  sessionId: string;
  key: string;
  token: number;
  epoch: number;
  startedAt: number;
  commandId?: string | undefined;
}
export interface OperationFailure extends Operation { error: unknown }

/** A poll succeeding says nothing about whether a failed action succeeded. */
export function operationFailureVisible(failure: OperationFailure, sessionId: string, command?: Pick<AgentSessionCommand, "id" | "createdAt">): boolean {
  return failure.sessionId === sessionId && !(command && command.id !== failure.commandId
    && Date.parse(command.createdAt) > failure.startedAt);
}

/** Retain each session's failures, but never revive a superseded async action. */
export function useAgentOperationFeedback(sessionId?: string, turnId?: string) {
  const turns = useRef(new Map<string, string>());
  const versions = useRef(new Map<string, number>());
  const epochs = useRef(new Map<string, number>());
  const [failures, setFailures] = useState<Readonly<Record<string, OperationFailure>>>({});
  const begin = useCallback((sessionId: string, operation: string, commandId?: string): Operation => {
    const key = JSON.stringify([sessionId, operation]);
    const token = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, token);
    setFailures(current => { const next = { ...current }; delete next[key]; return next; });
    return { sessionId, key, token, epoch: epochs.current.get(sessionId) ?? 0, startedAt: Date.now(), commandId };
  }, []);
  const fail = useCallback((error: unknown, operation: Operation | undefined) => {
    if (!operation || versions.current.get(operation.key) !== operation.token
      || (epochs.current.get(operation.sessionId) ?? 0) !== operation.epoch) return;
    setFailures(current => ({ ...current, [operation.key]: { ...operation, error } }));
  }, []);
  const clear = useCallback((sessionId: string) => {
    epochs.current.set(sessionId, (epochs.current.get(sessionId) ?? 0) + 1);
    setFailures(current => Object.fromEntries(Object.entries(current).filter(([, failure]) => failure.sessionId !== sessionId)));
  }, []);
  useEffect(() => {
    if (!sessionId || !turnId) return;
    const previous = turns.current.get(sessionId);
    turns.current.set(sessionId, turnId);
    if (previous && previous !== turnId) clear(sessionId);
  }, [sessionId, turnId, clear]);
  return { begin, fail, clear, failures: Object.values(failures) };
}

/** Kept outside the run disclosure so a failed action always stays visible. */
export function AgentOperationFeedback({ failures, sessionId, command }: {
  failures: readonly OperationFailure[]; sessionId: string; command?: AgentSessionCommand | undefined;
}) {
  const { t } = useI18n();
  return <>{failures.filter(failure => operationFailureVisible(failure, sessionId, command)).map(failure =>
    <p className="inline-error" role="alert" key={failure.key}>{localizedErrorText(failure.error, t)}</p>)}</>;
}
