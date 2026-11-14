import { withCurrentRequests } from "./current-session-requests";
import { catchUpStoredHistory, historyMessageKey } from "./agent-history-catchup";
import { useQueryClient } from "@tanstack/react-query";
import { waitForAgentHistory } from "./agent-history-result";
import { isConversationMessage } from "@missiongo/domain";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { isHistoryLimited } from "./agent-session-feedback";
import type { AgentSession, AgentSessionMessage } from "./types";

/** Incoming source order wins inside its overlapping range, including late
 * inserts. A Map alone would append a late user mirror after newer replies. */
export function mergeMessages(older: readonly AgentSessionMessage[], latest: readonly AgentSessionMessage[]) {
  const prefix = older.filter(isConversationMessage);
  const incoming = latest.filter(isConversationMessage);
  const indexes = new Map(prefix.map((message, index) => [historyMessageKey(message), index]));
  const split = incoming.reduce((start, message) => Math.min(start, indexes.get(historyMessageKey(message)) ?? prefix.length), prefix.length);
  const values = new Map([...prefix, ...incoming].map(message => [historyMessageKey(message), message]));
  const incomingKeys = new Set(incoming.map(historyMessageKey));
  const beforeAnchor = new Map<string, string[]>();
  let pending: string[] = [];
  for (const message of prefix.slice(split)) {
    const key = historyMessageKey(message);
    if (incomingKeys.has(key)) { beforeAnchor.set(key, pending); pending = []; }
    else pending.push(key);
  }
  const order = new Set(prefix.slice(0, split).map(historyMessageKey));
  for (const message of incoming) {
    const key = historyMessageKey(message);
    for (const cached of beforeAnchor.get(key) ?? []) order.add(cached);
    order.add(key);
  }
  for (const cached of pending) order.add(cached);
  return [...order].map(key => values.get(key)!);
}

export function useAgentHistory(sessionId: string | null, session: AgentSession | undefined,
  container: RefObject<HTMLDivElement | null>) {
  const client = useQueryClient();
  const [state, setState] = useState({ id: sessionId, older: [] as readonly AgentSessionMessage[],
    next: undefined as string | null | undefined, loading: false, error: false, revision: 0 });
  const generation = useRef(0);
  const windowGeneration = useRef(0);
  const [windowRetry,retryWindow]=useState(0);
  const frontier = useRef<{ id:string; message:string; nextCursor:string|undefined } | null>(null);
  const busy = useRef(false);
  const bridging=useRef(false);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => {
    generation.current++; windowGeneration.current++; frontier.current=null; busy.current = false; bridging.current=false; anchor.current = null;
    setState({ id: sessionId, older: [], next: undefined, loading: false, error: false, revision: 0 });
    return () => { generation.current++; };
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || !session) return;
    const run=++windowGeneration.current;
    const previousWindow=frontier.current?.id===sessionId ? frontier.current : undefined;
    const previous=previousWindow?.message;
    const last=session.messages.at(-1);
    const gap=Boolean(previous && last && !session.messages.some(message=>historyMessageKey(message)===previous)
      && session.history?.nextCursor?.startsWith("stored:"));
    const apply=(bridge:readonly AgentSessionMessage[])=>{
      if(run!==windowGeneration.current)return;
      // A recent window moving forward must not move the older-page boundary
      // forward with it. The gap bridge only adds messages after our frontier;
      // the previous window's cursor still names the unread history before it.
      const advanced=previous && last && previous!==historyMessageKey(last);
      frontier.current=last?{id:sessionId,message:historyMessageKey(last),nextCursor:session.history?.nextCursor}:null;
      setState(current=>{
        if(current.id!==sessionId)return current;
        // A formerly complete stored window may acquire source history later.
        // Keep that continuation discoverable rather than freezing a null end.
        const earlier=previousWindow?.nextCursor??(session.history?.nextCursor?.startsWith("stored:") && current.older[0]
          ? `stored:${current.older[0].id}` : session.history?.nextCursor);
        return {...current,loading:false,error:false,next:current.next===undefined && advanced ? earlier : current.next,
          older:mergeMessages(current.older,[...bridge,...session.messages])};
      });
    };
    if(!gap){bridging.current=false;apply([]);return;}
    bridging.current=true;
    setState(current=>({...current,loading:true,error:false}));
    void catchUpStoredHistory(session.history?.nextCursor,previous!,cursor=>{
      if(run!==windowGeneration.current)throw new Error("History window changed");
      return api.getAgentHistory(sessionId,cursor);
    })
      .then(apply).catch(()=>{if(run===windowGeneration.current)setState(current=>({...current,loading:false,error:true}));})
      .finally(()=>{if(run===windowGeneration.current)bridging.current=false;});
    return ()=>{windowGeneration.current++;bridging.current=false;};
  }, [sessionId, session?.messages, session?.history?.nextCursor, windowRetry]);
  const current = state.id === sessionId ? state : undefined;
  const cursor = current?.next === undefined ? session?.history?.nextCursor : current.next ?? undefined;
  const messages = useMemo(() => withCurrentRequests(mergeMessages(current?.older ?? [], session?.messages ?? []), session?.currentRequests), [current?.older, session?.messages, session?.currentRequests]);
  const loadMore = useCallback(async () => {
    if (!sessionId || !cursor || busy.current || bridging.current) return;
    const previous=frontier.current?.id===sessionId?frontier.current.message:undefined;
    if(current?.error && previous && session?.history?.nextCursor?.startsWith("stored:")
      && !session.messages.some(message=>historyMessageKey(message)===previous)){
      // Retry the failed bridge before paging beyond the cached prefix. A
      // normal prepend here could put a newer range ahead of that prefix.
      bridging.current=true;setState(previous=>({...previous,loading:true,error:false}));retryWindow(value=>value+1);return;
    }
    busy.current = true;
    const run = generation.current;
    const box = container.current;
    const first = box && [...box.querySelectorAll<HTMLElement>("[data-agent-message-id]")]
      .find(element => element.getBoundingClientRect().bottom > box.getBoundingClientRect().top);
    anchor.current = first ? { id: first.dataset.agentMessageId!, top: first.getBoundingClientRect().top - box!.getBoundingClientRect().top } : null;
    setState(previous => ({ ...previous, loading: true, error: false }));
    try {
      let page = await api.loadAgentHistory(sessionId, cursor);
      if (page.status === "pending") page = await waitForAgentHistory(client, sessionId, cursor, page);
      if (generation.current !== run) return;
      if (page.status !== "ready" || page.nextCursor === cursor) throw new Error("history unavailable");
      setState(previous => previous.id !== sessionId ? previous : ({ ...previous,
        older: mergeMessages(page.messages, previous.older), next: page.nextCursor ?? null,
        loading: false, error: false, revision: previous.revision + 1 }));
    } catch {
      if (generation.current === run) setState(previous => ({ ...previous, loading: false, error: true }));
    } finally { if (generation.current === run) busy.current = false; }
  }, [client, container, cursor, sessionId, current?.error, session]);
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
