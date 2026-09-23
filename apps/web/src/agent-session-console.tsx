import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  BellRing,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  Search,
  Square,
  WifiOff,
  X,
} from "lucide-react";

import { api } from "./api";
import {
  activityLabelKey,
  agentSessionDetailRefetchInterval,
  agentSessionMatches,
  archivableVisibleSessionIds,
  byLatestActivity,
  changedMessageIds,
  DEFAULT_AGENT_KIND_FILTER,
  DEFAULT_AGENT_SESSION_FILTER,
  formatAgentMessageTime,
  isNearMessageBottom,
  messageLabelKey,
  outgoingReply,
  questionAnswerText,
  replyBlockedLabelKey,
  resolvedAgentSessionId,
  shouldMarkRead,
  shouldResetMessageView,
  type AgentKindFilter,
  type AgentSessionFilter,
} from "./agent-session-view";
import { AgentSessionSettingsBar } from "./agent-session-settings";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import { MarkdownText } from "./markdown-text";
import { SessionLink } from "./session-link";
import type { AgentSession, AgentSessionCommand, AgentSessionStatus, AgentSessionSummary, Dispatch } from "./types";
import { AutoGrowTextarea } from "./auto-grow-textarea";

function statusLabel(status: AgentSessionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "active") return t("agentSessionActive");
  if (status === "idle") return t("agentSessionIdle");
  if (status === "suspended") return t("agentSessionSuspended");
  if (status === "stalled") return t("agentSessionStalled");
  if (status === "failed") return t("agentSessionFailed");
  return t("agentSessionUnavailable");
}

function SessionStatusIcon({ status }: { status: AgentSessionStatus }) {
  if (status === "active") return <LoaderCircle className="spin" size={14} />;
  if (status === "idle") return <CircleCheck size={14} />;
  if (status === "failed" || status === "stalled") return <CircleAlert size={14} />;
  return <CircleDot size={14} />;
}

function sessionTitle(session: AgentSessionSummary): string {
  const keys = session.items.map((item) => item.key).join("、");
  const firstTitle = session.items[0]?.title;
  return firstTitle ? `${keys} · ${firstTitle}` : session.sessionName ?? session.id;
}

function lastSeenAgo(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (elapsedSeconds < 60) return formatter.format(-elapsedSeconds, "second");
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.floor(hours / 24), "day");
}

function nodeConnectionLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  if (session.nodeRevoked) return t("agentNodeRevoked");
  if (session.nodeConnectionState === "offline") return t("agentNodeOffline");
  if (session.nodeConnectionState === "unstable") return t("agentNodeUnstable");
  return t("agentNodeOnline");
}

function agentLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  const key = agentLabelKey(session.agentKind);
  return key ? t(key) : session.agentKind;
}

function attentionLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string | null {
  if (!session.needsAttention) return null;
  if (session.attention.kind === "answer") return t("agentAttentionAnswer");
  if (session.attention.kind === "approval") return t("agentAttentionApproval");
  if (session.attention.kind === "action") return t("agentAttentionAction");
  if (session.attention.kind === "instruction") return t("agentAttentionInstruction");
  return t("agentAttentionUncertain");
}

function dispatchActivityLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  if (session.dispatchStatus === "queued") return t("agentConsoleDispatchQueued");
  if (session.dispatchStatus === "delivered") return t("agentConsoleDispatchLaunching");
  if (session.dispatchStatus === "cancelled") return t("agentConsoleDispatchCancelled");
  if (session.dispatchStatus === "failed") return t("agentConsoleDispatchFailed");
  return session.agentKind === "claude_code"
    ? t(session.sessionUrl ? "agentConsoleClaudeManaged" : "agentConsoleClaudeLocal")
    : t("agentConsoleDispatchLaunched");
}

function dispatchVersion(dispatch: Dispatch): string {
  const snapshot = dispatch.diagnosticSnapshot;
  return [
    snapshot?.nodeClientVersion && `client ${snapshot.nodeClientVersion}`,
    snapshot?.agentVersion && `agent ${snapshot.agentVersion}`,
    snapshot?.skill?.localVersion && `skill ${snapshot.skill.localVersion}`,
  ].filter(Boolean).join(" / ") || "unknown";
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

function outgoingReplyStatusLabel(
  status: "sending" | "queued" | "delivering" | "failed",
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (status === "sending") return t("agentSessionSending");
  if (status === "queued") return t("agentSessionReplyQueued");
  if (status === "delivering") return t("agentSessionReplyDelivering");
  return t("agentSessionReplyFailed");
}

function updatedTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(new Date(value));
}

