import { permissionReplyText } from "./permission-presentation";
import { DeliveryCards, MergeProgressBadge, useMergeProgress } from "./merge-console";
import { AgentOperationFeedback, useAgentOperationFeedback } from "./agent-operation-feedback";
import { AgentHistoryLoader, useAgentHistory } from "./agent-history";
import { AgentPlanContent, planContinuationObserved, planTranscript, repeatsSubmittedPlan } from "./agent-plan-content";
import { AgentStopFeedback } from "./agent-stop-feedback.js";
import { hasStoppableAgentTurn } from "@missiongo/domain";
import { ChatAttachments } from "./chat-attachments";
import type { ReactNode } from "react";
import { OverlayDialog } from "./overlay";
import { WebVersion } from "./web-version";
import { Select } from "./select";
import { BackButton } from "./back-button";
import { useConfirm } from "./confirm-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  BellRing,
  Bot,
  CircleAlert,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  Square,
  Video,
  WifiOff,
  X,
} from "lucide-react";

import { api } from "./api";
import { AgentSessionFailureNotice } from "./agent-session-failure-notice";
import { AgentHistoryNotice, AgentReplyFeedback, AgentRunDetails, SessionStatusIcon, isHistoryLimited, AgentSessionError } from "./agent-session-feedback";
import { AgentIcon } from "./agent-icons";
import {
  activityLabelKey,
  dispatchActivityLabelKey,
  approvalNeedsAction,
  approvalTitleKey,
  runWaitingLabelKey,
  waitingStatusLabelKey,
  planApprovalStatusKey,
  agentChatMessages,
  projectConversationMessages,
  agentSessionDetailRefetchInterval,
  agentSessionMatches,
  agentSessionCategory,
  agentOtherProjectCounts,
  archivableVisibleSessionIds,
  byLatestActivity,
  canonicalAgentSessionId,
  changedMessageIds,
  DEFAULT_AGENT_KIND_FILTER,
  DEFAULT_AGENT_SESSION_FILTER,
  effectiveAgentSessionStatus,
  formatAgentMessageTime,
  isNearMessageBottom,
  isAbnormalAgentSession,
  latestAgentSessionCommand,
  messageLabelKey,
  mergeAgentSessionSnapshot,
  outgoingReply,
  outgoingReplyStatusKey,
  replyBlockedLabelKey,
  externalProgressLabelKey,
  replyMirrorArrived,
  resolvedAgentSessionId,
  sessionCountsAsUnread,
  sessionInlineError,
  sessionReplyDraft,
  sessionStatusDetail,
  shouldMarkRead,
  shouldResetMessageView,
  shouldScrollMessagesAfterChange,
  type AgentKindFilter,
  type AgentAssociationFilter,
  type AgentSessionFilter,
  withSessionReplyDraft,
} from "./agent-session-view";
import { hasPendingPermissionQuestion } from "@missiongo/domain";
import { AgentSessionQuestions } from "./agent-session-questions";
import { DraftChatFile } from "./agent-chat-draft-file";
import { AgentSessionQuickSettings } from "./agent-session-settings";
import { ExternalNativeConnectionPanel } from "./external-native-connection";
import { sessionTitle } from "./agent-session-title";
import { agentLabelKey } from "./dispatch-eligibility";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import { MarkdownText } from "./markdown-text";
import { AgentArtifactMarkdown } from "./agent-artifact-viewer";
import type { AgentSession, AgentSessionAttachment, AgentSessionStatus, AgentSessionSummary, WorkItemAttachment } from "./types";
import { AutoGrowTextarea } from "./auto-grow-textarea";
import { mergeChatFiles } from "./agent-chat-files";
import { FileDropOverlay } from "./file-drop-overlay";
import { useFileDropZone } from "./file-drop";

const CHAT_FILE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.heic,.mp4,.mov,.webm,.log,.txt,.json,.md,.csv,.pdf";

const ASSOCIATION_OPTION_LABELS = { all: "agentConsoleAssociationAll", unlinked: "agentConsoleAssociationUnlinked", linked: "agentConsoleAssociationLinked", integration: "agentConsoleAssociationIntegration" } as const;
const AGENT_OPTION_LABELS = { all: "agentConsoleAllAgents", codex: "agentCodex", opencode: "agentOpenCode", claude_code: "agentClaudeCode" } as const;
// The console offers a fixed option set; sessions of other kinds only ever
// appear under "all" (AND-426 keeps the counts tied to these options).
type ConsoleAgentOption = keyof typeof AGENT_OPTION_LABELS;

function SessionCategoryBadge({ session }: { session: AgentSessionSummary }) {
  const { t } = useI18n();
  const category = agentSessionCategory(session);
  return <span className="agent-console-unlinked-badge" data-session-category={category}>{t(ASSOCIATION_OPTION_LABELS[category])}</span>;
}

function statusLabel(status: AgentSessionStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "active") return t("agentSessionActive");
  if (status === "idle") return t("agentSessionIdle");
  if (status === "suspended") return t("agentSessionSuspended");
  if (status === "stalled") return t("agentSessionStalled");
  if (status === "failed") return t("agentSessionFailed");
  return t("agentSessionUnavailable");
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

