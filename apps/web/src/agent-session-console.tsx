import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  BellRing,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
} from "lucide-react";

import { api } from "./api";
import {
  activityLabelKey,
  changedMessageIds,
  DEFAULT_AGENT_SESSION_FILTER,
  isNearMessageBottom,
  messageLabelKey,
  resolvedAgentSessionId,
  shouldResetMessageView,
} from "./agent-session-view";
import {
  agentSessionReadStorageKey,
  isAgentSessionUnread,
  markAgentSessionRead,
  parseAgentSessionReadState,
  type AgentSessionReadState,
} from "./agent-session-unread";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { SessionLink } from "./session-link";
import type { AgentSessionCommand, AgentSessionStatus, AgentSessionSummary } from "./types";

type SessionFilter = "unread" | "waiting" | "active" | "all" | "failed";

function statusLabel(status: AgentSessionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "active") return t("agentSessionActive");
  if (status === "idle") return t("agentSessionIdle");
  if (status === "failed") return t("agentSessionFailed");
  return t("agentSessionUnavailable");
}

function SessionStatusIcon({ status }: { status: AgentSessionStatus }) {
  if (status === "active") return <LoaderCircle className="spin" size={14} />;
  if (status === "idle") return <CircleCheck size={14} />;
  if (status === "failed") return <CircleAlert size={14} />;
  return <CircleDot size={14} />;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionTitle(session: AgentSessionSummary): string {
  const keys = session.items.map((item) => item.key).join("、");
  const firstTitle = session.items[0]?.title;
  return firstTitle ? `${keys} · ${firstTitle}` : session.sessionName ?? session.id;
}

function sessionMatches(
  session: AgentSessionSummary,
  filter: SessionFilter,
  search: string,
  readState: AgentSessionReadState,
): boolean {
  if (filter === "unread" && !isAgentSessionUnread(session, readState)) return false;
  if (filter === "waiting" && !session.waitingForReply) return false;
  if (filter === "active" && session.status !== "active") return false;
  if (filter === "failed" && session.status !== "failed" && session.command?.status !== "failed") return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    session.nodeName,
    session.sessionName ?? "",
    session.latestMessage?.text ?? "",
    ...session.items.flatMap((item) => [item.key, item.title]),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function agentLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  const key = agentLabelKey(session.agentKind);
  return key ? t(key) : session.agentKind;
}

function dispatchActivityLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  if (session.dispatchStatus === "queued") return t("agentConsoleDispatchQueued");
  if (session.dispatchStatus === "delivered") return t("agentConsoleDispatchLaunching");
  if (session.dispatchStatus === "cancelled") return t("agentConsoleDispatchCancelled");
  if (session.dispatchStatus === "failed") return t("agentConsoleDispatchFailed");
  return session.agentKind === "claude_code"
    ? t("agentConsoleClaudeManaged")
    : t("agentConsoleDispatchLaunched");
}

function commandStatusLabel(command: AgentSessionCommand, t: ReturnType<typeof useI18n>["t"]): string {
  if (command.kind === "interrupt") {
    if (command.status === "queued") return t("agentSessionStopQueued");
    if (command.status === "delivering") return t("agentSessionStopDelivering");
    if (command.status === "delivered") return t("agentSessionStopDelivered");
    if (command.status === "failed") return t("agentSessionStopFailed");
    return t("agentSessionStopCancelled");
  }
  if (command.status === "queued") return t("agentSessionReplyQueued");
  if (command.status === "delivering") return t("agentSessionReplyDelivering");
  if (command.status === "delivered") return t("agentSessionReplyDelivered");
  if (command.status === "failed") return t("agentSessionReplyFailed");
  return t("agentSessionReplyCancelled");
}

function updatedTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(new Date(value));
}