export function AgentSessionConsole({
  productId,
  initialFilter,
  allSessions,
  sessionsLoaded,
  sessionsError,
  selectedSessionId,
  conversationOpen,
  bulkMode,
  onBulkModeChange,
  onBulkAvailabilityChange,
  onSelectSession,
  onBackToSessions,
  onOpenItem,
}: {
  productId: string;
  initialFilter: AgentSessionFilter | null;
  allSessions: readonly AgentSessionSummary[];
  sessionsLoaded: boolean;
  sessionsError: unknown;
  selectedSessionId: string | null;
  conversationOpen: boolean;
  bulkMode: boolean;
  onBulkModeChange: (enabled: boolean) => void;
  onBulkAvailabilityChange: (available: boolean) => void;
  onSelectSession: (sessionId: string | null, showConversation: boolean) => void;
  onBackToSessions: () => void;
  onOpenItem: (itemKey: string) => void;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AgentSessionFilter>(initialFilter ?? DEFAULT_AGENT_SESSION_FILTER);
  const [agentFilter, setAgentFilter] = useState<AgentKindFilter>(DEFAULT_AGENT_KIND_FILTER);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [dismissedCommandId, setDismissedCommandId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  // The conversation the person clicked. Only that one counts as read; merely
  // opening the console or changing a filter never selects or reads a row.
  // (conversationOpen cannot tell: it only ever turns true on the one-pane layout.)
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null);
  const [selectedForArchive, setSelectedForArchive] = useState<Set<string>>(new Set());
  const [bulkArchiveMessage, setBulkArchiveMessage] = useState<string | null>(null);
  const [healthNode, setHealthNode] = useState("all");
  const [healthAgent, setHealthAgent] = useState("all");
  const [healthVersion, setHealthVersion] = useState("all");
  const [healthCode, setHealthCode] = useState("all");
  const messagesRef = useRef<HTMLDivElement>(null);
  const observedSessionRef = useRef<string | null>(null);
  const conversationOpenRef = useRef(false);
  const previousMessagesRef = useRef<readonly { id: string; text: string }[]>([]);
  const previousOutgoingRef = useRef("");
  const unseenMessageIdsRef = useRef(new Set<string>());
  const hasSessionsError = sessionsError !== null && sessionsError !== undefined;

  const sessions = useMemo(
    () => allSessions.filter((session) => session.items.some((item) => item.productId === productId)),
    [allSessions, productId],
  );
  const agentSessions = useMemo(
    () => sessions.filter((session) => agentFilter === "all" || session.agentKind === agentFilter),
    [agentFilter, sessions],
  );
  const counts = useMemo(() => ({
    unread: agentSessions.filter((session) => !session.archivedAt && session.unread).length,
    attention: agentSessions.filter((session) => !session.archivedAt && session.needsAttention).length,
    active: agentSessions.filter((session) => !session.archivedAt && session.status === "active").length,
    all: agentSessions.filter((session) => !session.archivedAt).length,
    failed: agentSessions.filter((session) => !session.archivedAt
      && (session.status === "failed" || session.command?.status === "failed")).length,
    archived: agentSessions.filter((session) => session.archivedAt).length,
  }), [agentSessions]);
  const visibleSessions = useMemo(
    () => byLatestActivity(sessions.filter((session) => agentSessionMatches(session, filter, agentFilter, search))),
    [agentFilter, filter, search, sessions],
  );
  const archivableIds = useMemo(() => archivableVisibleSessionIds(visibleSessions), [visibleSessions]);
  const allArchivableSelected = archivableIds.length > 0
    && archivableIds.every((sessionId) => selectedForArchive.has(sessionId));
  const bulkAvailable = filter !== "archived" && archivableIds.length > 0;
  // A reply resolves "needs attention" and removes this row from that filter.
  // Keep the conversation the person is still reading; explicit filter and
  // navigation handlers remain responsible for leaving it (AND-147).
  const selectedId = resolvedAgentSessionId(
    selectedSessionId,
    sessions.map((session) => session.id),
    sessionsLoaded,
  );

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // Read state used to live in this browser only (AND-135). Drop what earlier
  // releases left behind so it cannot be mistaken for the server's.
  useEffect(() => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("missiongo.agent-console.read.v1:"))
      .forEach((key) => localStorage.removeItem(key));
  }, []);

  useEffect(() => {
    setSelectedForArchive(new Set());
    setBulkArchiveMessage(null);
  }, [agentFilter, filter, productId, search]);

  useEffect(() => {
    onBulkAvailabilityChange(bulkAvailable);
    if (bulkMode && !bulkAvailable) onBulkModeChange(false);
  }, [bulkAvailable, bulkMode, onBulkAvailabilityChange, onBulkModeChange]);

  useEffect(() => {
    if (!bulkMode) setSelectedForArchive(new Set());
  }, [bulkMode]);

  useEffect(() => {
    if (selectedId === selectedSessionId) return;
    onSelectSession(selectedId, conversationOpen && Boolean(selectedId));
  }, [conversationOpen, onSelectSession, selectedId, selectedSessionId]);

  const selected = sessions.find((session) => session.id === selectedId);
  const sessionQuery = useQuery({
    queryKey: ["agent-session", selected?.agentSessionId],
    queryFn: () => api.getAgentSession(selected!.agentSessionId!),
    enabled: Boolean(selected?.agentSessionId) && documentVisible,
    refetchInterval: (query) => selected?.agentSessionId
      ? agentSessionDetailRefetchInterval(documentVisible, query.state.fetchFailureCount)
      : false,
  });
  const healthQuery = useQuery({
    queryKey: ["dispatch-health", 7],
    queryFn: () => api.getDispatchHealth(7),
    enabled: filter === "failed" && documentVisible,
    refetchInterval: documentVisible ? 60_000 : false,
  });
  const healthFailures = useMemo(() => (healthQuery.data?.recentFailures ?? []).filter((dispatch) => (
    (healthNode === "all" || dispatch.nodeName === healthNode)
    && (healthAgent === "all" || dispatch.agentKind === healthAgent)
    && (healthVersion === "all" || dispatchVersion(dispatch) === healthVersion)
    && (healthCode === "all" || (dispatch.failureCode ?? "unknown") === healthCode)
  )), [healthAgent, healthCode, healthNode, healthQuery.data?.recentFailures, healthVersion]);
  const send = useMutation({
    mutationFn: ({ sessionId, text }: { sessionId: string; text: string; occurredAt: string }) => api.sendAgentSessionCommand(sessionId, text),
    onMutate: () => {
      setReply("");
    },
    onSuccess: (created, input) => {
      queryClient.setQueryData<AgentSession>(["agent-session", input.sessionId], (current) => current
        ? { ...current, command: created }
        : current);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
    onError: (_error, input) => {
      if (selected?.agentSessionId === input.sessionId) setReply((current) => current || input.text);
    },
  });
  const retryDispatch = useMutation({
    mutationFn: () => api.retryDispatch(selected!.dispatchId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });
  const stopDispatch = useMutation({
    mutationFn: () => api.stopDispatch(selected!.dispatchId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", selected?.agentSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const archiveSession = useMutation({
    mutationFn: async (archived: boolean) => {
      if (selected!.agentSessionId) await api.setAgentSessionArchived(selected!.agentSessionId, archived);
      else await api.setDispatchArchived(selected!.dispatchId, archived);
    },
    onSuccess: async () => {
      const invalidations = [queryClient.invalidateQueries({ queryKey: ["agent-sessions"] })];
      if (selected?.agentSessionId) {
        invalidations.push(queryClient.invalidateQueries({ queryKey: ["agent-session", selected.agentSessionId] }));
      }
      await Promise.all(invalidations);
    },
  });
  const dismissAttention = useMutation({
    mutationFn: ({ sessionId, revision }: { sessionId: string; revision: string }) =>
      api.dismissAgentSessionAttention(sessionId, revision),
    onSuccess: async (_session, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const bulkArchive = useMutation({
    mutationFn: async (sessionIds: readonly string[]) => {
      const results = await Promise.allSettled(sessionIds.map(async (sessionId) => {
        const session = visibleSessions.find((candidate) => candidate.id === sessionId);
        if (!session?.canArchive || session.archivedAt || session.archivedSource === "source") {
          throw new Error(t("agentConsoleBulkArchiveUnavailable"));
        }
        if (session.agentSessionId) await api.setAgentSessionArchived(session.agentSessionId, true);
        else await api.setDispatchArchived(session.dispatchId, true);
        return sessionId;
      }));
      return results.map((result, index) => ({ sessionId: sessionIds[index]!, result }));
    },
    onSuccess: async (results) => {
      const succeeded = results.filter((entry) => entry.result.status === "fulfilled").map((entry) => entry.sessionId);
      const failures = results.filter((entry) => entry.result.status === "rejected");
      const failureDetails = failures.map((entry) => {
        const session = visibleSessions.find((candidate) => candidate.id === entry.sessionId);
        const reason = entry.result.status === "rejected" ? localizedErrorText(entry.result.reason, t) : "";
        return `${session ? sessionTitle(session) : entry.sessionId}: ${reason}`;
      }).join("; ");
      setSelectedForArchive((current) => {
        const next = new Set(current);
        succeeded.forEach((sessionId) => next.delete(sessionId));
        return next;
      });
      setBulkArchiveMessage(failures.length === 0
        ? t("agentConsoleBulkArchiveSuccess", { count: succeeded.length })
        : `${t("agentConsoleBulkArchivePartial", { success: succeeded.length, failed: failures.length })} ${failureDetails}`);
      if (failures.length === 0) onBulkModeChange(false);
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });
  const cancel = useMutation({
    mutationFn: ({ sessionId, commandId }: { sessionId: string; commandId: string; text: string }) =>
      api.cancelAgentSessionCommand(sessionId, commandId),
    onSuccess: async (_command, input) => {
      if (selectedId === input.sessionId) setReply(input.text);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const command = sessionQuery.data?.command;
  const pending = command?.status === "queued" || command?.status === "delivering";
  const sendingSelected = send.isPending && send.variables?.sessionId === selected?.agentSessionId;
  const failedRequest = send.isError && send.variables?.sessionId === selected?.agentSessionId
    ? { text: send.variables.text, occurredAt: send.variables.occurredAt, status: "failed" as const, error: localizedErrorText(send.error, t) }
    : undefined;
  const sendingRequest = sendingSelected
    ? { text: send.variables.text, occurredAt: send.variables.occurredAt, status: "sending" as const }
    : failedRequest;
  const outgoingCandidate = outgoingReply(command, sendingRequest);
  const outgoing = outgoingCandidate?.commandId === dismissedCommandId ? null : outgoingCandidate;
  const outgoingSignature = outgoing ? `${selectedId}:${outgoing.commandId ?? "request"}:${outgoing.status}:${outgoing.text}` : "";
  const sessionStatus = sessionQuery.data?.status ?? selected?.status ?? "unavailable";
  const messages = sessionQuery.data?.messages ?? [];
  const activities = sessionQuery.data?.activities ?? [];

  const markRead = useMutation({
    mutationFn: ({ dispatchId, through }: { dispatchId: string; through: string }) =>
      api.markDispatchRead(dispatchId, through),
    onMutate: ({ dispatchId, through }) => {
      queryClient.setQueryData<{ sessions: AgentSessionSummary[] }>(["agent-sessions"], (current) => current && {
        sessions: current.sessions.map((session) => session.dispatchId === dispatchId && session.unreadAt === through
          ? { ...session, unread: false }
          : session),
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
  });
  const { mutate: markReadMutate } = markRead;
  const selectedUnreadAt = selected?.unread ? selected.unreadAt : undefined;
  useEffect(() => {
    if (!selected || !shouldMarkRead(selected, openedSessionId === selected.id, documentVisible)) return;
    markReadMutate({ dispatchId: selected.dispatchId, through: selected.unreadAt });
    // Keyed on the unread clock, not the object: each poll returns a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.dispatchId, selectedUnreadAt, openedSessionId, documentVisible, markReadMutate]);

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
    const outgoingChanged = previousOutgoingRef.current !== outgoingSignature;
    observedSessionRef.current = selectedId;
    conversationOpenRef.current = conversationOpen;
    previousMessagesRef.current = messages;
    previousOutgoingRef.current = outgoingSignature;

    if (resetView) {
      unseenMessageIdsRef.current.clear();
      setFollowLatest(true);
      setNewMessageCount(0);
      scrollToLatest();
      return;
    }

    const changedIds = changedMessageIds(previousMessages, messages);
    if (changedIds.length === 0 && !outgoingChanged) return;
    if (followLatest) scrollToLatest();
    else if (changedIds.length > 0) {
      changedIds.forEach((id) => unseenMessageIdsRef.current.add(id));
      setNewMessageCount(unseenMessageIdsRef.current.size);
    }
  }, [conversationOpen, followLatest, messages, outgoingSignature, scrollToLatest, selectedId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (selected?.canReply && selected.agentSessionId && text && !pending && !sendingSelected) {
      send.mutate({ sessionId: selected.agentSessionId, text, occurredAt: new Date().toISOString() });
    }
  };
  const chooseFilter = (next: AgentSessionFilter) => {
    setFilter(next);
    if (selectedId && !sessions.some((session) => session.id === selectedId
      && agentSessionMatches(session, next, agentFilter, search))) onSelectSession(null, false);
  };
  const chooseAgent = (next: AgentKindFilter) => {
    setAgentFilter(next);
    if (selectedId && !sessions.some((session) => session.id === selectedId
      && agentSessionMatches(session, filter, next, search))) onSelectSession(null, false);
  };

  const filters: Array<{ key: AgentSessionFilter; icon: typeof BellRing; count: number; unread?: number; label: string }> = [
    { key: "attention", icon: BellRing, count: counts.attention, label: t("agentConsoleNeedsAttention") },
    { key: "active", icon: LoaderCircle, count: counts.active, label: t("agentConsoleActive") },
    { key: "all", icon: MessageSquare, count: counts.all, unread: counts.unread, label: t("agentConsoleAll") },
    { key: "failed", icon: CircleAlert, count: counts.failed, label: t("agentConsoleFailed") },
    { key: "archived", icon: Archive, count: counts.archived, label: t("agentConsoleArchived") },
  ];

  return (
    <main className={`agent-console-page ${conversationOpen ? "mobile-conversation-open" : "mobile-list-open"}`}>
      <aside className="agent-console-filters" aria-label={t("agentConsoleFilters")}>
        <p className="sidebar-label">{t("agentConsoleTitle")}</p>
        {filters.map(({ key, icon: Icon, count, unread, label }) => (
          <button
            key={key}
            type="button"
            className={`agent-console-filter ${filter === key ? "active" : ""}`}
            aria-pressed={filter === key}
            onClick={() => chooseFilter(key)}
          >
            <Icon className={key === "active" && filter === key ? "spin-when-active" : ""} size={16} />
            <span>{label}</span>
            {Boolean(unread) && (
              <em className="agent-console-filter-unread" title={t("agentConsoleUnreadCount", { count: unread! })}>{unread}</em>
            )}
            {/* A count is only a fact once the list has arrived. Before that, or
                after it failed, "0" reads as "nothing here" -- which is not what
                anyone knows. */}
            {sessionsLoaded && <small>{count}</small>}
          </button>
        ))}
        <p className="agent-console-scope-note">{t("agentConsoleScopeNote")}</p>
      </aside>

      <section className="agent-console-list" aria-label={t("agentConsoleSessions")}>
        <div className="agent-console-mobile-filters" aria-label={t("agentConsoleFilters")}>
          {filters.map(({ key, count, unread, label }) => (
            <button key={key} type="button" className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => chooseFilter(key)}>
              {label}{Boolean(unread) && <em className="agent-console-filter-unread">{unread}</em>}{sessionsLoaded && <small>{count}</small>}
            </button>
          ))}
        </div>
        <div className="agent-console-list-controls">
          <label className="agent-console-search">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("agentConsoleSearch")} />
          </label>
          <label className="agent-console-agent-filter">
            <span>{t("agentConsoleAgentFilter")}</span>
            <select
              aria-label={t("agentConsoleAgentFilter")}
              value={agentFilter}
              onChange={(event) => chooseAgent(event.target.value as AgentKindFilter)}
            >
              <option value="all">{t("agentConsoleAllAgents")}</option>
              <option value="codex">{t("agentCodex")}</option>
              <option value="claude_code">{t("agentClaudeCode")}</option>
            </select>
          </label>
        </div>
        {bulkMode && bulkAvailable && (
          <div className="agent-console-bulk-actions" role="group" aria-label={t("agentConsoleBulkMode")}>
            <label className="agent-console-bulk-select-all">
              <input
                type="checkbox"
                checked={allArchivableSelected}
                onChange={(event) => setSelectedForArchive(
                  event.target.checked ? new Set(archivableIds) : new Set(),
                )}
              />
              <span>{t("agentConsoleSelectVisible")}</span>
            </label>
            <span className="agent-console-bulk-count">{t("agentConsoleSelectedCount", { count: selectedForArchive.size })}</span>
            <div className="agent-console-bulk-buttons">
              <button
                type="button"
                className="text-button agent-console-bulk-cancel"
                disabled={bulkArchive.isPending}
                onClick={() => onBulkModeChange(false)}
              >
                <X size={15} />
                {t("agentConsoleBulkCancel")}
              </button>
              <button
                type="button"
                className="primary-button agent-console-bulk-submit"
                disabled={selectedForArchive.size === 0 || bulkArchive.isPending}
                onClick={() => {
                  const ids = [...selectedForArchive];
                  if (window.confirm(t("agentConsoleBulkArchiveConfirm", { count: ids.length }))) {
                    setBulkArchiveMessage(null);
                    bulkArchive.mutate(ids);
                  }
                }}
              >
                {bulkArchive.isPending ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
                {t("agentConsoleBulkArchive")}
              </button>
            </div>
          </div>
        )}
        {bulkArchiveMessage && <p className="agent-console-bulk-result" role="status">{bulkArchiveMessage}</p>}
        {filter === "failed" && healthQuery.data && (
          <section className="dispatch-health" aria-label={t("dispatchHealthTitle")}>
            <header>
              <strong>{t("dispatchHealthTitle")}</strong>
              <span>{t("dispatchHealthSummary", {
                failed: healthQuery.data.failed,
                total: healthQuery.data.total,
                rate: Math.round(healthQuery.data.failureRate * 100),
              })}</span>
            </header>
            <div className="dispatch-health-filters">
              {([
                ["node", healthNode, setHealthNode, healthQuery.data.groups.nodes],
                ["agent", healthAgent, setHealthAgent, healthQuery.data.groups.agents],
                ["version", healthVersion, setHealthVersion, healthQuery.data.groups.versions],
                ["code", healthCode, setHealthCode, healthQuery.data.groups.codes],
              ] as const).map(([kind, value, update, options]) => (
                <select key={kind} aria-label={t(`dispatchHealth${kind[0]!.toUpperCase()}${kind.slice(1)}` as "dispatchHealthNode")} value={value} onChange={(event) => update(event.target.value)}>
                  <option value="all">{t(`dispatchHealthAll${kind[0]!.toUpperCase()}${kind.slice(1)}s` as "dispatchHealthAllNodes")}</option>
                  {options.map((option) => <option key={option.key} value={option.key}>{option.key} ({option.failed}/{option.total})</option>)}
                </select>
              ))}
            </div>
            {healthFailures.slice(0, 5).map((dispatch) => (
              <article key={dispatch.id} className="dispatch-health-failure">
                <strong>{dispatch.itemKeys.join("、") || dispatch.id}</strong>
                <span>{dispatch.nodeName} · {dispatch.agentKind} · {dispatch.failureCode ?? "unknown"}/{dispatch.failureStage ?? "unknown"}</span>
                <small>{dispatch.error ?? t("dispatchHealthNoDetail")}</small>
              </article>
            ))}
          </section>
        )}
        <div className="agent-console-session-list">
          {!sessionsLoaded && !hasSessionsError && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
          {hasSessionsError && <p className="inline-error">{localizedErrorText(sessionsError, t)}</p>}
          {sessionsLoaded && visibleSessions.length === 0 && (
            <div className="agent-console-empty"><Bot size={22} /><p>{t(search.trim() ? "agentConsoleNoMatch" : "agentConsoleEmpty")}</p></div>
          )}
          {visibleSessions.map((session) => {
            const selectable = archivableIds.includes(session.id);
            const checked = selectedForArchive.has(session.id);
            return (
              <div
                key={session.id}
                className={`agent-console-session-row ${bulkMode ? "bulk-selecting" : ""} ${checked ? "selected" : ""}`}
              >
                {bulkMode && selectable && (
                  <label className="agent-console-session-select" aria-label={t("agentConsoleSelectConversation")}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setSelectedForArchive((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(session.id);
                        else next.delete(session.id);
                        return next;
                      })}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className={`agent-console-session ${session.id === selectedId ? "active" : ""} ${session.unread ? "unread" : ""}`}
                  aria-pressed={bulkMode && selectable ? checked : undefined}
                  onClick={() => {
                    if (bulkMode) {
                      if (selectable) {
                        setSelectedForArchive((current) => {
                          const next = new Set(current);
                          if (next.has(session.id)) next.delete(session.id);
                          else next.add(session.id);
                          return next;
                        });
                      }
                      return;
                    }
                    setOpenedSessionId(session.id);
                    onSelectSession(session.id, true);
                  }}
                >
                  <span className={`agent-console-status-icon agent-console-status-${session.status} agent-console-node-${session.nodeConnectionState}`}>
                    {session.nodeConnectionState === "offline" ? <WifiOff size={14} /> : <SessionStatusIcon status={session.status} />}
                  </span>
                  <span className="agent-console-session-copy">
                    <strong>{sessionTitle(session)}</strong>
                    <small>{session.nodeName} · {nodeConnectionLabel(session, t)} · {agentLabel(session, t)} · {session.archivedAt ? t("archived") : statusLabel(session.status, t)}</small>
                    {attentionLabel(session, t) && (
                      <i className="agent-console-attention" title={session.attention.reason}>
                        {attentionLabel(session, t)}
                      </i>
                    )}
                    <span>{session.latestMessage?.text ?? session.lastError ?? t("agentConsoleDispatchOnly")}</span>
                  </span>
                  {session.unread && <i className="agent-console-unread-dot" aria-label={t("agentConsoleUnreadOne")} />}
                  <time>{updatedTime(session.activityAt ?? session.updatedAt, locale)}</time>
                </button>
              </div>
            );
          })}
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
                <p>{agentLabel(selected, t)}</p>
                <AgentSessionSettingsBar session={selected} />
              </div>
              <span className={`status-pill agent-session-status-${sessionStatus}`}>{selected.archivedAt ? t("archived") : statusLabel(sessionStatus, t)}</span>
              {selected.sessionUrl && <SessionLink url={selected.sessionUrl} />}
              {selected.agentKind === "claude_code" && selected.agentSessionId && !selected.sessionUrl && (
                <span className="agent-session-muted" title={t("agentConsoleClaudeLocal")}>{t("agentConsoleClaudeLocalBadge")}</span>
              )}
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
                    className="secondary-button"
                    disabled={retryDispatch.isPending || stopDispatch.isPending}
                    onClick={() => {
                      if (window.confirm(t("agentConsoleStopConfirm"))) stopDispatch.mutate();
                    }}
                  ><Square size={16} />{t("agentConsoleStop")}</button>
                )}
                {selected.canArchive && selected.archivedSource !== "source" && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={archiveSession.isPending || pending}
                    onClick={() => {
                      const archived = Boolean(selected.archivedAt);
                      const confirmation = selected.agentKind === "claude_code"
                        && (selected.status === "active" || selected.status === "stalled")
                        ? t("agentSessionArchiveClaudeConfirm")
                        : t("agentSessionArchiveConfirm");
                      if (archived || window.confirm(confirmation)) archiveSession.mutate(!archived);
                    }}
                  >
                    {archiveSession.isPending
                      ? <LoaderCircle className="spin" size={16} />
                      : selected.archivedAt ? <RotateCcw size={16} /> : <Archive size={16} />}
                    {selected.archivedAt ? t("restore") : t("archive")}
                  </button>
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
                {(selected.needsAttention || selected.attention.dismissed) && selected.attention.reason && (
                  <div className={`agent-console-attention-banner ${selected.attention.dismissed ? "dismissed" : ""}`} role="status">
                    <BellRing size={17} />
                    <div>
                      <strong>{selected.attention.dismissed
                        ? t("agentAttentionDismissedTitle")
                        : attentionLabel(selected, t)}</strong>
                      <span>{selected.attention.reason}</span>
                    </div>
                    {selected.needsAttention
                      && selected.status !== "stalled"
                      && selected.agentSessionId
                      && selected.attention.revision && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={dismissAttention.isPending}
                        onClick={() => dismissAttention.mutate({
                          sessionId: selected.agentSessionId!,
                          revision: selected.attention.revision!,
                        })}
                      >
                        {dismissAttention.isPending && <LoaderCircle className="spin" size={14} />}
                        {t("agentAttentionDismiss")}
                      </button>
                    )}
                  </div>
                )}
                {dismissAttention.isError && <p className="inline-error">{localizedErrorText(dismissAttention.error, t)}</p>}
                {selected.archivedAt && (
                  <div className="agent-console-connection-banner archived" role="status">
                    <Archive size={17} />
                    <div>
                      <strong>{selected.archivedSource === "source" ? t("agentSessionSourceArchivedTitle") : t("agentSessionArchivedTitle")}</strong>
                      <span>{selected.archivedSource === "source" ? t("agentSessionSourceArchivedDetail") : t("agentSessionArchivedDetail")}</span>
                    </div>
                  </div>
                )}
                {selected.nodeConnectionState !== "online" && (
                  <div className={`agent-console-connection-banner ${selected.nodeConnectionState}`} role="status">
                    {selected.nodeConnectionState === "offline" ? <WifiOff size={17} /> : <CircleAlert size={17} />}
                    <div>
                      <strong>{selected.nodeRevoked
                        ? t("agentNodeRevokedTitle", { node: selected.nodeName })
                        : selected.nodeConnectionState === "offline"
                        ? t("agentNodeOfflineTitle", { node: selected.nodeName })
                        : t("agentNodeUnstableTitle", { node: selected.nodeName })}</strong>
                      <span>{selected.nodeRevoked
                        ? t("agentNodeRevokedDetail")
                        : selected.nodeLastSeenAt
                        ? t(selected.nodeConnectionState === "offline" ? "agentNodeOfflineDetail" : "agentNodeUnstableDetail", {
                          time: lastSeenAgo(selected.nodeLastSeenAt, locale) ?? "",
                        })
                        : t("agentNodeNeverSeen")}</span>
                    </div>
                  </div>
                )}
                <div className="agent-console-dispatch">
                  <span>{t("agentConsoleDispatchScope")}</span>
                  <div>{selected.items.map((item) => <button key={item.key} type="button" onClick={() => onOpenItem(item.key)}>{item.key}</button>)}</div>
                </div>
                {selected.agentSessionId && sessionQuery.isLoading && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
                {sessionQuery.isError && <p className="inline-error">{localizedErrorText(sessionQuery.error, t)}</p>}
                {sessionQuery.data?.messages.length === 0 && !outgoing && <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>}
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
                      <header className="agent-console-message-meta">
                        {labelKey && <small>{t(labelKey)}</small>}
                        <time dateTime={message.occurredAt}>{formatAgentMessageTime(message.occurredAt, locale)}</time>
                      </header>
                      <MarkdownText>{message.text}</MarkdownText>
                      {message.questions?.map((question) => (
                        <div key={question.title} className="agent-session-question">
                          {question.header && <small>{question.header}</small>}
                          <strong>{question.title}</strong>
                          {question.options && <div className="agent-session-options">
                            {question.options.map((option) => (
                              <button
                                key={option}
                                type="button"
                                disabled={!selected.canReply}
                                onClick={() => setReply((current) => questionAnswerText(
                                  current,
                                  question,
                                  option,
                                  message.questions?.length ?? 1,
                                ))}
                              >{option}</button>
                            ))}
                          </div>}
                        </div>
                      ))}
                    </article>
                  );
                })}
                {outgoing && (
                  <article className={`agent-console-message agent-console-message-user agent-console-message-outgoing agent-console-message-outgoing-${outgoing.status}`}>
                    <header className="agent-console-message-meta">
                      <time dateTime={outgoing.occurredAt}>{formatAgentMessageTime(outgoing.occurredAt, locale)}</time>
                    </header>
                    <MarkdownText>{outgoing.text}</MarkdownText>
                    <footer className="agent-console-message-delivery" role="status">
                      {outgoing.status === "failed"
                        ? <CircleAlert size={14} />
                        : <LoaderCircle className="spin" size={14} />}
                      <span>{outgoingReplyStatusLabel(outgoing.status, t)}{outgoing.error ? `: ${outgoing.error}` : ""}</span>
                      {outgoing.status === "queued" && outgoing.commandId && selected.canReply && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate({ sessionId: selected.agentSessionId!, commandId: outgoing.commandId!, text: outgoing.text })}
                        >
                          {cancel.isPending ? t("agentSessionCancelling") : t("agentSessionCancelAndEdit")}
                        </button>
                      )}
                      {outgoing.status === "failed" && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setReply(outgoing.text);
                            if (outgoing.commandId) setDismissedCommandId(outgoing.commandId);
                            else send.reset();
                          }}
                        >
                          {t("agentSessionEditAndRetry")}
                        </button>
                      )}
                    </footer>
                  </article>
                )}
                {activities.length > 0 && (
                  <section className="agent-console-background" aria-label={t("agentSessionBackgroundTitle")}>
                    <header><LoaderCircle className="spin" size={15} /><strong>{t("agentSessionBackgroundCount", { count: activities.length })}</strong></header>
                    <ul>{activities.map((activity) => (
                      <li key={activity.id}><span>{activity.title}</span>{activity.detail && <small>{activity.detail}</small>}</li>
                    ))}</ul>
                  </section>
                )}
                {(sessionQuery.data?.lastError ?? selected.lastError) && (
                  <p className="inline-error">{sessionQuery.data?.lastError ?? selected.lastError}</p>
                )}
                {selected.agentSessionId && !sessionQuery.isLoading && !sessionQuery.isError && (
                  <div className={`agent-console-activity agent-console-activity-${sessionStatus}`} role="status">
                    <SessionStatusIcon status={sessionStatus} />
                    <span>{t(activityLabelKey(sessionStatus, command?.status === "queued"), {
                      agent: agentLabel(selected, t),
                    })}</span>
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
                <p className="inline-error">{localizedErrorText(retryDispatch.error ?? stopDispatch.error, t)}</p>
              )}
              {archiveSession.isError && <p className="inline-error">{localizedErrorText(archiveSession.error, t)}</p>}
              {command?.kind === "interrupt" && (
                <div className={`agent-session-command agent-session-command-${command.status}`}>
                  <span>
                    {commandStatusLabel(command, t)}
                    {command.error ? `: ${command.error}` : ""}
                  </span>
                </div>
              )}
              {selected.canReply && selected.agentSessionId ? (
                <form onSubmit={submit}>
                  <AutoGrowTextarea
                    rows={1}
                    maximumHeight={240}
                    value={reply}
                    onChange={(event) => {
                      setReply(event.target.value);
                      if (send.isError && send.variables?.sessionId === selected.agentSessionId) send.reset();
                    }}
                    placeholder={t("agentSessionReplyPlaceholder", { agent: agentLabel(selected, t) })}
                    disabled={pending || sendingSelected}
                  />
                  <div className="agent-console-reply-actions">
                    <div className="agent-console-quick-replies" aria-label={t("agentSessionQuickReplies")}>
                      {[t("agentSessionQuickMergeRelease"), t("agentSessionQuickRelease")].map((quickReply) => (
                        <button
                          key={quickReply}
                          type="button"
                          className="secondary-button"
                          disabled={pending || sendingSelected}
                          onClick={() => {
                            setReply(quickReply);
                            if (send.isError && send.variables?.sessionId === selected.agentSessionId) send.reset();
                          }}
                        >
                          {quickReply}
                        </button>
                      ))}
                    </div>
                    <button type="submit" className="primary-button" disabled={!reply.trim() || pending || sendingSelected}>
                      {sendingSelected ? t("agentSessionSending") : t("agentSessionSend")}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="agent-session-muted" role="note">
                  {selected.agentSessionId
                    ? t(replyBlockedLabelKey(selected.replyBlockedReason))
                    : t("agentConsoleNoInlineReply")}
                </p>
              )}
              {cancel.isError && <p className="inline-error">{localizedErrorText(cancel.error, t)}</p>}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
