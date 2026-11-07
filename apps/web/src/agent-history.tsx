import { isConversationMessage } from "@missiongo/domain";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { isHistoryLimited } from "./agent-session-feedback";
import type { AgentSession, AgentSessionMessage } from "./types";

function mergeMessages(older: readonly AgentSessionMessage[], latest: readonly AgentSessionMessage[]) {
  const messages = new Map<string, AgentSessionMessage>();
  for (const message of [...older, ...latest].filter(isConversationMessage)) messages.set(`${message.role}:${message.sourceId || message.id}`, message);
  return [...messages.values()];
}

export function useAgentHistory(sessionId: string | null, session: AgentSession | undefined,
  container: RefObject<HTMLDivElement | null>) {
  const [state, setState] = useState({ id: sessionId, older: [] as readonly AgentSessionMessage[],
    next: undefined as string | null | undefined, loading: false, error: false, revision: 0 });
  const generation = useRef(0);
  const busy = useRef(false);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => {
    generation.current++; busy.current = false; anchor.current = null;
    setState({ id: sessionId, older: [], next: undefined, loading: false, error: false, revision: 0 });
    return () => { generation.current++; };
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || !session) return;
    // Keep the previous recent window when polling advances it. Otherwise a
    // newly appended reply would silently evict a message the reader loaded.
    setState(previous => previous.id !== sessionId ? previous : ({ ...previous,
      older: mergeMessages(previous.older, session.messages) }));
  }, [sessionId, session?.messages]);
  const current = state.id === sessionId ? state : undefined;
  const cursor = current?.next === undefined ? session?.history?.nextCursor : current.next ?? undefined;
  const messages = useMemo(() => mergeMessages(current?.older ?? [], session?.messages ?? []), [current?.older, session?.messages]);
  const loadMore = useCallback(async () => {
    if (!sessionId || !cursor || busy.current) return;
    busy.current = true;
    const run = generation.current;
    const box = container.current;
    const first = box && [...box.querySelectorAll<HTMLElement>("[data-agent-message-id]")]
      .find(element => element.getBoundingClientRect().bottom > box.getBoundingClientRect().top);
    anchor.current = first ? { id: first.dataset.agentMessageId!, top: first.getBoundingClientRect().top - box!.getBoundingClientRect().top } : null;
    setState(previous => ({ ...previous, loading: true, error: false }));
    try {
      let page = await api.loadAgentHistory(sessionId, cursor);
      const deadline = Date.now() + 30_000;
      while (page.status === "pending" && Date.now() < deadline && generation.current === run) {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (generation.current !== run) return;
        page = await api.getAgentHistory(sessionId, cursor);
      }
      if (generation.current !== run) return;
      if (page.status !== "ready" || page.nextCursor === cursor) throw new Error("history unavailable");
      setState(previous => previous.id !== sessionId ? previous : ({ ...previous,
        older: mergeMessages(page.messages, previous.older), next: page.nextCursor ?? null,
        loading: false, error: false, revision: previous.revision + 1 }));
    } catch {
      if (generation.current === run) setState(previous => ({ ...previous, loading: false, error: true }));
    } finally { if (generation.current === run) busy.current = false; }
  }, [container, cursor, sessionId]);
  useLayoutEffect(() => {
    if (!anchor.current || !container.current) return;
    const element = [...container.current.querySelectorAll<HTMLElement>("[data-agent-message-id]")]
      .find(element => element.dataset.agentMessageId === anchor.current!.id);
    if (element) container.current.scrollTop += element.getBoundingClientRect().top - container.current.getBoundingClientRect().top - anchor.current.top;
    anchor.current = null;
  }, [current?.revision, container]);
  return { messages, loadMore, hasMore: Boolean(cursor), loading: current?.loading ?? false,
    error: current?.error ?? false, sourceError: isHistoryLimited(session?.lastError) ? undefined : session?.history?.error, revision: current?.revision ?? 0 };
}

export function AgentHistoryLoader({ history }: { history: ReturnType<typeof useAgentHistory> }) {
  const { t } = useI18n();
  return <>
    {history.hasMore && <button type="button" className="secondary-button" disabled={history.loading}
      onClick={() => void history.loadMore()}>{t(history.loading ? "agentHistoryLoading" : history.error ? "agentHistoryRetry" : "agentHistoryOlder")}</button>}
    {history.loading && <p className="agent-session-muted" role="status">{t("agentHistoryLoading")}</p>}
    {history.error && <p className="inline-error" role="alert">{t("agentHistoryLoadFailed")}</p>}
    {history.sourceError && !history.hasMore && <p className="agent-session-muted" role="status">{t("agentHistorySourceUnavailable")}</p>}
  </>;
}