export function AgentSessionConsole({
  productId,
  selectedSessionId,
  conversationOpen,
  onSelectSession,
  onBackToSessions,
  onOpenItem,
}: {
  productId: string;
  selectedSessionId: string | null;
  conversationOpen: boolean;
  onSelectSession: (sessionId: string | null, showConversation: boolean) => void;
  onBackToSessions: () => void;
  onOpenItem: (itemKey: string) => void;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<SessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [followLatest, setFollowLatest] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [readState, setReadState] = useState<AgentSessionReadState>({});
  const messagesRef = useRef<HTMLDivElement>(null);
  const observedSessionRef = useRef<string | null>(null);
  const conversationOpenRef = useRef(false);
  const previousMessagesRef = useRef<readonly { id: string; text: string }[]>([]);
  const unseenMessageIdsRef = useRef(new Set<string>());

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions", productId],
    queryFn: () => api.listAgentSessions(productId),
    refetchInterval: 5_000,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const counts = useMemo(() => ({
    unread: sessions.filter((session) => isAgentSessionUnread(session, readState)).length,
    waiting: sessions.filter((session) => session.waitingForReply).length,
    active: sessions.filter((session) => session.status === "active").length,
    all: sessions.length,
    failed: sessions.filter((session) => session.status === "failed" || session.command?.status === "failed").length,
  }), [readState, sessions]);
  const visibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatches(session, filter, search, readState)),
    [filter, readState, search, sessions],
  );
  // Keep a restored URL selection while the list is still loading. Falling
  // back to null here would immediately erase the session that survived an
  // Android Activity recreation, before the request had a chance to confirm it.
  const selectedId = resolvedAgentSessionId(
    selectedSessionId,
    visibleSessions.map((session) => session.id),
    sessionsQuery.data !== undefined,
  );

  useEffect(() => {
    setReadState(parseAgentSessionReadState(localStorage.getItem(agentSessionReadStorageKey(productId))));
  }, [productId]);

  useEffect(() => {
    if (selectedId === selectedSessionId) return;
    onSelectSession(selectedId, conversationOpen && Boolean(selectedId));
  }, [conversationOpen, onSelectSession, selectedId, selectedSessionId]);

  const selected = sessions.find((session) => session.id === selectedId);
  const sessionQuery = useQuery({
    queryKey: ["agent-session", selected?.agentSessionId],
    queryFn: () => api.getAgentSession(selected!.agentSessionId!),
    enabled: Boolean(selected?.agentSessionId),
    refetchInterval: selected?.agentSessionId ? 2_000 : false,
  });
  const send = useMutation({
    mutationFn: (text: string) => api.sendAgentSessionCommand(selected!.agentSessionId!, text),
    onSuccess: async () => {
      setReply("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", selected?.agentSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions", productId] }),
      ]);
    },
  });
  const retryDispatch = useMutation({
    mutationFn: () => api.retryDispatch(selected!.dispatchId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions", productId] });
    },
  });
  const stopDispatch = useMutation({
    mutationFn: () => api.stopDispatch(selected!.dispatchId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", selected?.agentSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions", productId] }),
      ]);
    },
  });
  const cancel = useMutation({
    mutationFn: ({ sessionId, commandId }: { sessionId: string; commandId: string; text: string }) =>
      api.cancelAgentSessionCommand(sessionId, commandId),
    onSuccess: async (_command, input) => {
      if (selectedId === input.sessionId) setReply(input.text);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions", productId] }),
      ]);
    },
  });
  const command = sessionQuery.data?.command;
  const pending = command?.status === "queued" || command?.status === "delivering";
  const sessionStatus = sessionQuery.data?.status ?? selected?.status ?? "unavailable";
  const messages = sessionQuery.data?.messages ?? [];

  const markRead = useCallback((session: AgentSessionSummary) => {
    setReadState((current) => {
      const next = markAgentSessionRead(session, current);
      if (next !== current) localStorage.setItem(agentSessionReadStorageKey(productId), JSON.stringify(next));
      return next;
    });
  }, [productId]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const messages = messagesRef.current;
    if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior });
    unseenMessageIdsRef.current.clear();
    setFollowLatest(true);
    setNewMessageCount(0);
  }, []);

  useLayoutEffect(() => {
    const changedSession = observedSessionRef.current !== selectedId;
    const resetView = shouldResetMessageView(changedSession, conversationOpenRef.current, conversationOpen);
    const previousMessages = previousMessagesRef.current;
    observedSessionRef.current = selectedId;
    conversationOpenRef.current = conversationOpen;
    previousMessagesRef.current = messages;

    if (resetView) {
      unseenMessageIdsRef.current.clear();
      setFollowLatest(true);
      setNewMessageCount(0);
      scrollToLatest();
      return;
    }

    const changedIds = changedMessageIds(previousMessages, messages);
    if (changedIds.length === 0) return;
    if (followLatest) scrollToLatest();
    else {
      changedIds.forEach((id) => unseenMessageIdsRef.current.add(id));
      setNewMessageCount(unseenMessageIdsRef.current.size);
    }
  }, [conversationOpen, followLatest, messages, scrollToLatest, selectedId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (selected?.canReply && text && !pending && !send.isPending) send.mutate(text);
  };
  const chooseFilter = (next: SessionFilter) => {
    setFilter(next);
    const first = sessions.find((session) => sessionMatches(session, next, search, readState));
    onSelectSession(first?.id ?? null, false);
  };

  const filters: Array<{ key: SessionFilter; icon: typeof BellRing; count: number; label: string }> = [
    { key: "unread", icon: Mail, count: counts.unread, label: t("agentConsoleUnread") },
    { key: "waiting", icon: BellRing, count: counts.waiting, label: t("agentConsoleWaiting") },
    { key: "active", icon: LoaderCircle, count: counts.active, label: t("agentConsoleActive") },
    { key: "all", icon: MessageSquare, count: counts.all, label: t("agentConsoleAll") },
    { key: "failed", icon: CircleAlert, count: counts.failed, label: t("agentConsoleFailed") },
  ];

  return (
    <main className={`agent-console-page ${conversationOpen ? "mobile-conversation-open" : "mobile-list-open"}`}>
      <aside className="agent-console-filters" aria-label={t("agentConsoleFilters")}>
        <p className="sidebar-label">{t("agentConsoleTitle")}</p>
        {filters.map(({ key, icon: Icon, count, label }) => (
          <button
            key={key}
            type="button"
            className={`agent-console-filter ${filter === key ? "active" : ""}`}
            aria-pressed={filter === key}
            onClick={() => chooseFilter(key)}
          >
            <Icon className={key === "active" && filter === key ? "spin-when-active" : ""} size={16} />
            <span>{label}</span>
            <small>{count}</small>
          </button>
        ))}
        <p className="agent-console-scope-note">{t("agentConsoleScopeNote")}</p>
      </aside>

      <section className="agent-console-list" aria-label={t("agentConsoleSessions")}>
        <header className="agent-console-list-head">
          <div><h1>{filters.find((entry) => entry.key === filter)?.label}</h1><small>{t("agentConsoleNewestFirst")}</small></div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("refresh")}
            onClick={() => void sessionsQuery.refetch()}
          ><RefreshCw className={sessionsQuery.isFetching ? "spin" : ""} size={16} /></button>
        </header>
        <div className="agent-console-mobile-filters" aria-label={t("agentConsoleFilters")}>
          {filters.map(({ key, count, label }) => (
            <button key={key} type="button" className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => chooseFilter(key)}>
              {label}<small>{count}</small>
            </button>
          ))}
        </div>
        <label className="agent-console-search">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("agentConsoleSearch")} />
        </label>
        <div className="agent-console-session-list">
          {sessionsQuery.isLoading && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
          {sessionsQuery.isError && <p className="inline-error">{errorText(sessionsQuery.error)}</p>}
          {!sessionsQuery.isLoading && visibleSessions.length === 0 && (
            <div className="agent-console-empty"><Bot size={22} /><p>{t(search.trim() ? "agentConsoleNoMatch" : "agentConsoleEmpty")}</p></div>
          )}
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`agent-console-session ${session.id === selectedId ? "active" : ""} ${isAgentSessionUnread(session, readState) ? "unread" : ""}`}
              onClick={() => {
                markRead(session);
                onSelectSession(session.id, true);
              }}
            >
              <span className={`agent-console-status-icon agent-console-status-${session.status}`}>
                <SessionStatusIcon status={session.status} />
              </span>
              <span className="agent-console-session-copy">
                <strong>{sessionTitle(session)}</strong>
                <small>{session.nodeName} · {agentLabel(session, t)} · {statusLabel(session.status, t)}</small>
                <span>{session.latestMessage?.text ?? session.lastError ?? t("agentConsoleDispatchOnly")}</span>
              </span>
              {isAgentSessionUnread(session, readState) && <i className="agent-console-unread-dot" aria-label={t("agentConsoleUnreadOne")} />}
              <time>{updatedTime(session.updatedAt, locale)}</time>
            </button>
          ))}
        </div>
      </section>

      <section className="agent-console-conversation" aria-live="polite">
        {!selected && <div className="agent-console-empty agent-console-empty-conversation"><MessageSquare size={24} /><p>{t("agentConsoleChoose")}</p></div>}
        {selected && (
          <>
            <header className="agent-console-conversation-head">
              <button
                type="button"
                className="icon-button agent-console-conversation-back"
                aria-label={t("agentConsoleBackToSessions")}
                onClick={onBackToSessions}
              ><ArrowLeft size={19} /></button>
              <span className="agent-console-avatar"><Bot size={17} /></span>
              <div>
                <h2>{sessionTitle(selected)}</h2>
                <p>{selected.nodeName} · {agentLabel(selected, t)} · {selected.mode}</p>
              </div>
              <span className={`status-pill agent-session-status-${sessionStatus}`}>{statusLabel(sessionStatus, t)}</span>
              {selected.sessionUrl && <SessionLink url={selected.sessionUrl} />}
              <div className="agent-console-actions">
                {selected.canRetry && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={retryDispatch.isPending || stopDispatch.isPending}
                    onClick={() => {
                      if (window.confirm(t("agentConsoleRetryConfirm"))) retryDispatch.mutate();
                    }}
                  ><RotateCcw size={15} />{t("agentConsoleRetry")}</button>
                )}
                {selected.canStop && (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={retryDispatch.isPending || stopDispatch.isPending}
                    onClick={() => {
                      if (window.confirm(t("agentConsoleStopConfirm"))) stopDispatch.mutate();
                    }}
                  ><Square size={14} />{t("agentConsoleStop")}</button>
                )}
              </div>
            </header>
            <div className="agent-console-message-stage">
              <div
                ref={messagesRef}
                className="agent-console-messages"
                onScroll={(event) => {
                  const nearBottom = isNearMessageBottom(event.currentTarget);
                  setFollowLatest(nearBottom);
                  if (nearBottom) {
                    unseenMessageIdsRef.current.clear();
                    setNewMessageCount(0);
                  }
                }}
              >
                <div className="agent-console-dispatch">
                  <span>{t("agentConsoleDispatchScope")}</span>
                  <div>{selected.items.map((item) => <button key={item.key} type="button" onClick={() => onOpenItem(item.key)}>{item.key}</button>)}</div>
                </div>
                {selected.agentSessionId && sessionQuery.isLoading && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
                {sessionQuery.isError && <p className="inline-error">{errorText(sessionQuery.error)}</p>}
                {sessionQuery.data?.messages.length === 0 && <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>}
                {!selected.agentSessionId && (
                  <div className="agent-console-dispatch-state">
                    <Bot size={20} />
                    <strong>{dispatchActivityLabel(selected, t)}</strong>
                    {selected.sessionUrl && <p>{t("agentConsoleOpenExternalHelp")}</p>}
                  </div>
                )}
                {sessionQuery.data?.messages.map((message) => {
                  const labelKey = messageLabelKey(message.role, selected.agentKind);
                  return (
                    <article key={message.id} className={`agent-console-message agent-console-message-${message.role}`}>
                      {labelKey && <small>{t(labelKey)}</small>}
                      <MarkdownText>{message.text}</MarkdownText>
                      {message.questions?.map((question) => (
                        <div key={question.title} className="agent-session-question">
                          <strong>{question.title}</strong>
                          {question.options && <div className="agent-session-options">
                            {question.options.map((option) => (
                              <button key={option} type="button" disabled={!selected.canReply} onClick={() => setReply(option)}>{option}</button>
                            ))}
                          </div>}
                        </div>
                      ))}
                    </article>
                  );
                })}
                {(sessionQuery.data?.lastError ?? selected.lastError) && (
                  <p className="inline-error">{sessionQuery.data?.lastError ?? selected.lastError}</p>
                )}
                {selected.agentSessionId && !sessionQuery.isLoading && !sessionQuery.isError && (
                  <div className={`agent-console-activity agent-console-activity-${sessionStatus}`} role="status">
                    <SessionStatusIcon status={sessionStatus} />
                    <span>{t(activityLabelKey(sessionStatus, command?.status === "queued"))}</span>
                  </div>
                )}
              </div>
              {newMessageCount > 0 && (
                <button type="button" className="agent-console-new-messages" onClick={() => scrollToLatest("smooth")}>
                  <span>{t("agentConsoleNewMessages", { count: newMessageCount })}</span>
                  <ArrowDown size={15} />
                </button>
              )}
            </div>
            <footer className="agent-console-reply">
              {(retryDispatch.isError || stopDispatch.isError) && (
                <p className="inline-error">{errorText(retryDispatch.error ?? stopDispatch.error)}</p>
              )}
              {command && (
                <div className={`agent-session-command agent-session-command-${command.status}`}>
                  <span>
                    {commandStatusLabel(command, t)}
                    {command.error ? `: ${command.error}` : ""}
                  </span>
                  {command.kind === "message" && command.status === "queued" && selected.canReply && (
                    <button
                      type="button"
                      className="text-button agent-session-cancel"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate({ sessionId: selected.agentSessionId!, commandId: command.id, text: command.text })}
                    >
                      {cancel.isPending ? t("agentSessionCancelling") : t("agentSessionCancelAndEdit")}
                    </button>
                  )}
                </div>
              )}
              {selected.canReply && selected.agentSessionId ? (
                <form onSubmit={submit}>
                  <textarea
                    rows={3}
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder={t("agentSessionReplyPlaceholder")}
                    disabled={pending || send.isPending}
                  />
                  <button type="submit" className="primary-button" disabled={!reply.trim() || pending || send.isPending}>
                    {send.isPending ? t("agentSessionSending") : t("agentSessionSend")}
                  </button>
                </form>
              ) : (
                <p className="agent-session-muted" role="note">
                  {selected.agentSessionId ? t("agentSessionReadOnly") : t("agentConsoleNoInlineReply")}
                </p>
              )}
              {send.isError && <p className="inline-error">{errorText(send.error)}</p>}
              {cancel.isError && <p className="inline-error">{errorText(cancel.error)}</p>}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