function elapsed(value: string | undefined, now: number): string | null {
  if (!value) return null;
  const start = Date.parse(value);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function nodeConnectionLabel(session: AgentSessionSummary, t: ReturnType<typeof useI18n>["t"]): string {
  if (session.source === "external") return t("agentExternalSource");
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
  // A source approval snapshot is a permission, a confirmation or an
  // unrecognizable legacy request; only a plan wait reads as 待批准 (AND-408).
  if (session.attention.kind === "approval") {
    if (approvalNeedsAction(session.approval)) {
      if (session.approval?.requestKind === "permission") return t("agentAttentionPermission");
      if (session.approval?.requestKind === "confirmation") return t("agentAttentionConfirmation");
      return t("agentAttentionPending");
    }
    return t(session.planApprovalPending ? "agentAttentionApproval" : "agentAttentionUncertain");
  }
  if (session.attention.kind === "action") return t("agentAttentionAction");
  if (session.attention.kind === "instruction") return t("agentAttentionInstruction");
  return t("agentAttentionUncertain");
}

export function AgentSessionConsole({
  productId,
  initialFilter,
  search = "",
  allSessions,
  sessionsLoaded,
  sessionsError,
  selectedSessionId,
  conversationOpen,
  draftView,
  bulkMode,
  onBulkModeChange,
  onBulkAvailabilityChange,
  onSelectSession,
  onBackToSessions,
}: {
  productId: string;
  initialFilter: AgentSessionFilter | null;
  search?: string;
  allSessions: readonly AgentSessionSummary[];
  sessionsLoaded: boolean;
  sessionsError: unknown;
  selectedSessionId: string | null;
  conversationOpen: boolean;
  draftView?: ReactNode;
  bulkMode: boolean;
  onBulkModeChange: (enabled: boolean) => void;
  onBulkAvailabilityChange: (available: boolean) => void;
  onSelectSession: (sessionId: string | null, showConversation: boolean) => void;
  onBackToSessions: () => void;
}) {
  const confirm = useConfirm();
  const { locale, t } = useI18n();
  const mergeProgress = useMergeProgress(productId);
  // A re-dispatched session keeps the item's name and adds the round (AND-365).
  const roundLabel = (round: number) => t("agentSessionRound", { round });
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AgentSessionFilter>(initialFilter ?? DEFAULT_AGENT_SESSION_FILTER);
  const [agentFilter, setAgentFilter] = useState<AgentKindFilter>(DEFAULT_AGENT_KIND_FILTER);
  const [association, setAssociation] = useState<AgentAssociationFilter>("all");
  const [replyDrafts, setReplyDrafts] = useState<Readonly<Record<string, string>>>({});
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const [replyFileDrafts, setReplyFileDrafts] = useState<Readonly<Record<string, File[]>>>({});
  const [replyFileErrors, setReplyFileErrors] = useState<Readonly<Record<string, string | null>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dismissedCommandId, setDismissedCommandId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  // The conversation the person clicked. Only that one counts as read; merely
  // opening the console or changing a filter never selects or reads a row.
  // (conversationOpen cannot tell: it only ever turns true on the one-pane layout.)
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(selectedSessionId);
  const [selectedForArchive, setSelectedForArchive] = useState<Set<string>>(new Set());
  const [bulkArchiveMessage, setBulkArchiveMessage] = useState<string | null>(null);
  // The item a dispatch chip opened a preview of (AND-159). A preview, not a
  // page: reading what the session is working on must not walk away from it.
  const [previewItemKey, setPreviewItemKey] = useState<string | null>(null);
  const [unavailableSessionId, setUnavailableSessionId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const observedSessionRef = useRef<string | null>(null);
  const conversationOpenRef = useRef(false);
  const previousMessagesRef = useRef<readonly { id: string; text: string }[]>([]);
  const previousOutgoingRef = useRef("");
  const unseenMessageIdsRef = useRef(new Set<string>());
  const hasSessionsError = sessionsError !== null && sessionsError !== undefined;

  const productSessions = useMemo(
    () => allSessions.filter((session) => session.productId === productId || session.items.some((item) => item.productId === productId)),
    [allSessions, productId],
  );
  const countMatches = (scope: readonly AgentSessionSummary[], key: AgentSessionFilter) =>
    scope.filter(session => agentSessionMatches(session, key, agentFilter, search, association));
  const counts = {
    unread: countMatches(productSessions, "unread").length,
    attention: countMatches(productSessions, "attention").length,
    active: countMatches(productSessions, "active").length,
    all: countMatches(productSessions, "all").length,
    failed: countMatches(productSessions, "failed").length,
    archived: countMatches(productSessions, "archived").length,
    productUnread: countMatches(productSessions, "all").filter(sessionCountsAsUnread).length,
    failedUnread: countMatches(productSessions, "failed").filter(sessionCountsAsUnread).length,
  };
  // AND-426: an option shows the count the list would hold when picked -- the
  // same promise the sidebar numbers make. Running reuses the sidebar's active
  // rule; the active filter already lists only running sessions, so there the
  // running badge would repeat the total and stays hidden.
  const optionCounts = useMemo(() => {
    const stats = (agent: AgentKindFilter, associationOption: AgentAssociationFilter) => {
      const rows = productSessions.filter(session => agentSessionMatches(session, filter, agent, search, associationOption));
      return { total: rows.length, running: rows.filter(session => !session.archivedAt && session.status === "active").length };
    };
    return {
      association: { all: stats(agentFilter, "all"), unlinked: stats(agentFilter, "unlinked"), linked: stats(agentFilter, "linked"), integration: stats(agentFilter, "integration") },
      agent: { all: stats("all", association), codex: stats("codex", association), opencode: stats("opencode", association), claude_code: stats("claude_code", association) },
    } satisfies {
      association: Record<keyof typeof ASSOCIATION_OPTION_LABELS, { total: number; running: number }>;
      agent: Record<ConsoleAgentOption, { total: number; running: number }>;
    };
  }, [association, agentFilter, filter, search, productSessions]);
  const renderOptionCounts = (stats: { total: number; running: number }) => sessionsLoaded && (
    <span className="agent-console-option-counts">
      {filter !== "active" && stats.running > 0 && (
        <span className="agent-console-option-running">{t("agentConsoleOptionRunning", { count: stats.running })}</span>
      )}
      <span>{t("agentConsoleOptionTotal", { count: stats.total })}</span>
    </span>
  );
  const otherProjectCounts = useMemo(
    () => agentOtherProjectCounts(allSessions, productId),
    [allSessions, productId],
  );
  const visibleSessions = useMemo(
    () => byLatestActivity(productSessions.filter((session) => agentSessionMatches(session, filter, agentFilter, search, association))),
    [agentFilter, association, filter, search, productSessions],
  );
  const archivableIds = useMemo(() => archivableVisibleSessionIds(visibleSessions), [visibleSessions]);
  const allArchivableSelected = archivableIds.length > 0
    && archivableIds.every((sessionId) => selectedForArchive.has(sessionId));
  const bulkAvailable = filter !== "archived" && archivableIds.length > 0;
  // A reply resolves "needs attention" and removes this row from that filter.
  // Keep the conversation the person is still reading; explicit filter and
  // navigation handlers remain responsible for leaving it (AND-147).
  const selectedId = resolvedAgentSessionId(
    canonicalAgentSessionId(selectedSessionId, allSessions),
    allSessions.map((session) => session.id),
    sessionsLoaded,
  );

  useEffect(() => {
    if (!sessionsLoaded || !selectedSessionId) return;
    const linked = allSessions.find((session) => session.id === canonicalAgentSessionId(selectedSessionId, allSessions));
    setUnavailableSessionId(linked ? null : selectedSessionId);
  }, [allSessions, selectedSessionId, sessionsLoaded]);

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
  }, [agentFilter, association, filter, productId, search]);

  useEffect(() => {
    onBulkAvailabilityChange(bulkAvailable);
    if (bulkMode && !bulkAvailable) onBulkModeChange(false);
  }, [bulkAvailable, bulkMode, onBulkAvailabilityChange, onBulkModeChange]);

  useEffect(() => {
    if (!bulkMode) setSelectedForArchive(new Set());
  }, [bulkMode]);

  useEffect(() => {
    if (draftView || selectedId === selectedSessionId) return;
    onSelectSession(selectedId, conversationOpen && Boolean(selectedId));
  }, [conversationOpen, draftView, onSelectSession, selectedId, selectedSessionId]);

  const selected = draftView ? undefined : allSessions.find((session) => session.id === selectedId);
  // The reply box belongs to the conversation it is written for: its draft is
  // kept under that session's agentSessionId, so an answer picked here never
  // follows you into another session or another product (AND-252). The key is
  // the id the reply is actually sent to, and it is unique per conversation.
  const replySessionId = selected?.agentSessionId ?? null;
  const reply = sessionReplyDraft(replyDrafts, replySessionId);
  const replySessionIdRef = useRef(replySessionId);
  replySessionIdRef.current = replySessionId;
  const replyFiles = replySessionId ? replyFileDrafts[replySessionId] ?? [] : [];
  const replyFileError = replySessionId ? replyFileErrors[replySessionId] ?? null : null;
  const setReplyFileErrorFor = useCallback((sessionId: string | null, error: string | null) => {
    if (sessionId) setReplyFileErrors((current) => ({ ...current, [sessionId]: error }));
  }, []);
  const setReplyFileError = useCallback((error: string | null) => setReplyFileErrorFor(replySessionId, error), [replySessionId, setReplyFileErrorFor]);
  const setReplyFilesFor = useCallback((sessionId: string | null, update: File[] | ((current: File[]) => File[])) => {
    if (!sessionId) return;
    setReplyFileDrafts((current) => ({ ...current, [sessionId]: typeof update === "function" ? update(current[sessionId] ?? []) : update }));
  }, []);
  const setReplyFiles = useCallback((update: File[] | ((current: File[]) => File[])) => setReplyFilesFor(replySessionId, update), [replySessionId, setReplyFilesFor]);
  const setReplyFor = useCallback((
    sessionId: string | null,
    update: string | ((current: string) => string),
  ) => {
    if (!sessionId) return;
    setReplyDrafts((current) => withSessionReplyDraft(current, sessionId, update));
  }, []);
  const setReply = useCallback((update: string | ((current: string) => string)) => {
    setReplyFor(replySessionId, update);
  }, [replySessionId, setReplyFor]);
  const sessionQuery = useQuery({
    queryKey: ["agent-session", selected?.agentSessionId],
    queryFn: async ({ queryKey }) => {
      const sessionId = queryKey[1] as string;
      const requestStarted = queryClient.getQueryData<AgentSession>(["agent-session", sessionId]);
      const incoming = await api.getAgentSession(sessionId);
      return mergeAgentSessionSnapshot(
        requestStarted,
        queryClient.getQueryData<AgentSession>(["agent-session", sessionId]),
        incoming,
      );
    },
    enabled: Boolean(selected?.agentSessionId) && documentVisible,
    refetchInterval: (query) => selected?.agentSessionId
      ? agentSessionDetailRefetchInterval(documentVisible, query.state.fetchFailureCount)
      : false,
  });
  // List summaries arrive before the transcript. Reveal the whole conversation
  // together, including approval/attention/recovery cards (AND-375). Cached
  // detail stays visible during polling and refetch errors; dispatches without
  // a native session have no detail request to wait for.
  const conversationReady = !selected?.agentSessionId || Boolean(sessionQuery.data);
  const feedback = useAgentOperationFeedback(selected?.agentSessionId, sessionQuery.data?.turnState?.turnStartedAt);
  const operationSessionId = selected?.agentSessionId ?? selected?.id ?? "";
  const planApprovalLocks = useRef(new Set<string>());
  const send = useMutation({
    mutationFn: async ({ sessionId, text, files, planApprovalRevision }: { sessionId: string; text: string; files: readonly File[]; occurredAt: string; planApprovalRevision?: string }) => {
      if (planApprovalRevision) return api.approveAgentSessionPlan(sessionId, planApprovalRevision);
      const uploaded: AgentSessionAttachment[] = [];
      try {
        for (const file of files) uploaded.push(await api.uploadAgentSessionAttachment(sessionId, file));
        return await api.sendAgentSessionCommand(sessionId, text, uploaded.map((attachment) => attachment.id));
      } catch (error) {
        await Promise.allSettled(uploaded.map((attachment) => api.deleteAgentSessionAttachment(sessionId, attachment.id)));
        throw error;
      }
    },
    onSuccess: (created, input) => {
      feedback.clear(input.sessionId);
      if (!input.planApprovalRevision) {
        setReplyFor(input.sessionId, "");
        setReplyFilesFor(input.sessionId, []);
        setReplyFileErrorFor(input.sessionId, null);
      }
      queryClient.setQueryData<AgentSession>(["agent-session", input.sessionId], (current) => current
        ? "approved" in created
          ? {...current,planApproval:undefined,planApprovalState:created,canApprovePlan:false,planApprovalStatus:{code:"approved"}}
          : { ...current, command: created, planApproval: undefined, planApprovalStatus: { code: "reply_pending" } }
        : current);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
    onError: (_error, input) => {
      if (input.planApprovalRevision) planApprovalLocks.current.delete(`${input.sessionId}:${input.planApprovalRevision}`);
      void queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] });
    },
  });
  const retryDispatch = useMutation({
    mutationFn: ({ dispatchId }: { sessionId: string; dispatchId: string }) => api.retryDispatch(dispatchId),
    onMutate: input => feedback.begin(input.sessionId, "retry"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });
  const stopDispatch = useMutation({
    mutationFn: ({ dispatchId }: { sessionId: string; dispatchId: string }) => api.stopDispatch(dispatchId),
    onMutate: input => feedback.begin(input.sessionId, "stop"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async (_created, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const archiveSession = useMutation({
    mutationFn: async (input: { sessionId: string; agentSessionId?: string | undefined; dispatchId?: string | undefined; archived: boolean }) => {
      if (input.agentSessionId) await api.setAgentSessionArchived(input.agentSessionId, input.archived);
      else await api.setDispatchArchived(input.dispatchId!, input.archived);
    },
    onMutate: input => feedback.begin(input.sessionId, "archive"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async (_created, input) => {
      const invalidations = [queryClient.invalidateQueries({ queryKey: ["agent-sessions"] })];
      if (input.agentSessionId) {
        invalidations.push(queryClient.invalidateQueries({ queryKey: ["agent-session", input.agentSessionId] }));
      }
      await Promise.all(invalidations);
    },
  });
  const dismissAttention = useMutation({
    mutationFn: ({ sessionId, revision }: { sessionId: string; revision: string }) =>
      api.dismissAgentSessionAttention(sessionId, revision),
    onMutate: input => feedback.begin(input.sessionId, "dismiss"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
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
        else await api.setDispatchArchived(session.dispatchId!, true);
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
        return `${session ? sessionTitle(session, roundLabel) : entry.sessionId}: ${reason}`;
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
    onMutate: input => feedback.begin(input.sessionId, "cancel", input.commandId),
    onError: (error, input, operation) => {
      feedback.fail(error, operation);
      void queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
    onSuccess: async (cancelled, input) => {
      setReplyFor(input.sessionId, input.text);
      queryClient.setQueryData<AgentSession>(["agent-session", input.sessionId], (current) => current ? { ...current, command: cancelled } : current);
      const restored = await Promise.allSettled((cancelled.attachments ?? []).map(async (attachment) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await fetch(api.agentSessionAttachmentUrl(input.sessionId, attachment.id), { credentials: "same-origin", signal: controller.signal });
          if (!response.ok) throw new Error("Attachment restore failed");
          return new File([await response.blob()], attachment.filename, { type: attachment.contentType });
        } finally { window.clearTimeout(timeout); }
      }));
      setReplyFilesFor(input.sessionId, restored.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
      setReplyFileErrorFor(input.sessionId, restored.some((result) => result.status === "rejected") ? t("agentChatRestoreFilesFailed") : null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const cancellingSelected = cancel.isPending && cancel.variables?.sessionId === replySessionId;
  const recalledSessionId = cancel.isSuccess ? cancel.variables?.sessionId : undefined;
  useEffect(() => {
    // Mutation callbacks can run before React commits the enabled textarea.
    // Focus only after that commit, and never steal focus from another conversation.
    if (recalledSessionId && replySessionIdRef.current === recalledSessionId) {
      document.querySelector<HTMLTextAreaElement>(".agent-console-reply textarea")?.focus();
    }
  }, [recalledSessionId, cancel.submittedAt]);
  const resolveDelivery = useMutation({
    mutationFn: ({ sessionId, commandId, outcome }: {
      sessionId: string; commandId: string; outcome: "received" | "not_received"; text: string;
    }) => api.resolveAgentSessionDelivery(sessionId, commandId, outcome),
    onMutate: input => feedback.begin(input.sessionId, "resolve", input.commandId),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSuccess: async (_command, input) => {
      if (input.outcome === "not_received") {
        setReplyFor(input.sessionId, input.text);
        setDismissedCommandId(input.commandId);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const approvalDecisionLocks = useRef(new Set<string>());
  const decideApproval = useMutation({
    mutationFn: ({ sessionId, approvalId, decision }: { sessionId: string; approvalId: string; decision: string }) =>
      api.decideAgentApproval(sessionId, approvalId, decision),
    onMutate: input => feedback.begin(input.sessionId, "approval"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const chooseApproval = (input: { sessionId: string; approvalId: string; decision: string }) => {
    const key = `${input.sessionId}:${input.approvalId}`;
    // React may not have rendered isPending before the second tap arrives.
    if (approvalDecisionLocks.current.has(key)) return;
    approvalDecisionLocks.current.add(key);
    decideApproval.mutate(input, { onError: () => { approvalDecisionLocks.current.delete(key); } });
  };
  const retryApproval = useMutation({
    mutationFn: ({ sessionId, approvalId }: { sessionId: string; approvalId: string }) =>
      api.retryAgentApproval(sessionId, approvalId),
    onMutate: input => feedback.begin(input.sessionId, "approvalRetry"),
    onError: (error, _input, operation) => feedback.fail(error, operation),
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-session", input.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
      ]);
    },
  });
  const submittedCommand = send.isSuccess && send.variables?.sessionId === selected?.agentSessionId && "id" in send.data
    ? send.data
    : undefined;
  const command = latestAgentSessionCommand(sessionQuery.data?.command, submittedCommand);
  const stopCommand = sessionQuery.data?.stopCommand ?? selected?.stopCommand ?? (command?.kind === "interrupt" ? command : undefined);
  const stopPending = stopCommand?.status === "queued" || stopCommand?.status === "delivering" || stopCommand?.status === "delivery_unknown";
  const pending = command?.status === "queued" || command?.status === "delivering"
    || command?.status === "delivery_unknown";
  const sendingSelected = send.isPending && send.variables?.sessionId === selected?.agentSessionId;
  const failedRequest = send.isError && send.variables?.sessionId === selected?.agentSessionId
    ? { text: send.variables.text, occurredAt: send.variables.occurredAt, status: "failed" as const, error: localizedErrorText(send.error, t) }
    : undefined;
  const sendingRequest = sendingSelected
    ? { text: send.variables.text, occurredAt: send.variables.occurredAt, status: "sending" as const }
    : failedRequest;
  const history = useAgentHistory(selected?.agentSessionId ?? null, sessionQuery.data, messagesRef);
  const previousHistoryRevision = useRef(0);
  const mirrorMessages = history.messages;
  const mirrorAttachments = sessionQuery.data?.attachmentMessages ?? [];
  const outgoingCandidate = outgoingReply(command, sendingRequest,
    replyMirrorArrived(command, mirrorMessages, mirrorAttachments, history.hasMore));
  const outgoing = outgoingCandidate?.commandId === dismissedCommandId ? null : outgoingCandidate;
  const outgoingSignature = outgoing ? `${selectedId}:${outgoing.commandId ?? "request"}:${outgoing.status}:${outgoing.text}` : "";
  const sessionStatus = effectiveAgentSessionStatus(
    sessionQuery.data?.status ?? selected?.status ?? "unavailable",
    command,
    sendingSelected,
    Boolean(sessionQuery.data?.turnState?.observedAt),
  );
  const messages = projectConversationMessages(history.messages, Boolean(selected?.productId));
  const attachmentMessages = sessionQuery.data?.attachmentMessages ?? [];
  const visibleMessages = agentChatMessages(messages, attachmentMessages, outgoing?.commandId);
  const activities = sessionQuery.data?.activities ?? [];
  const turnState = sessionQuery.data?.turnState ?? selected?.turnState;
  // Detail polls are faster than list polls. Use the same foreground rule as
  // the server so a stale canStop flag cannot outlive the turn shown here.
  const canStopCurrentTurn = selected?.canStop && (
    ["queued", "delivered"].includes(selected.dispatchStatus)
    || hasStoppableAgentTurn({ status: sessionQuery.data?.status ?? selected.status,
      turnState, command: sessionQuery.data ? command : selected.command, stopCommand })
  );
  const approval = sessionQuery.data ? sessionQuery.data.approval : selected?.approval;
  const questionPermission = Boolean(selected && hasPendingPermissionQuestion(selected.agentKind, visibleMessages.filter(message => !message.id.startsWith("history:"))));
  const showPermissionApproval = questionPermission || Boolean(approval && (approvalNeedsAction(approval)
    || (approval.kind === "manual" && approval.status === "pending")));
  const planApproved = sessionQuery.data?.planApprovalState;
  const planContinued = planContinuationObserved(sessionQuery.data);
  const stalePlanAttention = Boolean(planApproved && planContinued && selected?.attention.kind === "approval");
  const showPlanApproval = !planContinued && (Boolean(planApproved || sessionQuery.data?.planApproval
      || sessionQuery.data?.planApprovalStatus?.code === "content_unavailable"));
  const planApproval = sessionQuery.data?.planApproval;
  const planApprovalStatus = pending || sendingSelected ? { code: "reply_pending" }
    : sessionQuery.data?.planApprovalStatus;
  const planContentMissing = Boolean(showPlanApproval && !planApproved && !planApproval?.plan?.trim());
  const canApprovePlan = Boolean(!showPermissionApproval && planApproval?.plan?.trim() && planApprovalStatus?.code === "ready"
    && (sessionQuery.data?.canApprovePlan ?? (sessionQuery.data?.canReply && selected?.canReply)) && !pending && !sendingSelected && !cancellingSelected);
  const approvePlan = () => {
    if (!canApprovePlan || !planApproval || !selected?.agentSessionId) return;
    const key = `${selected.agentSessionId}:${planApproval.revision}`;
    if (planApprovalLocks.current.has(key)) return;
    planApprovalLocks.current.add(key);
    send.mutate({ sessionId: selected.agentSessionId, text: "批准", files: [],
      occurredAt: new Date().toISOString(), planApprovalRevision: planApproval.revision });
  };
  // A turn in progress reads as running for every agent that reports one —
  // Claude's own instrumentation, Codex mapping its active thread, OpenCode
  // reporting an active session without a pending question (AND-223).
  const turnRunning = selected !== undefined && ["claude_code", "codex", "opencode"].includes(selected.agentKind)
    && sessionStatus === "active"
    && turnState?.turnActive === true && !turnState.waitingForInput;
  // The fine print beside a running turn — thinking tokens, last output — is
  // metadata only Claude reports, so it stays Claude's alone.
  const claudeTurn = turnRunning && selected?.agentKind === "claude_code";
  // A pending question or form is not "running" (AND-205's OpenCode half,
  // AND-222): OpenCode reports it through waitingForInput the way Claude does.
  const agentWaiting = selected !== undefined && ["claude_code", "codex", "opencode"].includes(selected.agentKind)
    && ["active", "idle"].includes(sessionStatus)
    && (!pending || selected.agentKind === "codex") && turnState?.waitingForInput === true;
  const claudeBackgroundOnly = selected?.agentKind === "claude_code"
    && sessionStatus === "active" && turnState?.turnActive === false && !agentWaiting && activities.length > 0;
  const visualStatus = agentWaiting ? "idle" : sessionStatus;
  // Every activity line names the agent that is actually running this session
  // (AND-236): Codex and OpenCode report turns too, so the copy must not say
  // "Claude Code" for them.
  const agentName = selected ? agentLabel(selected, t) : "";
  const waitingText = selected?.agentKind === "codex"
    ? t("agentSessionWaitingApproval", { agent: agentName })
    : t("agentSessionWaitingForInput", { agent: agentName });
  const activityText = selected?.source === "external" && !selected.nativeConnection?.lastSyncedAt ? t(externalProgressLabelKey(selected)) : agentWaiting
    ? waitingText
    : claudeBackgroundOnly
      ? t("agentSessionWaitingBackground", { count: activities.length })
      : turnRunning && activities.length > 0
        ? t("agentSessionWaitingTool", { duration: elapsed(activities[0]?.startedAt, clock) ?? "–" })
      : turnRunning
        ? t("agentSessionTurnRunning", { duration: elapsed(turnState?.turnStartedAt, clock) ?? "–", agent: agentName })
        : t(activityLabelKey(sessionStatus, command?.kind !== "interrupt" && command?.status === "queued"), { agent: agentName });
  const sessionError = sessionQuery.data ? sessionQuery.data.lastError : selected?.lastError;
  const statusDetail = sessionStatusDetail(sessionStatus, sessionError, activityText);
  const inlineError = sessionInlineError(sessionStatus, sessionError);

  const markRead = useMutation({
    mutationFn: ({ sessionId, dispatchId, through }: { id: string; sessionId?: string | undefined; dispatchId?: string | undefined; through: string }) =>
      sessionId ? api.markAgentSessionRead(sessionId, through) : api.markDispatchRead(dispatchId!, through),
    // A mark-read that fails silently left the unread badge on forever with
    // nothing retrying it (AND-224); give the mutation its own retries.
    retry: 3,
    retryDelay: 2_000,
    onMutate: ({ id, through }) => {
      queryClient.setQueryData<{ sessions: AgentSessionSummary[] }>(["agent-sessions"], (current) => current && {
        sessions: current.sessions.map((session) => session.id === id && session.unreadAt === through
          ? { ...session, unread: false }
          : session),
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
  });
  const { mutate: markReadMutate } = markRead;
  const selectedUnreadAt = selected?.unread ? selected.unreadAt : undefined;
  const markReadRetry = markRead.isError && !markRead.isPending;
  useEffect(() => {
    if (!selected || selected.archivedAt || !shouldMarkRead(selected, openedSessionId === selected.id, documentVisible)) return;
    markReadMutate({ id: selected.id, sessionId: selected.agentSessionId, dispatchId: selected.dispatchId, through: selected.unreadAt });
    // Keyed on the unread clock, not the object: each poll returns a new one.
    // A failed attempt rejoins through the last dependency once the retries
    // run out, so the badge clears on a later poll instead of never.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selectedUnreadAt, openedSessionId, documentVisible, markReadMutate, markReadRetry]);

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
      previousHistoryRevision.current = history.revision;
      unseenMessageIdsRef.current.clear();
      setFollowLatest(true);
      setNewMessageCount(0);
      scrollToLatest();
      return;
    }

    if (previousHistoryRevision.current !== history.revision) {
      previousHistoryRevision.current = history.revision;
      return; // Prepending history is neither new output nor an unread event.
    }
    const changedIds = changedMessageIds(previousMessages, messages);
    if (changedIds.length === 0 && !outgoingChanged) return;
    if (shouldScrollMessagesAfterChange(outgoingChanged, followLatest)) scrollToLatest();
    else if (changedIds.length > 0) {
      changedIds.forEach((id) => unseenMessageIdsRef.current.add(id));
      setNewMessageCount(unseenMessageIdsRef.current.size);
    }
  }, [conversationOpen, followLatest, messages, outgoingSignature, scrollToLatest, selectedId, history.revision]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (selected?.canReply && selected.agentSessionId && (text || replyFiles.length)
      && (!replyFiles.length || sessionQuery.data?.canAttach) && !pending && !sendingSelected && !cancellingSelected) {
      send.mutate({ sessionId: selected.agentSessionId, text, files: replyFiles, occurredAt: new Date().toISOString() });
    }
  };
  // One gate for the three ways files reach the draft: the + picker, a drop,
  // and a paste (AND-234). The whole batch is rejected on the first problem,
  // so a stray unsupported file never drops a screenshot someone just pasted.
  const canAttach = sessionQuery.data?.canAttach === true;
  const addFilesList = (incoming: readonly File[]) => {
    if (incoming.length === 0 || cancellingSelected) return;
    if (sessionQuery.data && !canAttach) { setReplyFileError(t("agentChatNodeUpdate")); return; }
    const { files, rejection } = mergeChatFiles(replyFiles, incoming);
    if (rejection) {
      setReplyFileError(rejection.reason === "too-many"
        ? t("agentChatTooManyFiles")
        : t("agentChatInvalidFile", { filename: rejection.filename }));
      return;
    }
    setReplyFiles(files);
    setReplyFileError(null);
  };
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addFilesList, {
    canAccept: sessionQuery.data ? canAttach && replyFiles.length < 10 : true,
  });
  const replyPaste = (event: ClipboardEvent<HTMLElement>) => {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length === 0) return;
    event.preventDefault();
    addFilesList(pasted);
  };
  const addFiles = (incoming: FileList | null) => {
    // Copy before clearing the input: resetting .value empties the FileList.
    const picked = incoming ? Array.from(incoming) : [];
    if (fileInputRef.current) fileInputRef.current.value = "";
    addFilesList(picked);
  };
  const chooseFilter = (next: AgentSessionFilter) => {
    setFilter(next);
    if (selectedId && !productSessions.some((session) => session.id === selectedId
      && agentSessionMatches(session, next, agentFilter, search, association))) onSelectSession(null, false);
  };
  const chooseAgent = (next: AgentKindFilter) => {
    setAgentFilter(next);
    if (selectedId && !productSessions.some((session) => session.id === selectedId
      && agentSessionMatches(session, filter, next, search, association))) onSelectSession(null, false);
  };

  const showRecovery = Boolean(selected && !selected.archivedAt && isAbnormalAgentSession({ status: sessionStatus, ...(command ? { command } : {}) }));
  const failureCode = (sessionQuery.data ? sessionQuery.data.failure : selected?.failure)?.code;
  const needsNewSession = failureCode === "codex_context_window_exceeded" || failureCode === "codex_session_budget_exceeded";
  const canContinue = Boolean(selected?.canReply && sessionQuery.data?.canReply !== false && !pending && !sendingSelected && !needsNewSession);
  const recoveryHint = pending ? "agentRecoveryPending"
    : selected?.nodeRevoked ? "agentNodeRevokedReadOnly"
      : selected?.nodeConnectionState === "offline" ? "agentRecoveryOffline"
        : selected?.canRetry ? "agentRecoveryRetry"
          : needsNewSession ? "agentRecoveryNewSession"
            : canContinue ? "agentRecoveryReply" : "agentRecoveryAtSource";
  const showFailureCard = conversationReady && selected?.source !== "external" && selected?.agentKind === "codex" && sessionStatus === "failed";
  const showRunDetails = Boolean(selected?.agentSessionId && sessionQuery.data
    && !(selected.source !== "external" && selected.agentKind === "codex" && sessionStatus === "failed"));
  const stopAction = canStopCurrentTurn && (
    <button
      type="button"
      className="secondary-button agent-run-stop"
      disabled={retryDispatch.isPending || stopDispatch.isPending || stopPending}
      onClick={async () => {
        if (await confirm(t("agentConsoleStopConfirm"))) stopDispatch.mutate({ sessionId: operationSessionId, dispatchId: selected.dispatchId! });
      }}
    ><Square size={16} />{t("agentConsoleStop")}</button>
  );
  const sessionActions = selected && (
    <div className="agent-console-actions">
      {selected.canRetry && (
        <button
          type="button"
          className="secondary-button"
          disabled={retryDispatch.isPending || stopDispatch.isPending || (pending && !(selected.productId && ["failed", "cancelled"].includes(selected.dispatchStatus)))}
          onClick={async () => {
            const confirmation = selected.productId ? t("newSessionRetryConfirm") : selected.dispatchStatus === "delivered"
              ? t("agentConsoleRetryTimedOutConfirm") : t("agentConsoleRetryConfirm");
            if (await confirm(confirmation)) retryDispatch.mutate({ sessionId: operationSessionId, dispatchId: selected.dispatchId! });
          }}
        ><RotateCcw size={15} />{t(selected.productId ? "newSessionRetry" : "agentConsoleRetry")}</button>
      )}
      {selected.canArchive && selected.archivedSource !== "source" && (
        <button
          type="button"
          className="secondary-button"
          disabled={archiveSession.isPending}
          onClick={async () => {
            const archived = Boolean(selected.archivedAt);
            const confirmation = selected.agentKind === "claude_code"
              && (selected.status === "active" || selected.status === "stalled")
              ? t("agentSessionArchiveClaudeConfirm")
              : pending && !archived
                ? t("agentSessionArchivePendingConfirm")
                : t("agentSessionArchiveConfirm");
            if (archived || await confirm(confirmation)) archiveSession.mutate({ sessionId: operationSessionId, agentSessionId: selected.agentSessionId, dispatchId: selected.dispatchId, archived: !archived });
          }}
        >
          {archiveSession.isPending
            ? <LoaderCircle className="spin" size={16} />
            : selected.archivedAt ? <RotateCcw size={16} /> : <Archive size={16} />}
          {selected.archivedAt ? t("restore") : t("archive")}
        </button>
      )}
    </div>
  );

  const filters: Array<{ key: AgentSessionFilter; icon: typeof BellRing; count: number; unread?: number; label: string }> = [
    { key: "attention", icon: BellRing, count: counts.attention, label: t("agentConsoleNeedsAttention") },
    { key: "unread", icon: MessageSquare, count: counts.unread, label: t("agentConsoleUnread") },
    { key: "active", icon: LoaderCircle, count: counts.active, label: t("agentConsoleActive") },
    { key: "all", icon: MessageSquare, count: counts.all, unread: counts.productUnread, label: t("agentConsoleAll") },
    { key: "failed", icon: CircleAlert, count: counts.failed, unread: counts.failedUnread, label: t("agentConsoleFailed") },
    { key: "archived", icon: Archive, count: counts.archived, label: t("agentConsoleArchived") },
  ];

  const navigation = <div className="agent-console-filter-group" role="group" aria-label={t("agentConsoleCurrentProject")}>
    <p className="sidebar-label">{t("agentConsoleCurrentProject")}</p>
    <div className="agent-console-filter-items">
      {filters.map(({ key, icon: Icon, count, unread, label }) => <button key={key} type="button"
        className={`agent-console-filter ${filter === key ? "active" : ""}`} aria-pressed={filter === key} onClick={() => chooseFilter(key)}>
        <Icon className={key === "active" && filter === key ? "spin-when-active" : ""} size={16} />
        <span>{label}</span>
        {Boolean(unread) && <em className="agent-console-filter-unread" title={t("agentConsoleUnreadCount", { count: unread! })}>{unread}</em>}
        {sessionsLoaded && <small>{count}</small>}
      </button>)}
    </div>
  </div>;

  const otherProjectHint = (otherProjectCounts.attention > 0 || otherProjectCounts.unread > 0) && (
    <p className="agent-console-other-projects" role="status">
      <span>{t("agentConsoleOtherProjects")}</span>
      {otherProjectCounts.attention > 0 && <span>{t("agentConsoleNeedsAttention")} {otherProjectCounts.attention}</span>}
      {otherProjectCounts.attention > 0 && otherProjectCounts.unread > 0 && <span>·</span>}
      {otherProjectCounts.unread > 0 && <span>{t("agentConsoleUnread")} {otherProjectCounts.unread}</span>}
    </p>
  );

  return (
    <main className={`agent-console-page ${conversationOpen ? "mobile-conversation-open" : "mobile-list-open"}`}>
      <aside className="agent-console-filters" aria-label={t("agentConsoleFilters")}>
        <p className="sidebar-label">{t("agentConsoleTitle")}</p>
        {navigation}
        <p className="agent-console-scope-note">{t("agentConsoleScopeNote")}</p>
        <WebVersion />
      </aside>

      <section className="agent-console-list" aria-label={t("agentConsoleSessions")}>
        {unavailableSessionId && <p className="inline-error" role="alert">{t("agentConsoleUnavailableLink")}</p>}
        {otherProjectHint}
        <div className="agent-console-mobile-filters" aria-label={t("agentConsoleFilters")}>
          {navigation}
        </div>
        <div className="agent-console-list-controls">
          <Select aria-label={t("agentConsoleAssociationFilter")} value={association}
            renderValue={value => t(ASSOCIATION_OPTION_LABELS[value as AgentAssociationFilter])}
            renderOption={value => <span className="agent-console-option">
              <span>{t(ASSOCIATION_OPTION_LABELS[value as AgentAssociationFilter])}</span>
              {renderOptionCounts(optionCounts.association[value as AgentAssociationFilter])}
            </span>}
            onChange={event => {
              const next = event.target.value as AgentAssociationFilter;
              setAssociation(next);
              if (selectedId && !productSessions.some(session => session.id === selectedId
                && agentSessionMatches(session, filter, agentFilter, search, next))) onSelectSession(null, false);
            }}>
            <option value="all">{t("agentConsoleAssociationAll")}</option>
            <option value="unlinked">{t("agentConsoleAssociationUnlinked")}</option>
            <option value="linked">{t("agentConsoleAssociationLinked")}</option>
            <option value="integration">{t("agentConsoleAssociationIntegration")}</option>
          </Select>
          <label className="agent-console-agent-filter">
            <span>{t("agentConsoleAgentFilter")}</span>
            <Select
              aria-label={t("agentConsoleAgentFilter")}
              value={agentFilter}
              renderValue={value => t(AGENT_OPTION_LABELS[value as ConsoleAgentOption])}
              renderOption={value => <span className="agent-console-option">
                <span>{t(AGENT_OPTION_LABELS[value as ConsoleAgentOption])}</span>
                {renderOptionCounts(optionCounts.agent[value as ConsoleAgentOption])}
              </span>}
              onChange={(event) => chooseAgent(event.target.value as AgentKindFilter)}
            >
              <option value="all">{t("agentConsoleAllAgents")}</option>
              <option value="codex">{t("agentCodex")}</option>
              <option value="opencode">{t("agentOpenCode")}</option>
              <option value="claude_code">{t("agentClaudeCode")}</option>
            </Select>
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
                onClick={async () => {
                  const ids = [...selectedForArchive];
                  if (await confirm(t("agentConsoleBulkArchiveConfirm", { count: ids.length }))) {
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
        <div className="agent-console-session-list">
          {!sessionsLoaded && !hasSessionsError && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
          {hasSessionsError && <p className="inline-error">{localizedErrorText(sessionsError, t)}</p>}
          {sessionsLoaded && visibleSessions.length === 0 && (
            <div className="agent-console-empty"><Bot size={22} /><p>{t(search.trim() ? "agentConsoleNoMatch" : "agentConsoleEmpty")}</p></div>
          )}
          {visibleSessions.map((session) => {
            const selectable = archivableIds.includes(session.id);
            const checked = selectedForArchive.has(session.id);
            // A row whose reply is still on its way reads as working, so the
            // list does not say "ended" beside a session that is about to run
            // (AND-195).
            const rowStatus = effectiveAgentSessionStatus(session.status, session.command);
            const rowBackground = session.agentKind === "claude_code" && rowStatus === "active" && session.turnState?.turnActive === false
              && !session.turnState.waitingForInput && session.activities.length > 0;
            // Same rule as the conversation panel above (AND-222): an OpenCode
            // session blocked on a person reads as waiting, not as running.
            const rowWaiting = ["claude_code", "codex", "opencode"].includes(session.agentKind) && ["active", "idle"].includes(rowStatus)
              && (session.command?.status !== "queued" || session.agentKind === "codex") && session.turnState?.waitingForInput === true;
            const rowLabel = session.source === "external" && !session.nativeConnection?.lastSyncedAt ? t(externalProgressLabelKey(session)) : rowBackground ? t("agentSessionBackgroundStatus")
              : rowWaiting ? t(session.waitingForPermission ? "agentSessionWaitingApprovalStatus" : waitingStatusLabelKey(session)) : statusLabel(rowStatus, t);
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
                    setUnavailableSessionId(null);
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
                  <span className="agent-console-session-indicators">
                    <span
                      className={`agent-console-status-icon agent-console-status-${rowWaiting ? "idle" : rowStatus} agent-console-node-${session.nodeConnectionState}`}
                      role="img"
                      aria-label={`${nodeConnectionLabel(session, t)} · ${session.archivedAt ? t("archived") : rowLabel}`}
                    >
                      {session.nodeConnectionState === "offline" ? <WifiOff size={14} /> : <SessionStatusIcon status={rowWaiting ? "idle" : rowStatus} />}
                    </span>
                    {session.unread && <i className="agent-console-unread-dot" role="img" aria-label={t("agentConsoleUnreadOne")} />}
                  </span>
                  <span className="agent-console-session-copy">
                    <span className="agent-console-session-heading">
                      <strong>{sessionTitle(session, roundLabel)}</strong>

                      <time>{formatAgentMessageTime(session.activityAt ?? session.updatedAt, locale)}</time>
                    </span>
                    <span className="agent-console-session-meta">
                      <small>{session.source === "external" ? t("agentExternalSource") : session.nodeName} · {agentLabel(session, t)}</small>
                      <SessionCategoryBadge session={session} />
                    </span>
                    <MergeProgressBadge state={mergeProgress.sessions.get(session.agentSessionId ?? session.id)} />
                    {attentionLabel(session, t) && (
                      <i className="agent-console-attention" title={session.attention.reason}>
                        {attentionLabel(session, t)}
                      </i>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="agent-console-conversation" aria-live="polite">
        {draftView}
        {!draftView && !selected && <div className="agent-console-empty agent-console-empty-conversation"><MessageSquare size={24} /><p>{t("agentConsoleChoose")}</p></div>}
        {selected && (
          <>
            <header className="agent-console-conversation-head">
              <BackButton className="agent-console-conversation-back" label={t("agentConsoleBackToSessions")} onClick={onBackToSessions} />
              <span className="agent-console-avatar"><AgentIcon kind={selected.agentKind} size={18} /></span>
              <div className="agent-console-heading">
                <h2>{sessionTitle(selected, roundLabel)}<SessionCategoryBadge session={selected} /></h2>
                {/* The items this session is working on stay in the head, where
                    scrolling the conversation cannot lose them (AND-159). */}
                {selected.items.length > 0 && <div className="agent-console-dispatch agent-console-dispatch-head">
                  <div>{selected.items.map((item) => (
                    <button key={item.key} type="button" onClick={() => setPreviewItemKey(item.key)}>{item.key}</button>
                  ))}</div>
                </div>}
              </div>
              <div className="agent-console-toolbar">
                {!showRecovery && sessionActions}
              </div>
            </header>
            <div className="agent-console-message-stage">
              <div
                ref={messagesRef}
                className="agent-console-messages"
                aria-busy={!conversationReady && sessionQuery.isFetching}
                onScroll={(event) => {
                  const nearBottom = isNearMessageBottom(event.currentTarget);
                  setFollowLatest(nearBottom);
                  if (!nearBottom && !history.error && event.currentTarget.scrollTop <= 48) void history.loadMore();
                  if (nearBottom) {
                    unseenMessageIdsRef.current.clear();
                    setNewMessageCount(0);
                  }
                }}
              >
                {selected.agentSessionId && sessionQuery.isLoading && <div className="agent-console-empty" role="status" aria-label={t("agentSessionLoading")}><LoaderCircle className="spin" size={20} /></div>}
                {sessionQuery.isError && <div className="inline-error" role="alert">
                  <span>{localizedErrorText(sessionQuery.error, t)}</span>
                  {!conversationReady && <button type="button" className="text-button" disabled={sessionQuery.isFetching}
                    onClick={() => void sessionQuery.refetch()}>{t("retry")}</button>}
                </div>}
                {conversationReady && <>
                <AgentHistoryLoader history={history} />
                {selected.source === "external" && (
                  <div className="agent-console-connection-banner" role="status">
                    <CircleAlert size={17} />
                    <div><strong>{t(selected.approvalOnly ? "agentPlanPreclaimTitle" : "agentExternalSource")}</strong>
                      <span>{selected.approvalOnly ? t("agentPlanPreclaimDetail") : selected.nativeConnection?.automatic && !selected.nativeConnection.nodeId ? t("agentExternalAutoConnecting") : selected.nativeConnection ? t(selected.nativeConnection.state === "connected" ? "agentExternalNativeConnected"
                        : selected.nativeConnection.state === "pending" ? "agentExternalNativePending"
                          : selected.nativeConnection.state === "disconnected" ? "agentExternalNativeDisconnected" : "agentExternalNativeUnavailable",
                      { node: selected.nativeConnection.nodeName ?? "" }) : t("agentExternalDetail")}</span>
                      {selected.refKind === "tracking" && <span>{t("agentExternalTracking")}</span>}
                      {selected.lastReportedAt && <span>{t("agentExternalLastReport", { time: formatAgentMessageTime(selected.lastReportedAt, locale) })}</span>}
                      <ExternalNativeConnectionPanel key={selected.id} session={selected} />
                    </div>
                  </div>
                )}
                {selected.archivedAt && (
                  <div className="agent-console-connection-banner archived" role="status">
                    <Archive size={17} />
                    <div>
                      <strong>{selected.archivedSource === "source" ? t("agentSessionSourceArchivedTitle") : t("agentSessionArchivedTitle")}</strong>
                      <span>{selected.archivedSource === "source" ? t("agentSessionSourceArchivedDetail") : t("agentSessionArchivedDetail")}</span>
                    </div>
                  </div>
                )}
                {selected.source !== "external" && selected.nodeConnectionState !== "online" && (
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
                {sessionQuery.data?.managedExecution && <p className="agent-session-muted">
                  Hermes · {sessionQuery.data.managedExecution.role} · Run {sessionQuery.data.managedExecution.runId}
                  {" · "}{sessionQuery.data.managedExecution.stageId} / {sessionQuery.data.managedExecution.generation}
                </p>}
                {sessionQuery.data && visibleMessages.length === 0 && !outgoing && <p className="agent-session-muted">{t("agentSessionNoMessages")}</p>}
                {!selected.agentSessionId && (
                  <div className="agent-console-dispatch-state">
                    <Bot size={20} />
                    <strong>{t(dispatchActivityLabelKey(selected))}</strong>
                  </div>
                )}
                {planTranscript(visibleMessages, sessionQuery.data).map((message) => {
                  if (message === null) return <AgentPlanContent key="submitted-plan" session={sessionQuery.data} surface="console" />;
                  const repeatsPlan = repeatsSubmittedPlan(message, sessionQuery.data);
                  if (repeatsPlan && !message.questions?.length && !message.attachmentData?.length) return null;
                  const labelKey = messageLabelKey(message.role, selected.agentKind);
                  return (
                    <article key={message.id} data-agent-message-id={`${message.role}:${message.sourceId || message.id}`} className={`agent-console-message agent-console-message-${message.role}`}>
                      <header className="agent-console-message-meta">
                        {labelKey && <small>{t(labelKey)}</small>}
                        <time dateTime={message.occurredAt}>{formatAgentMessageTime(message.occurredAt, locale)}</time>
                      </header>
                      {!repeatsPlan && message.text && (selected.agentSessionId && ["agent", "plan"].includes(message.role)
                        ? <AgentArtifactMarkdown text={message.text} sessionId={selected.agentSessionId} messageId={message.id} onImageLoad={() => { if (followLatest) scrollToLatest("auto"); }} />
                        : <MarkdownText>{permissionReplyText(sessionQuery.data?.messages.flatMap(message => message.questions ?? []) ?? [], message.text)}</MarkdownText>)}
                      {message.attachmentData && selected.agentSessionId && <ChatAttachments sessionId={selected.agentSessionId} attachments={message.attachmentData} onImageLoad={() => { if (followLatest) scrollToLatest("auto"); }} />}
                      {message.questions && (
                        <AgentSessionQuestions
                          questions={message.questions}
                          sessionId={selected.agentSessionId}
                          sourceId={message.sourceId}
                          historical={message.id.startsWith("history:")}
                          agentKind={selected.agentKind}
                          reply={reply}
                          canReply={selected.canReply && !message.id.startsWith("history:") && !pending && !sendingSelected && !cancellingSelected}
                          onChange={setReply}
                        />
                      )}
                    </article>
                  );
                })}
                {!showPermissionApproval && (showPlanApproval || !stalePlanAttention && (selected.needsAttention || selected.attention.dismissed) && selected.attention.reason) && (
                  <div className={`agent-console-attention-banner ${selected.attention.dismissed ? "dismissed" : ""}${showPlanApproval ? " agent-console-attention-banner--approval" : ""}`} role="status">
                    <BellRing size={16} />
                    <details open={planContentMissing || undefined}>
                      <summary>{selected.attention.dismissed
                        ? t("agentAttentionDismissedTitle")
                        : showPlanApproval && planApproved ? t("agentPlanApproved") : showPlanApproval ? t("agentPlanReview") : attentionLabel(selected, t)}
                      </summary>
                      <div className="agent-console-attention-detail">
                        {(!showPlanApproval || !planApproved) && <p>{selected.attention.reason}</p>}
                        {showPlanApproval && <p>{planApproved ? t(planApproved.continuationQueued ? "agentPlanApprovedQueued" : planApproved.continuationPending ? "agentPlanApprovedWaiting" : "agentPlanApprovedNoReply") : t("agentPlanReviewHelp")}</p>}
                        {showPlanApproval && !planApproved && !canApprovePlan && <p className="agent-console-approve-reason" role="status">
                          {sessionQuery.isPending ? t("agentPlanChecking") : sessionQuery.isError ? t("agentPlanCheckFailed")
                            : t(planApprovalStatusKey(planContentMissing ? "content_unavailable" : planApprovalStatus?.code ?? "reply_unavailable"))}
                        </p>}
                      </div>
                    </details>
                    {showPlanApproval && !planApproved && <div className="agent-console-approve-action">
                      {planContentMissing && <button type="button" className="secondary-button" disabled={sessionQuery.isFetching}
                        onClick={() => void sessionQuery.refetch()}>{t("retry")}</button>}
                      <button type="button" className="primary-button"
                        disabled={!canApprovePlan || dismissAttention.isPending}
                        onClick={approvePlan}>{t("agentPlanApprove")}</button>
                    </div>}
                    {(!showPlanApproval || !planApproved) && (showPlanApproval || selected.needsAttention
                      && selected.status !== "stalled"
                      && selected.agentSessionId
                      && selected.attention.revision) && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={dismissAttention.isPending || !selected.agentSessionId || !selected.attention.revision || selected.status === "stalled"}
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
                {outgoing && (
                  <article className={`agent-console-message agent-console-message-user agent-console-message-outgoing agent-console-message-outgoing-${outgoing.status}`}>
                    <header className="agent-console-message-meta">
                      <time dateTime={outgoing.occurredAt}>{formatAgentMessageTime(outgoing.occurredAt, locale)}</time>
                    </header>
                    <MarkdownText>{permissionReplyText(sessionQuery.data?.messages.flatMap(message => message.questions ?? []) ?? [], outgoing.text)}</MarkdownText>
                    {command && command.id === outgoing.commandId && command.attachments && selected.agentSessionId
                      && <ChatAttachments sessionId={selected.agentSessionId} attachments={command.attachments} onImageLoad={() => { if (followLatest) scrollToLatest("auto"); }} />}
                    {sendingSelected && send.variables?.files.length ? <div className="agent-chat-draft-files">
                      {send.variables.files.map((file, index) => <DraftChatFile key={`${file.name}-${index}`} file={file} disabled />)}
                    </div> : null}
                    <AgentReplyFeedback status={outgoing.status} cancelling={cancellingSelected}
                      onEdit={outgoing.commandId && selected.canReply ? () => cancel.mutate({ sessionId: selected.agentSessionId!, commandId: outgoing.commandId!, text: outgoing.text }) : undefined} />
                    {(outgoing.status === "failed" || outgoing.status === "delivery_unknown") && (
                    <footer className="agent-console-message-delivery" role="alert">
                      <CircleAlert size={14} />
                      <span>{outgoing.status === "delivery_unknown"
                        ? t("agentSessionReplyDeliveryUnknown", { agent: agentName })
                        : t(outgoingReplyStatusKey(outgoing.status))}{outgoing.error ? `: ${outgoing.error}` : ""}</span>
                      {outgoing.status === "delivery_unknown" && outgoing.commandId
                        && sessionQuery.data?.canResolveDelivery && (
                        <>
                          <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                            onClick={() => resolveDelivery.mutate({ sessionId: selected.agentSessionId!, commandId: outgoing.commandId!, outcome: "received", text: outgoing.text })}>
                            {t("agentSessionReplyConfirmReceived", { agent: agentName })}
                          </button>
                          <button type="button" className="text-button" disabled={resolveDelivery.isPending}
                            onClick={() => resolveDelivery.mutate({ sessionId: selected.agentSessionId!, commandId: outgoing.commandId!, outcome: "not_received", text: outgoing.text })}>
                            {t("agentSessionReplyConfirmNotReceived")}
                          </button>
                        </>
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
                    )}
                  </article>
                )}
                <AgentHistoryNotice error={sessionQuery.data ? sessionQuery.data.lastError : selected.lastError} />
                {showFailureCard ? (
                  <AgentSessionFailureNotice status={sessionStatus}
                    failure={sessionQuery.data ? sessionQuery.data.failure : selected.failure}
                    legacyError={sessionQuery.data ? sessionQuery.data.lastError : selected.lastError} />
                ) : (selected.agentKind !== "codex" || (sessionStatus !== "idle" && sessionStatus !== "active"))
                  && inlineError
                  && !isHistoryLimited(inlineError) ? (
                  <AgentSessionError error={inlineError} onRetry={()=>void sessionQuery.refetch()} />
                ) : null}
                {showRecovery && (
                  <section className="agent-console-recovery" aria-label={t("agentRecoveryTitle")}>
                    <strong>{t("agentRecoveryTitle")}</strong>
                    <p>{t(recoveryHint)}</p>
                    {!selected.canReply && <p>{t(replyBlockedLabelKey(selected.replyBlockedReason))}</p>}
                    {sessionActions}
                    <div className="agent-console-recovery-links">
                      {canContinue && <button type="button" className="secondary-button" onClick={() => {
                        const input = document.getElementById(`agent-reply-${selected.id}`);
                        input?.scrollIntoView({ block: "nearest" });
                        input?.focus();
                      }}>{t("agentRecoveryContinue")}</button>}
                      {selected.items.map((item) => <a className="secondary-button" key={item.key}
                        href={`/?product=${encodeURIComponent(item.productId)}&item=${encodeURIComponent(item.key)}`}>
                        {t("agentRecoveryItem", { key: item.key })}
                      </a>)}
                    </div>
                    {selected.canArchive && <small>{t("agentRecoveryArchiveHint")}</small>}
                  </section>
                )}
                {approval && !questionPermission && showPermissionApproval && (
                  <section className="agent-console-attention-banner agent-console-approval" role="alert" aria-label={t(approvalTitleKey(approval)) }>
                    <header>
                      <BellRing size={16} />
                      <strong>{t(approvalTitleKey(approval))}</strong>
                      <span>{approval.status === "inProgress" ? t("agentApprovalReviewing")
                      : approval.status === "pending" ? t(approval.requestKind === "question" ? "agentQuestionWaiting" : "agentApprovalWaiting")
                        : approval.status === "denied" ? t("agentApprovalDenied")
                          : approval.status === "approved" ? t("agentApprovalApproved")
                            : approval.status === "reconnecting" ? t("agentApprovalReconnecting")
                            : approval.status === "unavailable" ? t("agentApprovalUnavailable") : approval.status}</span>
                    </header>
                    <details className="agent-console-approval-detail" key={approval.id}>
                      <summary><span>{approval.action}</span></summary>
                      <div>
                        {approval.reason && <p>{approval.reason}</p>}
                      </div>
                    </details>
                    {approval.kind === "manual" && approval.status === "pending" && selected.canReply
                      && selected.agentSessionId && (
                      <div className="agent-console-approval-actions">
                        {(approval.options ?? [{ id: "accept", kind: "once" }, { id: "decline", kind: "decline" }]).map((option, index, options) => {
                          const label = option.kind === "choice" ? option.label : t(({ once: "agentApprovalAccept", turn: "agentApprovalTurn", session: "agentApprovalSession",
                            always: "agentApprovalAlways", rule: "agentApprovalRule", networkAllow: "agentApprovalNetworkAllow", networkDeny: "agentApprovalNetworkDeny",
                            decline: "agentApprovalDecline", cancel: "agentApprovalCancel" } as const)[option.kind]);
                          const detailId = `approval-${approval.id}-option-${index}-detail`;
                          return (
                            <button key={option.id} type="button" aria-label={label} aria-describedby={option.detail ? detailId : undefined}
                              className={option.kind === "once" && index === options.findIndex(candidate => candidate.kind === "once")
                              ? "primary-button" : "secondary-button"}
                              disabled={Boolean(approval.decision) || decideApproval.isPending}
                              onClick={() => chooseApproval({ sessionId: selected.agentSessionId!, approvalId: approval.id, decision: option.id })}>
                              <span>{label}</span>
                              {option.detail && <small id={detailId}>{option.detail}</small>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {approval.kind === "manual" && approval.decision && <small role="status">{t("agentApprovalDecisionQueued")}</small>}
                    {approval.kind === "auto" && approval.status === "denied" && selected.canReply
                      && selected.agentSessionId && (
                      <div className="agent-console-approval-actions">
                        <button type="button" className="primary-button"
                          disabled={Boolean(approval.retryId) || retryApproval.isPending}
                          onClick={() => retryApproval.mutate({ sessionId: selected.agentSessionId!, approvalId: approval.id })}>
                          {t("agentApprovalRetryManual")}
                        </button>
                        {approval.retryStatus && <small>{t("agentApprovalRetryStatus")}: {t(({
                          queued: "agentApprovalRetryQueued", delivering: "agentApprovalRetryDelivering",
                          delivered: "agentApprovalRetryDelivered", restored: "agentApprovalRetryRestored",
                          failed: "agentApprovalRetryFailed",
                        } as const)[approval.retryStatus])}</small>}
                        {approval.retryError && <small>{approval.retryError}</small>}
                      </div>
                    )}
                  </section>
                )}
                {conversationReady && selected && <DeliveryCards productId={selected.productId ?? selected.items[0]?.productId ?? productId} sessionId={selected.agentSessionId ?? selected.id} />}
                <div className="agent-run-status" aria-label={t("agentRunFeedback")}>
                  <AgentOperationFeedback failures={feedback.failures} sessionId={operationSessionId} command={command} />
                  <AgentStopFeedback stop={stopCommand}
                    latestCommand={command} turnActive={sessionQuery.data?.turnState?.turnActive ?? false}
                    backgroundRunning={(sessionQuery.data?.activities.length ?? 0) > 0} />
                {showRunDetails && (<>
                    {["stalled", "unavailable", "failed"].includes(sessionStatus) && <p className="agent-run-warning" role="alert">{activityText}</p>}
                    <AgentRunDetails status={visualStatus} icon={<SessionStatusIcon status={visualStatus} />} actions={stopAction}
                      label={selected.source === "external" && !selected.nativeConnection?.lastSyncedAt ? t(externalProgressLabelKey(selected))
                        : agentWaiting ? t(questionPermission ? "agentRunApproval" : runWaitingLabelKey({ agentKind: selected.agentKind, approval }), { agent: agentName })
                          : claudeBackgroundOnly ? t("agentRunBackground") : sessionStatus === "active" ? t("agentRunActive", { agent: agentName }) : statusLabel(sessionStatus, t)}>
                      {!["stalled", "unavailable", "failed"].includes(sessionStatus) && <p>{statusDetail}</p>}
                      {outgoing && ["queued", "delivering", "delivered"].includes(outgoing.status) && <p>
                        {outgoing.status === "delivered" ? t("agentSessionReplyAwaitingExecution", { agent: agentName, duration: elapsed(outgoing.occurredAt, clock) ?? "–" })
                          : t("agentSessionReplyWaitingReason", { duration: elapsed(outgoing.occurredAt, clock) ?? "–",
                            reason: agentWaiting ? waitingText : activities.length > 0 ? t("agentSessionCurrentTool") : t("agentSessionCurrentTurn") })}
                      </p>}
                      {(turnRunning || sessionStatus === "stalled") && (turnState?.lastProgressAt || claudeTurn) && <small>{t("agentSessionLastActivity", { duration: elapsed(turnState?.lastProgressAt ?? selected.activityAt, clock) ?? "–" })}</small>}
                      {turnState?.observedAt && <small>{t("agentSessionLastObserved", { duration: elapsed(turnState.observedAt, clock) ?? "–" })}</small>}
                      {turnRunning && turnState?.lastOutputAt && <small>{t("agentSessionLastOutput", { duration: elapsed(turnState.lastOutputAt, clock) ?? "–" })}</small>}
                      {claudeTurn && (turnState?.thinkingStartedAt || (turnState?.thinkingTokens ?? 0) > 0) && <small>{t("agentSessionThinking", {
                        duration: duration((turnState?.thinkingDurationSeconds ?? 0) + (turnState?.thinkingStartedAt
                          ? Math.max(0, Math.floor((clock - Date.parse(turnState.thinkingStartedAt)) / 1000)) : 0)),
                        tokens: turnState?.thinkingTokens ?? 0,
                      })}</small>}
                      {turnRunning && command?.status === "queued" && <small>{t("agentSessionNextTurnQueued", { agent: agentName })}</small>}
                      {activities.length > 0 && (
                        <section className="agent-console-background" aria-label={t(selected.agentKind === "claude_code" ? "agentSessionBackgroundTitle" : "agentSessionCurrentActivities")}>
                          <header><SessionStatusIcon status={visualStatus} /><strong>{t(selected.agentKind === "claude_code" ? "agentSessionBackgroundCount" : "agentSessionToolCount", { count: activities.length })}</strong></header>
                          <ul>{activities.map((activity) => (
                            <li key={activity.id}>
                              <span>{activity.title === "等待 CI" ? t("agentSessionWaitingCI") : activity.title}</span>
                              <small>{activity.startedAt ? t("agentSessionBackgroundElapsed", { duration: elapsed(activity.startedAt, clock) ?? "–" }) : activity.detail}</small>
                              {selected.agentKind === "claude_code" && selected.canReply && selected.agentSessionId && !pending && !sendingSelected && (
                                <button type="button" className="text-button" onClick={() => setReply(t("agentSessionStopTaskMessage", { title: activity.title, id: activity.id }))}>
                                  {t("agentSessionRequestTaskStop")}
                                </button>
                              )}
                              {command?.kind === "message" && !["failed", "cancelled"].includes(command.status)
                                && command.text === t("agentSessionStopTaskMessage", { title: activity.title, id: activity.id })
                                && <small>{t("agentSessionTaskStopSent")}</small>}
                            </li>
                          ))}</ul>
                        </section>
                      )}
                    </AgentRunDetails>
                </>)}
                </div>
                </>}
                {!showRunDetails && (!showFailureCard || stopAction) && <div className="agent-run-controls agent-run-fallback">
                  {!showFailureCard && <p className={`agent-console-activity agent-console-activity-${visualStatus}`} role="status">
                    <SessionStatusIcon status={visualStatus} />
                    {!conversationReady ? t("agentSessionLoading") : selected.archivedAt ? t("archived")
                      : !selected.agentSessionId ? t(dispatchActivityLabelKey(selected)) : statusLabel(sessionStatus, t)}
                  </p>}
                  {stopAction}
                </div>}
              </div>
              {newMessageCount > 0 && (
                <button type="button" className="agent-console-new-messages" onClick={() => scrollToLatest("smooth")}>
                  <span>{t("agentConsoleNewMessages", { count: newMessageCount })}</span>
                  <ArrowDown size={15} />
                </button>
              )}
            </div>
            <footer className="agent-console-reply">
              {(selected.canReply || selected.replyBlockedReason === "starting") && selected.agentSessionId ? (
                <form onSubmit={submit} onPaste={replyPaste} {...dropHandlers}>
                  {isDraggingFiles && <FileDropOverlay remaining={Math.max(0, 10 - replyFiles.length)} limitReachedText={t("agentChatTooManyFiles")} />}
                  <AutoGrowTextarea
                    submitOnEnter
                    id={`agent-reply-${selected.id}`}
                    rows={1}
                    maximumHeight={240}
                    value={permissionReplyText(sessionQuery.data?.messages.flatMap(message => message.questions ?? []) ?? [], reply)}
                    onChange={(event) => {
                      setReply(permissionReplyText(sessionQuery.data?.messages.flatMap(message => message.questions ?? []) ?? [], event.target.value, true));
                      if (send.isError && send.variables?.sessionId === selected.agentSessionId) send.reset();
                    }}
                    placeholder={t("agentSessionReplyPlaceholder", { agent: agentLabel(selected, t) })}
                    disabled={!selected.canReply || pending || sendingSelected || cancellingSelected}
                  />
                  {replyFiles.length > 0 && <div className="agent-chat-draft-files">
                    {replyFiles.map((file, index) => <DraftChatFile key={`${file.name}-${index}`} file={file} disabled={sendingSelected || cancellingSelected}
                      onRemove={() => setReplyFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} />)}
                  </div>}
                  {replyFileError && <p className="inline-error" role="alert">{replyFileError}</p>}
                  <div className="agent-console-reply-actions">
                    <AgentSessionQuickSettings session={selected} />
                    <div className="agent-chat-send-actions">
                      <input ref={fileInputRef} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden
                        onChange={(event) => addFiles(event.target.files)} />
                      {(selected.source !== "external" || canAttach) && <button type="button" className="secondary-button agent-chat-icon-button"
                        disabled={!sessionQuery.data?.canAttach || pending || sendingSelected || cancellingSelected || replyFiles.length >= 10}
                        title={sessionQuery.data?.canAttach ? t("agentChatAddFile") : t("agentChatNodeUpdate")}
                        aria-label={t("agentChatAddFile")}
                        onClick={() => fileInputRef.current?.click()}><Plus size={18} /></button>}
                      <button type="submit" className="primary-button agent-chat-icon-button"
                        disabled={!selected.canReply || (!reply.trim() && replyFiles.length === 0) || (replyFiles.length > 0 && !sessionQuery.data?.canAttach) || pending || sendingSelected || cancellingSelected}
                        title={sendingSelected ? t("agentSessionSending") : t("agentSessionSend")}
                        aria-label={sendingSelected ? t("agentSessionSending") : t("agentSessionSend")}>
                        {sendingSelected ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
                      </button>
                    </div>
                  </div>
                  {selected.replyBlockedReason === "starting" && <p className="agent-session-muted" role="status">{t("agentSessionStarting")}</p>}
                  {selected.replyBlockedReason !== "starting" && sessionQuery.data && !sessionQuery.data.canAttach && <p className="agent-session-muted" role="note">{t("agentChatNodeUpdate")}</p>}
                </form>
              ) : (
                <p className="agent-session-muted" role="note">
                  {selected.agentSessionId
                    ? selected.nativeConnection?.state === "pending" && selected.nativeConnection?.automatic
                      ? t("agentExternalWaitingForNode") : t(replyBlockedLabelKey(selected.replyBlockedReason))
                    : t("agentConsoleNoInlineReply")}
                </p>
              )}
              {((!selected.canReply && selected.replyBlockedReason !== "starting") || !selected.agentSessionId) && <AgentSessionQuickSettings session={selected} />}
            </footer>
          </>
        )}
        {previewItemKey && <ItemPreviewModal itemKey={previewItemKey} onClose={() => setPreviewItemKey(null)} />}
      </section>
    </main>
  );
}

/**
 * A dispatch item as a popup (AND-159): enough to recognise the work -- what it
 * is, where it stands, what it says -- without walking away from the
 * conversation. Closing it returns to exactly the spot the chip was clicked on.
 * The card fits the window it opens in; a narrow one shows the same content
 * compacted.
 */
function ItemPreviewModal({ itemKey, onClose }: {
  readonly itemKey: string;
  readonly onClose: () => void;
}) {
  const { t, typeLabel, statusLabel, priorityLabel } = useI18n();
  const [selectedMedia, setSelectedMedia] = useState<WorkItemAttachment | null>(null);
  const itemQuery = useQuery({
    queryKey: ["item", itemKey],
    queryFn: () => api.getItem(itemKey),
  });
  const item = itemQuery.data;
  const overview = item?.report?.overview ?? item?.description;
  const media = item?.attachments.filter((attachment) => attachment.kind === "image" || attachment.kind === "video") ?? [];
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, selectedMedia?.id, selectedMedia?.revision, selectedMedia?.kind === "image" ? "drawable" : "original"],
    queryFn: () => selectedMedia?.kind === "image"
      ? api.downloadAttachmentPreview(itemKey, selectedMedia.id, selectedMedia.revision)
      : api.downloadAttachment(itemKey, selectedMedia!.id),
    enabled: Boolean(selectedMedia),
    staleTime: Infinity,
  });
  const contentUrl = usePreviewObjectUrl(contentQuery.data);
  return (
    <OverlayDialog
      className="item-preview-backdrop"
      aria-label={t("itemPreviewTitle", { key: itemKey })}
      onClose={onClose}
    >
      <div className="item-preview-card" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h3><code>{itemKey}</code> {item ? item.title : ""}</h3>
            {item && <p>{typeLabel(item.type)} · {statusLabel(item.status)} · {priorityLabel(item.priority)}</p>}
          </div>
          <button type="button" className="icon-button" aria-label={t("close")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="item-preview-body">
          {itemQuery.isLoading && <div className="agent-console-empty"><LoaderCircle className="spin" size={20} /></div>}
          {itemQuery.isError && <p className="inline-error">{localizedErrorText(itemQuery.error, t)}</p>}
          {item && (overview
            ? <MarkdownText>{overview}</MarkdownText>
            : <p className="agent-session-muted">{t("itemPreviewNoDescription")}</p>)}
          {media.length > 0 && <div className="item-preview-media">
            {media.map((attachment) => <ItemPreviewMediaTile key={attachment.id} itemKey={itemKey} attachment={attachment} onOpen={() => setSelectedMedia(attachment)} />)}
          </div>}
        </div>
      </div>
      {selectedMedia && <OverlayDialog className="item-preview-media-viewer" aria-label={selectedMedia.filename} onClose={() => setSelectedMedia(null)}>
        <div className="item-preview-media-viewer-content" onClick={(event) => event.stopPropagation()}>
          <header><strong>{selectedMedia.filename}</strong><button type="button" className="icon-button" aria-label={t("close")} onClick={() => setSelectedMedia(null)}><X size={18} /></button></header>
          {contentQuery.isLoading && <div className="media-viewer-loading"><LoaderCircle className="spin" size={22} /> {t("attachmentLoading")}</div>}
          {contentQuery.isError && <div className="media-viewer-loading attachment-error">{t("attachmentFailed")}</div>}
          {selectedMedia.kind === "image" && contentUrl && <img src={contentUrl} alt={selectedMedia.filename} />}
          {selectedMedia.kind === "video" && contentUrl && <ItemPreviewVideo src={contentUrl} filename={selectedMedia.filename} />}
        </div>
      </OverlayDialog>}
    </OverlayDialog>
  );
}

function usePreviewObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

function ItemPreviewMediaTile({ itemKey, attachment, onOpen }: {
  itemKey: string;
  attachment: WorkItemAttachment;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const thumbnailQuery = useQuery({
    queryKey: ["attachment-thumbnail", itemKey, attachment.id, attachment.revision, 192],
    queryFn: () => api.downloadAttachmentThumbnail(itemKey, attachment.id, 192, attachment.revision),
    enabled: attachment.kind === "image",
    staleTime: Infinity,
  });
  const thumbnailUrl = usePreviewObjectUrl(thumbnailQuery.data);
  const Icon = attachment.kind === "image" ? ImageIcon : Video;
  return <button type="button" className="item-preview-media-tile" aria-label={t("previewAttachment", { filename: attachment.filename })} title={attachment.filename} onClick={onOpen}>
    {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <Icon size={24} />}
    <span>{attachment.filename}</span>
  </button>;
}

function ItemPreviewVideo({ src, filename }: { src: string; filename: string }) {
  const { t } = useI18n();
  const [unplayable, setUnplayable] = useState(false);
  useEffect(() => setUnplayable(false), [src]);
  if (unplayable) return <div className="video-unplayable" role="status"><p>{t("videoUnplayable")}</p><a className="secondary-button" href={src} download={filename}>{t("download")}</a></div>;
  return <video src={src} controls autoPlay playsInline preload="metadata" onError={() => setUnplayable(true)} />;
}
