import { Select } from "./select";
import { DraftChatFile } from "./agent-chat-draft-file";
import { BuilderBadge } from "./builder-badge";
import { BackButton } from "./back-button";
import { useDialogDraft } from "./dialog-state";
import { useConfirm } from "./confirm-dialog";
import { itemFilterKey, type ItemFilters } from "@missiongo/domain";
import { ListFilters } from "./list-filters";
import { pickItemFilters } from "./item-filters";
import { BuilderHandoverNotice, ItemDeliveryPanel, ModuleBuilderSetting, TransferBuilderModal, useItemDelivery, executionStatusLabel } from "./item-delivery";
import { ItemDingTalkNotifications } from "./dingtalk-settings";
import { statisticsIsOpen, statisticsUrl, statisticsExitUrl } from "./statistics-state";
import { Modal } from "./modal";
import { StatusCheckButton, StatusCheckPanel } from "./status-check-panel";
import { localizedErrorText } from "./error-text";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type Dispatch as ReactDispatch, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { useInfiniteQuery, useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoginForm } from "./login-form";
import {
  BarChart3,
  Archive,
  ArrowRight,
  BellRing,
  Bot,
  Bug,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CirclePause,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileText,
  Highlighter,
  ImageIcon,
  Inbox,
  KeyRound,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Undo2,
  UserRoundCog,
  Video,
  WifiOff,
  X,
} from "lucide-react";

import { api, ApiError, type AuthenticatedUser, type BulkTransitionResult } from "./api";
import { BootSkeleton } from "./BootSkeleton";
import { clearPersistedQueryCache } from "./query-persistence";
// Type-only: erased at compile time, so it does not pull the chunk into the boot.
import type { ImageAnnotator as ImageAnnotatorImpl } from "./ImageAnnotator";
import {
  captureDraftStorageKey,
  hasCaptureDraftContent,
  parseCaptureDraft,
  workItemReportPayload,
  type CaptureDraft,
  type EnvironmentDraft,
} from "./capture-draft";
import { clearDraftFiles, loadDraftFiles, saveDraftFiles } from "./draft-files";
import { useFileDropZone } from "./file-drop";
import { FileDropOverlay } from "./file-drop-overlay";
import {
  MAX_DIAGNOSTIC_LOG_BYTES,
  collectWebContext,
  diagnosticLogBytes,
  diagnosticLogFile,
} from "./diagnostics";
import {
  COMPONENT_KINDS,
  ITEM_PRIORITIES,
  ITEM_TYPES,
  type Product,
  type Component,
  type ComponentKind,
  type CreatedSdkToken,
  type ItemDispatchHandler,
  type ItemDispatchSummary,
  type Dispatch,
  type TransitionAction,
  type WorkItem,
  type WorkItemAttachment,
  type WorkItemEnvironment,
  type WorkItemReference,
  type WorkItemEvent,
  type WorkItemOccurrenceFrequency,
  type WorkItemPriority,
  type WorkItemReport,
  type WorkItemStatus,
  type WorkItemType,
} from "./types";
import { androidFeedbackBridge, androidMediaDeletion, reportAndroidBackDepth } from "./android-bridge";
import { validateAttachment } from "./attachment-validation";
import {
  ACTIVE_DISPATCHES_QUERY_KEY,
  ACTIVE_DISPATCHES_REFETCH_MS,
  activeDispatchStatusKey,
  dispatchesByItem,
} from "./dispatch-conflicts";
import { DispatchDialog } from "./dispatch-dialog";
import {
  agentLabelKey,
  dispatchModeLabelKey,
  dispatchStatusLabelKey,
  canJoinSelection,
  isDispatchable,
  productAllowsAi,
  selectionScope,
  toggleItemSelection,
} from "./dispatch-eligibility";
import { environmentFields, environmentSummary, platformName, type EnvironmentField } from "./environment-summary";
import { ErrorBoundary, LoadFailureNotice } from "./ErrorBoundary";
import { useI18n } from "./i18n";
import { DownloadsPanel } from "./downloads-panel";
import { SettingsPage } from "./settings-page";
import { useSettingsNavigation } from "./settings-navigation";
import { useSettingsDraft } from "./settings-drafts";
import { settingsRoute as readSettingsRoute, type ProductSettingsSection } from "./settings-state";
import { applyConsoleFontScale, applyFontScale, readStoredConsoleFontScale, readStoredFontScale, storeConsoleFontScale, storeFontScale } from "./font-scale";
import { mayAdministerProduct } from "./product-permissions";
import { parseFeedbackLog, transitionRequiresNote, TRANSITION_NOTE_MAX_LENGTH } from "@missiongo/domain";
import { statusChangeNote, dispatchedEvent, groupTimeline } from "./timeline";
import { TransitionNoteDialog, transitionNoteCopy } from "./transition-note-dialog";
import { VerificationReturnBadge, VerificationReturnCallout, VerificationReturnSummary } from "./verification-return";
import { StartWorkDialog } from "./start-work-dialog";
import { cachedListSummary } from "./list-summary";
import { applyConfirmedItemTransition } from "./confirmed-item-transition";
import { useUnsavedChangesGuard } from "./unsaved-changes";
import { useForegroundSync } from "./use-foreground-sync";
import { manualMoves, TRANSITIONS } from "./work-item-transitions";
import {
  creatorLabel,
  creatorShort,
  COMMENT_COLLAPSE_THRESHOLD,
  commentAuthor,
  commentPlainText,
  deriveSummary,
  eventAgentName,
} from "./comment-summary";
import { isAnnotatableImage } from "./image-annotation";
import { LIST_THUMBNAIL_EDGE, drawableImageFile, drawsFromDecodedCopy, previewThumbnailEdge } from "./attachment-thumbnail";
import { MarkdownText } from "./markdown-text";
import {
  AGENT_CONSOLE_HISTORY_MARKER,
  AGENT_CONSOLE_LAYOUT_KEY,
  AGENT_CONVERSATION_HISTORY_MARKER,
  DEFAULT_STATUS,
  ITEM_HISTORY_MARKER,
  ITEM_STATUS_NAV_ORDER,
  OVERLAY_HISTORY_MARKER,
  SIDEBAR_HISTORY_MARKER,
  STATISTICS_HISTORY_MARKER,
  agentConsoleExitUrl,
  agentConsoleFilterFromUrl,
  agentConsoleIsOpen,
  agentConsoleLayoutFromState,
  agentConsoleUrl,
  agentSessionIdFromUrl,
  backDepthFromState,
  filtersFromUrl,
  filtersToUrl,
  itemDetailUrl,
  itemHistoryOp,
  itemKeyFromUrl,
  itemListUrl,
} from "./navigation";
import {
  DEFAULT_LIST_PANE_WIDTH,
  LIST_PANE_WIDTH_KEY,
  clampListPaneWidth,
  readListPaneWidth,
} from "./pane-layout";
import { ProductBadge } from "./product-badge";
import { SessionLink } from "./session-link";
import { AgentSessionPanel } from "./agent-session-panel";
import { AgentSessionConsole } from "./agent-session-console";
import { agentUnreadCounts, agentSessionDispatchFailed, agentSessionsRefetchInterval } from "./agent-session-view";
import { registerMissionGoWebMcp } from "./webmcp";
import { AutoGrowTextarea } from "./auto-grow-textarea";
import { useMediaQuery } from "./use-media-query";

const STATUS_ICONS: Record<WorkItemStatus, typeof Inbox> = {
  inbox: Inbox,
  ready: CircleDot,
  in_progress: Rocket,
  development_complete: CheckCircle2,
  on_hold: CirclePause,
  pending_verification: ClipboardCheck,
  done: CheckCircle2,
  cancelled: X,
};

const TYPE_ICONS: Record<WorkItemType, typeof Inbox> = {
  idea: Lightbulb,
  requirement: Sparkles,
  bug: Bug,
  task: ListTodo,
  note: FileText,
};

/**
 * Items per list page. Shared with the bootstrap request so the page it returns
 * lands under the exact query key the list then reads, and the list does not
 * refetch what it was just handed.
 */
const ITEM_PAGE_SIZE = 30;

/**
 * The annotator is only reachable once someone chooses to mark up an image, but
 * importing it statically put it on the cold-start path anyway: measured, its
 * chunk was fetched alongside the console chunk and evaluated before the first
 * paint, for a screen most visits never open. Loading it on demand keeps it out
 * of the boot.
 *
 * `Suspense` renders nothing while the chunk arrives. It opens as a modal from a
 * click, so the wait reads as ordinary click latency rather than a blank screen.
 *
 * The boundary is what makes that split safe. A chunk name only lives as long as
 * the build that produced it, so a page open across a deploy asks for a file the
 * server has already removed; React reports the rejected import as a render
 * error, and with nothing catching it the console -- not the modal, the whole
 * console -- was unmounted into a blank page (AND-35). Scoped here rather than
 * left to the root boundary so the failure costs the annotator and not the
 * screen behind it.
 */
const LazyImageAnnotator = lazy(
  () => import("./ImageAnnotator").then(({ ImageAnnotator }) => ({ default: ImageAnnotator })),
);

function ImageAnnotator(props: ComponentProps<typeof ImageAnnotatorImpl>) {
  return (
    <ErrorBoundary fallback={(error) => <LoadFailureNotice error={error} onDismiss={props.onCancel} />}>
      <Suspense fallback={null}>
        <LazyImageAnnotator {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

const REPORT_COPY = {
  idea: { title: "ideaDetails", help: "ideaDetailsHelp", overview: "ideaOverview", placeholder: "ideaOverviewPlaceholder" },
  requirement: { title: "requirementDetails", help: "requirementDetailsHelp", overview: "requirementOverview", placeholder: "requirementOverviewPlaceholder" },
  bug: { title: "bugDetails", help: "bugDetailsHelp", overview: "bugOverview", placeholder: "bugOverviewPlaceholder" },
  task: { title: "taskDetails", help: "taskDetailsHelp", overview: "taskOverview", placeholder: "taskOverviewPlaceholder" },
  note: { title: "noteDetails", help: "noteDetailsHelp", overview: "noteOverview", placeholder: "noteOverviewPlaceholder" },
} as const satisfies Record<WorkItemType, {
  readonly title: "ideaDetails" | "requirementDetails" | "bugDetails" | "taskDetails" | "noteDetails";
  readonly help: "ideaDetailsHelp" | "requirementDetailsHelp" | "bugDetailsHelp" | "taskDetailsHelp" | "noteDetailsHelp";
  readonly overview: "ideaOverview" | "requirementOverview" | "bugOverview" | "taskOverview" | "noteOverview";
  readonly placeholder: "ideaOverviewPlaceholder" | "requirementOverviewPlaceholder" | "bugOverviewPlaceholder" | "taskOverviewPlaceholder" | "noteOverviewPlaceholder";
}>;

// Only a .log is machine output. Everything else readable is material a
// person wrote or exported, and belongs beside the report rather than in
// the diagnostics panel.
const LOG_FILE_EXTENSIONS = new Set(["log"]);
const DOCUMENT_FILE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "pdf", "html"]);
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "mov", "webm"]);

function fileExtension(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

function isDiagnosticFile(file: File): boolean {
  return LOG_FILE_EXTENSIONS.has(fileExtension(file));
}

function isDocumentFile(file: File): boolean {
  return DOCUMENT_FILE_EXTENSIONS.has(fileExtension(file));
}

function isArchiveFile(file: File): boolean {
  return fileExtension(file) === "zip";
}

/** Images and videos: the attachments that are shown rather than read. */
function isMediaAttachment(attachment: WorkItemAttachment): boolean {
  return attachment.kind === "image" || attachment.kind === "video";
}

function mediaKindForFile(file: File): "image" | "video" {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("video/") || VIDEO_FILE_EXTENSIONS.has(extension) ? "video" : "image";
}

function environmentDraft(environment?: WorkItemEnvironment): EnvironmentDraft {
  return {
    platform: environment?.platform ?? "",
    appVersion: environment?.appVersion ?? "",
    buildNumber: environment?.buildNumber ?? "",
    sourceRevision: environment?.sourceRevision ?? "",
    osVersion: environment?.osVersion ?? "",
    deviceModel: environment?.deviceModel ?? "",
  };
}

function environmentPayload(
  draft: EnvironmentDraft,
  existingMetadata?: Readonly<Record<string, string>>,
  collectCurrentWeb = false,
): WorkItemEnvironment | undefined {
  const appVersion = draft.appVersion.trim();
  const buildNumber = draft.buildNumber.trim();
  const sourceRevision = draft.sourceRevision.trim();
  const osVersion = draft.osVersion.trim();
  const deviceModel = draft.deviceModel.trim();
  const metadata = draft.platform === "web" && collectCurrentWeb ? collectWebContext() : existingMetadata;
  if (!draft.platform) return undefined;
  return {
    platform: draft.platform,
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function FieldLabel({ children, required = false }: { children: ReactNode; required?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="field-label">
      {children}
      {required && <small className="field-requirement required">{t("requiredField")}</small>}
    </span>
  );
}

function hasOptionalEnvironmentDetails(draft: EnvironmentDraft): boolean {
  return Boolean(
    draft.appVersion.trim() ||
    draft.buildNumber.trim() ||
    draft.sourceRevision.trim() ||
    draft.osVersion.trim() ||
    draft.deviceModel.trim()
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function validateIncomingFiles(
  current: readonly File[],
  incoming: readonly File[],
  t: ReturnType<typeof useI18n>["t"],
  totalLimit = 10,
): { files: readonly File[]; error?: string } {
  const remaining = totalLimit - current.length;
  if (incoming.length > remaining) return { files: current, error: t("tooManyFiles", { count: remaining }) };
  const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const accepted: File[] = [];
  let error: string | undefined;
  for (const file of incoming) {
    const validation = validateAttachment(file);
    if (!validation.valid && validation.reason === "unsupported") {
      error ??= t("unsupportedFile", { filename: file.name });
      continue;
    }
    if (!validation.valid && validation.reason === "too-large") {
      error ??= t("fileTooLarge", { filename: file.name, size: validation.limitMiB });
      continue;
    }
    const identity = `${file.name}:${file.size}:${file.lastModified}`;
    if (!known.has(identity)) {
      known.add(identity);
      accepted.push(file);
    }
  }
  return { files: [...current, ...accepted], ...(error ? { error } : {}) };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function uploadAttachmentsSequentially(itemKey: string, files: readonly File[]): Promise<number> {
  let failed = 0;
  for (const file of files) {
    try {
      await api.uploadAttachment(itemKey, file);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

function filesWithDiagnosticLog(files: readonly File[], log: string): readonly File[] {
  const generatedLog = diagnosticLogFile(log);
  return generatedLog ? [...files, generatedLog] : files;
}

function useNearViewport<ElementType extends HTMLElement>(rootMargin = "160px"): [RefObject<ElementType | null>, boolean] {
  const ref = useRef<ElementType>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);
  return [ref, isNearViewport];
}

/**
 * The search shortcut as this keyboard spells it. The handler already takes
 * either modifier; only the hint was Mac-only, so Windows and Linux were told
 * to press a key they do not have.
 */
const SEARCH_SHORTCUT = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘ K" : "Ctrl K";

const StatisticsCenter = lazy(() => import("./statistics-center").then(module => ({default:module.StatisticsCenter})));

export function App() {
  const queryClient = useQueryClient();
  const { statusLabel, t } = useI18n();
  const initialFilters = useRef(filtersFromUrl()).current;
  const [selectedProductId, setSelectedProductId] = useState(
    () => initialFilters.productId || localStorage.getItem("missiongo.product") || "",
  );
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(() => itemKeyFromUrl());
  const [detailOpenInEdit, setDetailOpenInEdit] = useState(false);
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "all">(initialFilters.status);
  const [typeFilter, setTypeFilter] = useState<WorkItemType | "all">(initialFilters.type);
  const [search, setSearch] = useState(initialFilters.search);
  const [builderFilter, setBuilderFilter] = useState(initialFilters.builder ?? "");
  const [advancedFilters, setAdvancedFilters] = useState<ItemFilters>(() => pickItemFilters(initialFilters));
  const advancedFilterKey = itemFilterKey(advancedFilters);
  const [captureOpen, setCaptureOpen] = useState(false);
  const settings = useSettingsNavigation();
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [statisticsOpen,setStatisticsOpen] = useState(statisticsIsOpen);
  const [agentConsoleOpen, setAgentConsoleOpen] = useState(agentConsoleIsOpen);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  const [agentSessionId, setAgentSessionId] = useState<string | null>(agentSessionIdFromUrl);
  // Read before the deep-link handling below rewrites the URL without it.
  const [agentConsoleLinkedFilter, setAgentConsoleLinkedFilter] = useState(agentConsoleFilterFromUrl);
  const [agentConversationOpen, setAgentConversationOpen] = useState(
    () => Boolean(history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]),
  );
  const [agentConsoleBulkMode, setAgentConsoleBulkMode] = useState(false);
  const [agentConsoleBulkAvailable, setAgentConsoleBulkAvailable] = useState(false);
  const agentConsoleMoreRef = useRef<HTMLDetailsElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Below the two-pane breakpoint the sidebar is a drawer, and a closed drawer
  // is only moved off-screen: without inert, Tab still walked through every
  // link in it while nothing on screen showed where focus had gone.
  const sidebarIsDrawer = useSinglePaneLayout();
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [notice, setNotice] = useState<string | null>(null);

  /** One entry point for every panel the settings dialog holds. */
  const openSettings = (tab: "account" | "agents") => {
    settings.navigate({ section: tab === "agents" ? "agent" : sidebarIsDrawer ? "index" : "profile" });
    setSidebarOpen(false);
    syncBackDepth();
  };
  const [selectedItemKeys, setSelectedItemKeys] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The batch the dispatch dialog is about, captured when it opens.
   *
   * Not read back from the selection while the dialog is up: a successful
   * dispatch clears the selection, and the confirmation still has to say which
   * items went out.
   */
  const [dispatchBatch, setDispatchBatch] = useState<readonly WorkItem[] | null>(null);
  const [verifyBatch, setVerifyBatch] = useState<readonly WorkItem[] | null>(null);
  const [releaseBatch, setReleaseBatch] = useState<readonly WorkItem[] | null>(null);
  const [startWorkItem, setStartWorkItem] = useState<WorkItem | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const listScrollTopRef = useRef(0);
  const previousAgentConsoleOpenRef = useRef(agentConsoleOpen);
  // The console aligns the selected product with the open session once
  // (AND-263). This ref holds the session id that alignment already ran for,
  // so the 5s refetch or a manual switch never bounces the user back.
  const agentConsoleProductAlignedRef = useRef<string | null>(null);

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  // Coming back to the page re-reads what is on screen if it has gone stale
  // (AND-192); the spinner it returns drives the topbar indicator below.
  const foregroundSyncing = useForegroundSync();
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const agentConsoleSinglePane = useMediaQuery("(max-width: 520px)");
  const agentConsoleLayout = agentConsoleSinglePane ? "single" : "wide";

  const applyListPaneWidth = useCallback((width: number) => {
    // Measured rather than assumed: the sidebar is a fixed track, but the
    // window is not, and the share-based ceiling needs the real pane width.
    const available = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const next = clampListPaneWidth(width, available);
    setListPaneWidth(next);
    try {
      localStorage.setItem(LIST_PANE_WIDTH_KEY, String(next));
    } catch {
      // A width is not worth failing a drag over when storage is unavailable.
    }
  }, []);

  const restoreListScroll = useCallback(() => {
    requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: listScrollTopRef.current });
      window.scrollTo({ top: listScrollTopRef.current });
    });
  }, []);

  /**
   * Every history write goes through here, so the Android shell's back button
   * can never be looking at a stale depth. See AND-28.
   */
  const syncBackDepth = () => reportAndroidBackDepth(backDepthFromState(history.state));

  const openStatistics = () => {
    const state = {...history.state};
    const replacesDrawer = Boolean(state[SIDEBAR_HISTORY_MARKER]);
    delete state[SIDEBAR_HISTORY_MARKER];
    state[STATISTICS_HISTORY_MARKER] = true;
    history[replacesDrawer ? "replaceState" : "pushState"](state,"",statisticsUrl());
    setSidebarOpen(false); setSelectedItemKey(null); setStatisticsOpen(true);
    setAgentConsoleOpen(false); setMobileSearchOpen(false); syncBackDepth();
  };
  const closeStatistics = () => {
    if (history.state?.[STATISTICS_HISTORY_MARKER]) { history.back(); return; }
    history.replaceState(history.state,"",statisticsExitUrl());
    setStatisticsOpen(false); syncBackDepth();
  };

  const openAgentConsole = () => {
    // A deep-link filter applies only to that visit; a later ordinary opening
    // starts with the normal default even if this page first loaded from a link.
    setAgentConsoleLinkedFilter(null);
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    const {
      [AGENT_CONSOLE_HISTORY_MARKER]: _console,
      [AGENT_CONVERSATION_HISTORY_MARKER]: _conversation,
      [AGENT_CONSOLE_LAYOUT_KEY]: _layout,
      ...state
    } = current;
    history.pushState(
      {
        ...state,
        [AGENT_CONSOLE_HISTORY_MARKER]: true,
        [AGENT_CONSOLE_LAYOUT_KEY]: agentConsoleLayout,
      },
      "",
      agentConsoleUrl(null),
    );
    syncBackDepth();
    setAgentSessionId(null);
    setAgentConversationOpen(false);
    setAgentConsoleBulkMode(false);
    setAgentConsoleOpen(true);
    setMobileSearchOpen(false);
  };

  /**
   * Open the console on one dispatch's session, from the work item it belongs
   * to (AND-217). The console entry is pushed, so the item detail is still one
   * back away; on the phone layout the conversation is pushed above it, the
   * same way a deep link from the address bar lands.
   */
  const openAgentSession = (sessionId: string) => {
    setAgentConsoleLinkedFilter(null);
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    const {
      [AGENT_CONSOLE_HISTORY_MARKER]: _console,
      [AGENT_CONVERSATION_HISTORY_MARKER]: _conversation,
      [AGENT_CONSOLE_LAYOUT_KEY]: _layout,
      ...state
    } = current;
    const consoleState = {
      ...state,
      [AGENT_CONSOLE_HISTORY_MARKER]: true,
      [AGENT_CONSOLE_LAYOUT_KEY]: agentConsoleLayout,
    };
    history.pushState(consoleState, "", agentConsoleUrl(sessionId));
    if (agentConsoleSinglePane) {
      history.pushState(
        { ...consoleState, [AGENT_CONVERSATION_HISTORY_MARKER]: true },
        "",
        agentConsoleUrl(sessionId),
      );
    }
    syncBackDepth();
    setAgentSessionId(sessionId);
    // A freshly opened session gets one alignment pass (AND-263).
    agentConsoleProductAlignedRef.current = null;
    setAgentConversationOpen(agentConsoleSinglePane);
    setAgentConsoleBulkMode(false);
    setAgentConsoleOpen(true);
    setMobileSearchOpen(false);
  };

  const closeAgentConsole = () => {
    if (history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]) {
      // The mobile detail sits above the console list, so the top-bar action
      // skips both. The system back button still unwinds them one at a time.
      history.go(-2);
      return;
    }
    if (history.state?.[AGENT_CONSOLE_HISTORY_MARKER]) {
      history.back();
      return;
    }
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    const {
      [AGENT_CONSOLE_HISTORY_MARKER]: _console,
      [AGENT_CONVERSATION_HISTORY_MARKER]: _conversation,
      [AGENT_CONSOLE_LAYOUT_KEY]: _layout,
      ...state
    } = current;
    history.replaceState(state, "", agentConsoleExitUrl());
    syncBackDepth();
    setAgentConsoleOpen(false);
    setAgentSessionId(null);
    setAgentConversationOpen(false);
    setAgentConsoleBulkMode(false);
  };

  const selectAgentSession = (sessionId: string | null, showConversation: boolean) => {
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    const conversation = Boolean(sessionId && showConversation && agentConsoleSinglePane);
    const nextState = {
      ...current,
      [AGENT_CONSOLE_HISTORY_MARKER]: true,
      [AGENT_CONSOLE_LAYOUT_KEY]: agentConsoleLayout,
      [AGENT_CONVERSATION_HISTORY_MARKER]: conversation || undefined,
    };
    if (conversation && !history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]) {
      history.pushState(nextState, "", agentConsoleUrl(sessionId));
    } else {
      history.replaceState(nextState, "", agentConsoleUrl(sessionId));
    }
    syncBackDepth();
    setAgentSessionId(sessionId);
    // Re-selecting a session starts a fresh alignment pass (AND-263).
    agentConsoleProductAlignedRef.current = null;
    setAgentConversationOpen(conversation);
  };

  const closeAgentConversation = () => {
    if (history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]) {
      history.back();
      return;
    }
    setAgentConversationOpen(false);
  };

  const openItemPage = useCallback((itemKey: string, edit = false) => {
    if (selectedItemKey === itemKey) return;
    if (itemHistoryOp(selectedItemKey) === "push") {
      const workspace = workspaceRef.current;
      listScrollTopRef.current = workspace && workspace.scrollHeight > workspace.clientHeight
        ? workspace.scrollTop
        : window.scrollY;
      const state = typeof history.state === "object" && history.state ? history.state as Record<string, unknown> : {};
      history.pushState({ ...state, [ITEM_HISTORY_MARKER]: true }, "", itemDetailUrl(itemKey));
    } else {
      // Carry history.state through untouched. A detail reached by deep link
      // has no marker, and closeItemPage reads that to replace the URL instead
      // of calling back() -- which would leave the app entirely.
      history.replaceState(history.state, "", itemDetailUrl(itemKey));
    }
    reportAndroidBackDepth(backDepthFromState(history.state));
    setDetailOpenInEdit(edit);
    setSelectedItemKey(itemKey);
    requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: 0 });
      window.scrollTo({ top: 0 });
    });
  }, [selectedItemKey]);

  const closeItemPage = () => {
    setDetailOpenInEdit(false);
    if (history.state?.[ITEM_HISTORY_MARKER]) {
      history.back();
      return;
    }
    history.replaceState(history.state, "", itemListUrl());
    syncBackDepth();
    setSelectedItemKey(null);
    restoreListScroll();
  };

  /**
   * Land on a plain list URL without adding to the stack. Also drops the
   * overlay marker: the capture sheet's entry is collapsed into this one rather
   * than popped, because popping would race the URL rewrite below and leave the
   * sheet's entry as the one that got rewritten.
   */
  const clearItemPage = () => {
    const { [OVERLAY_HISTORY_MARKER]: _overlay, ...state } =
      (typeof history.state === "object" && history.state ? history.state : {}) as Record<string, unknown>;
    history.replaceState(state, "", itemListUrl());
    syncBackDepth();
    setDetailOpenInEdit(false);
    setSelectedItemKey(null);
  };

  /**
   * The capture sheet is a history entry, not just state, so the phone's back
   * gesture and the browser's back button close it instead of leaving the app.
   *
   * Pushed here rather than in an effect inside the sheet: this is the same
   * shape as openItemPage, and a push that happens in the handler that opens
   * the overlay cannot be doubled by StrictMode's second mount.
   */
  const openCapture = () => {
    if (!selectedProductCanCapture) { setNotice(t("captureReadOnly")); return; }
    const state = typeof history.state === "object" && history.state ? history.state as Record<string, unknown> : {};
    history.pushState({ ...state, [OVERLAY_HISTORY_MARKER]: true }, "");
    syncBackDepth();
    setCaptureOpen(true);
  };

  /**
   * The drawer is a layer too. Without an entry of its own, the phone's back
   * button saw nothing to unwind and left the app instead of closing it.
   */
  const openSidebar = () => {
    const state = typeof history.state === "object" && history.state ? history.state as Record<string, unknown> : {};
    history.pushState({ ...state, [SIDEBAR_HISTORY_MARKER]: true }, "");
    syncBackDepth();
    setSidebarOpen(true);
  };

  const closeSidebar = () => {
    if (history.state?.[SIDEBAR_HISTORY_MARKER]) {
      history.back();
      return;
    }
    setSidebarOpen(false);
  };
  const closeSidebarRef = useRef(closeSidebar);
  closeSidebarRef.current = closeSidebar;

  // An open drawer behaves like the dialog it looks like: focus moves into it,
  // Escape closes it, and closing hands focus back to the button that opened it.
  useEffect(() => {
    if (!sidebarOpen || !sidebarIsDrawer) return;
    sidebarRef.current?.querySelector<HTMLElement>(".sidebar-mobile-head button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebarRef.current();
    };
    document.addEventListener("keydown", closeOnEscape);
    const trigger = sidebarTriggerRef.current;
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      trigger?.focus();
    };
  }, [sidebarOpen, sidebarIsDrawer]);

  // Closing from the UI unwinds the entry the open added, so a later back press
  // is not spent on a sheet that is already gone.
  const closeCapture = () => {
    if (history.state?.[OVERLAY_HISTORY_MARKER]) {
      history.back();
      return;
    }
    setCaptureOpen(false);
  };

  useEffect(() => {
    const handlePopState = () => {
      if (!settings.syncFromPop()) return;
      // The overlay entry carries no URL of its own, so the marker on the state
      // is what says whether the sheet is still the top of the stack.
      syncBackDepth();
      if (!history.state?.[OVERLAY_HISTORY_MARKER]) setCaptureOpen(false);
      if (!history.state?.[SIDEBAR_HISTORY_MARKER]) setSidebarOpen(false);
      setStatisticsOpen(statisticsIsOpen());
      setAgentConsoleOpen(agentConsoleIsOpen());
      setAgentSessionId(agentSessionIdFromUrl());
      setAgentConversationOpen(Boolean(history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]));
      const itemKey = itemKeyFromUrl();
      setDetailOpenInEdit(false);
      setSelectedItemKey(itemKey);
      if (itemKey) {
        requestAnimationFrame(() => {
          workspaceRef.current?.scrollTo({ top: 0 });
          window.scrollTo({ top: 0 });
        });
      } else {
        restoreListScroll();
      }
    };
    // A detail reached by its own URL -- a deep link, or a WebView restored onto
    // one -- renders with nothing underneath it, so back had a level to close on
    // screen and none in the history. Give it the list entry it is missing.
    // Read once: the replaceState below drops the parameter, so asking the URL
    // again afterwards would hand back null and write "item=null".
    const deepLinkedConsole = !readSettingsRoute() && agentConsoleIsOpen();
    if (deepLinkedConsole && !history.state?.[AGENT_CONSOLE_HISTORY_MARKER]) {
      const sessionId = agentSessionIdFromUrl();
      const current = typeof history.state === "object" && history.state
        ? history.state as Record<string, unknown>
        : {};
      const {
        [AGENT_CONSOLE_HISTORY_MARKER]: _console,
        [AGENT_CONVERSATION_HISTORY_MARKER]: _conversation,
        [AGENT_CONSOLE_LAYOUT_KEY]: _layout,
        ...state
      } = current;
      history.replaceState(state, "", agentConsoleExitUrl());
      const consoleState = {
        ...state,
        [AGENT_CONSOLE_HISTORY_MARKER]: true,
        [AGENT_CONSOLE_LAYOUT_KEY]: agentConsoleLayout,
      };
      history.pushState(consoleState, "", agentConsoleUrl(sessionId));
      if (agentConsoleSinglePane && sessionId) {
        history.pushState(
          { ...consoleState, [AGENT_CONVERSATION_HISTORY_MARKER]: true },
          "",
          agentConsoleUrl(sessionId),
        );
      }
      setAgentConsoleOpen(true);
      setAgentSessionId(sessionId);
      setAgentConversationOpen(Boolean(agentConsoleSinglePane && sessionId));
    }
    const deepLinkedItem = readSettingsRoute() ? null : itemKeyFromUrl();
    if (!deepLinkedConsole && deepLinkedItem && !history.state?.[ITEM_HISTORY_MARKER]) {
      const state = typeof history.state === "object" && history.state ? history.state as Record<string, unknown> : {};
      history.replaceState(state, "", itemListUrl());
      history.pushState({ ...state, [ITEM_HISTORY_MARKER]: true }, "", itemDetailUrl(deepLinkedItem));
    }
    // The shell keeps its copy for the life of the activity, and a reload leaves
    // it holding the count from before. Start it from what this document has.
    reportAndroidBackDepth(backDepthFromState(history.state));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [agentConsoleLayout, agentConsoleSinglePane, restoreListScroll]);

  useEffect(() => {
    if (!agentConsoleOpen) return;
    const recordedLayout = agentConsoleLayoutFromState(history.state);
    if (recordedLayout === agentConsoleLayout) return;
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};

    if (agentConsoleSinglePane && agentSessionId) {
      // A wide console has its selected conversation in the same entry. When a
      // rotation makes it one-pane, turn that entry into the list underneath
      // and add the detail above it so back has somewhere correct to go.
      const listState = {
        ...current,
        [AGENT_CONSOLE_HISTORY_MARKER]: true,
        [AGENT_CONVERSATION_HISTORY_MARKER]: undefined,
        [AGENT_CONSOLE_LAYOUT_KEY]: "single",
      };
      history.replaceState(listState, "", agentConsoleUrl(agentSessionId));
      history.pushState(
        { ...listState, [AGENT_CONVERSATION_HISTORY_MARKER]: true },
        "",
        agentConsoleUrl(agentSessionId),
      );
      setAgentConversationOpen(true);
      syncBackDepth();
      return;
    }

    if (!agentConsoleSinglePane && history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]) {
      // The list becomes visible beside the conversation, so collapse the
      // mobile-only detail entry. Its underlying entry carries the same session.
      history.back();
      return;
    }

    history.replaceState(
      {
        ...current,
        [AGENT_CONSOLE_HISTORY_MARKER]: true,
        [AGENT_CONVERSATION_HISTORY_MARKER]: undefined,
        [AGENT_CONSOLE_LAYOUT_KEY]: agentConsoleLayout,
      },
      "",
      agentConsoleUrl(agentSessionId),
    );
    setAgentConversationOpen(false);
    syncBackDepth();
  }, [agentConsoleLayout, agentConsoleOpen, agentConsoleSinglePane, agentConversationOpen, agentSessionId]);

  useEffect(() => {
    if (!agentConsoleOpen || (agentConsoleSinglePane && agentConversationOpen)) {
      setAgentConsoleBulkMode(false);
    }
  }, [agentConsoleOpen, agentConsoleSinglePane, agentConversationOpen]);

  /**
   * The whole first screen in one request. It used to be three, chained --
   * session, then products, then items -- each waiting on the one before, and
   * the first two hidden behind full-screen spinners. Measured against
   * production that was three round trips of 185-234ms for about 15ms of actual
   * server work.
   *
   * The filters come from the ref captured on mount, not from live state: this
   * fetches the screen the visitor arrived on, once. Every later change is an
   * ordinary `itemsQuery` fetch.
   *
   * `retry: false` because the client default of 1 silently doubles the stall on
   * a flaky connection, which is exactly when it is most visible.
   */
  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      let data;
      try {
        data = await api.getBootstrap(
          initialFilters.productId || localStorage.getItem("missiongo.product"),
          {
            ...(initialFilters.status !== "all" ? { status: initialFilters.status } : {}),
            ...(initialFilters.type !== "all" ? { type: initialFilters.type } : {}),
            ...(initialFilters.search.trim() ? { search: initialFilters.search.trim() } : {}),
            ...(initialFilters.builder ? { builder: initialFilters.builder } : {}),
            ...pickItemFilters(initialFilters),
            limit: ITEM_PAGE_SIZE,
          },
        );
      } catch (error) {
        // A refused session means the screen cached on this device belongs to
        // someone who is no longer signed in here. Evict the restored queries as
        // well as the copy on disk: clearing only the disk leaves them in memory,
        // where the persistence subscription promptly writes them back out.
        if (error instanceof ApiError && error.status === 401) {
          for (const key of ["products", "items", "components", "project-insights", "project-insight-items"]) {
            queryClient.removeQueries({ queryKey: [key] });
          }
          clearPersistedQueryCache();
        }
        throw error;
      }
      // Seed the caches the rest of the screen reads from, here rather than in an
      // effect, so it happens before anything can observe this query as settled.
      // An effect would run a render too late, and the queries below would each
      // fire a request for data this response already carried.
      queryClient.setQueryData(["products"], data.products);
      if (data.productId) {
        queryClient.setQueryData(["components", data.productId, "with-archived"], data.components);
        queryClient.setQueryData(
          // Must match how itemsQuery builds its key below, trim included, or the
          // list mounts under a different key and refetches what we just seeded.
          ["items", data.productId, initialFilters.status, initialFilters.type, initialFilters.search.trim(), initialFilters.builder ?? "", itemFilterKey(initialFilters)],
          {
            pages: [{
              items: data.items,
              summary: data.summary,
              ...(data.nextBeforeSequence !== undefined ? { nextBeforeSequence: data.nextBeforeSequence } : {}),
            }],
            pageParams: [null],
          },
        );
      }
      return data;
    },
  });
  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: () => api.listProducts(),
    enabled: bootstrapQuery.isSuccess,
  });
  const products = productsQuery.data ?? bootstrapQuery.data?.products ?? [];
  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const selectedProductCanUseAi = productAllowsAi(selectedProduct);
  const selectedProductCanCapture = selectedProduct?.access?.canOperate === true;
  const hasAnyAiPermission = products.some(productAllowsAi);

  // The account's type size is the source of truth (AND-247). The boot script
  // already replayed this browser's cached copy before the first paint; once
  // bootstrap answers, a choice made on another device wins and the cache
  // catches up, so the next load starts at the right size.
  const serverFontScale = bootstrapQuery.data?.user.fontScale;
  useEffect(() => {
    if (serverFontScale && serverFontScale !== readStoredFontScale()) {
      applyFontScale(serverFontScale);
      storeFontScale(serverFontScale);
    }
  }, [serverFontScale]);
  // Same contract for the chat body's own size (AND-254): the boot script
  // replayed the cached copy, and the account repairs it once bootstrap answers.
  const serverConsoleFontScale = bootstrapQuery.data?.user.consoleFontScale;
  useEffect(() => {
    if (serverConsoleFontScale && serverConsoleFontScale !== readStoredConsoleFontScale()) {
      applyConsoleFontScale(serverConsoleFontScale);
      storeConsoleFontScale(serverConsoleFontScale);
    }
  }, [serverConsoleFontScale]);
  // One all-product feed drives every attention badge as well as the selected
  // product's console. Product switching is then a local filter, not another
  // request, and the header counts keep updating while the console is closed.
  const agentSessionsQuery = useQuery({
    queryKey: ["agent-sessions"],
    queryFn: () => api.listAgentSessions(),
    enabled: bootstrapQuery.isSuccess && products.length > 0,
    refetchInterval: (query) => agentSessionsRefetchInterval(
      agentConsoleOpen,
      documentVisible,
      query.state.fetchFailureCount,
    ),
  });
  const allAgentSessions = agentSessionsQuery.data?.sessions ?? [];
  useEffect(() => {
    if (!agentConsoleOpen || !agentSessionId) return;
    // Align once per session (AND-263). Without the ref guard this effect
    // re-ran on every 5s refetch and on every selectedProductId change,
    // bouncing the user back to the session's product right after a switch.
    if (agentConsoleProductAlignedRef.current === agentSessionId) return;
    const linked = allAgentSessions.find((session) => session.id === agentSessionId);
    if (!linked) return;
    agentConsoleProductAlignedRef.current = agentSessionId;
    if (!linked.items.some((item) => item.productId === selectedProductId)) {
      const productId = linked.items[0]?.productId;
      if (productId) setSelectedProductId(productId);
    }
  }, [agentConsoleOpen, agentSessionId, allAgentSessions, selectedProductId]);
  const unreadCounts = useMemo(() => agentUnreadCounts(allAgentSessions), [allAgentSessions]);

  useEffect(() => {
    const wasOpen = previousAgentConsoleOpenRef.current;
    previousAgentConsoleOpenRef.current = agentConsoleOpen;
    if (wasOpen && !agentConsoleOpen) {
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    }
  }, [agentConsoleOpen, queryClient]);

  useEffect(() => {
    if (!bootstrapQuery.isSuccess || products.length > 0 || !agentConsoleOpen) return;
    setNotice(t("agentConsoleUnavailableLink"));
    const current = typeof history.state === "object" && history.state
      ? history.state as Record<string, unknown>
      : {};
    const {
      [AGENT_CONSOLE_HISTORY_MARKER]: _console,
      [AGENT_CONVERSATION_HISTORY_MARKER]: _conversation,
      [AGENT_CONSOLE_LAYOUT_KEY]: _layout,
      ...state
    } = current;
    history.replaceState(state, "", agentConsoleExitUrl());
    syncBackDepth();
    setAgentConsoleOpen(false);
    setAgentSessionId(null);
    setAgentConversationOpen(false);
  }, [agentConsoleOpen, bootstrapQuery.isSuccess, products.length, t]);

  useEffect(() => {
    if (products.length === 0) return;
    if (!products.some((product) => product.id === selectedProductId)) {
      setSelectedProductId(products[0]!.id);
    }
  }, [products, selectedProductId]);

  useEffect(() => {
    if (selectedProductId) localStorage.setItem("missiongo.product", selectedProductId);
  }, [selectedProductId]);

  // Mirror the filters into the address bar so the view survives a refresh and
  // can be handed to someone else. replaceState keeps them out of the back
  // stack, which belongs to opening and closing items.
  useEffect(() => {
    if (!selectedProductId || statisticsOpen) return;
    const next = filtersToUrl({ productId: selectedProductId, status: statusFilter, type: typeFilter, search, builder: builderFilter, ...advancedFilters });
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      history.replaceState(history.state, "", next);
    }
  }, [search, selectedProductId, statusFilter, typeFilter, builderFilter, advancedFilters, statisticsOpen]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!statisticsOpen && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [statisticsOpen]);

  const buildersQuery = useQuery({ queryKey: ["builders", selectedProductId], queryFn: () => api.listBuilders(selectedProductId), enabled: bootstrapQuery.isSuccess && Boolean(selectedProductId) });
  const deferredSearch = useDeferredValue(search.trim());
  const itemsQuery = useInfiniteQuery({
    queryKey: ["items", selectedProductId, statusFilter, typeFilter, deferredSearch, builderFilter, advancedFilterKey],
    queryFn: ({ pageParam }) => api.listItems(selectedProductId, {
      ...advancedFilters,
      ...(builderFilter ? { builder: builderFilter } : {}),
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      ...(typeFilter !== "all" ? { type: typeFilter } : {}),
      ...(deferredSearch ? { search: deferredSearch } : {}),
      limit: ITEM_PAGE_SIZE,
      ...(pageParam ? { beforeSequence: pageParam } : {}),
    }),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextBeforeSequence ?? null,
    enabled: bootstrapQuery.isSuccess && Boolean(selectedProductId),
  });
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  // While a newly picked status loads, keep the counts the other tabs already
  // fetched: the summary ignores the status filter, so they are the same numbers
  // (AND-62). Without this every badge dropped to 0 for the length of a request.
  const itemSummary = itemsQuery.data?.pages[0]?.summary ?? (itemsQuery.isPending
    ? cachedListSummary(
      queryClient.getQueryCache().findAll({ queryKey: ["items", selectedProductId] }).map((query) => ({
        queryKey: query.queryKey,
        data: query.state.data,
        dataUpdatedAt: query.state.dataUpdatedAt,
      })),
      { productId: selectedProductId, type: typeFilter, search: deferredSearch, builder: builderFilter, advanced: advancedFilterKey },
    )
    : undefined);
  // Nothing to count yet: show a dash, not a 0 that is only the empty page talking.
  const countsPending = !itemSummary && itemsQuery.isPending;
  const componentsQuery = useQuery({
    queryKey: ["components", selectedProductId, "with-archived"],
    queryFn: () => api.listComponents(selectedProductId, { includeArchived: true }),
    enabled: bootstrapQuery.isSuccess && Boolean(selectedProductId),
  });
  const componentsById = useMemo(
    () => new Map((componentsQuery.data ?? []).map((component) => [component.id, component])),
    [componentsQuery.data],
  );
  // Marks rows with their latest dispatch attempt. Its own query rather than a
  // field on the item: list pages are cached on disk, while a Mac can pick up or
  // fail a dispatch much sooner than those pages refetch.
  const activeDispatchesQuery = useQuery({
    queryKey: ACTIVE_DISPATCHES_QUERY_KEY,
    queryFn: api.listActiveDispatches,
    enabled: bootstrapQuery.isSuccess,
    refetchInterval: ACTIVE_DISPATCHES_REFETCH_MS,
  });
  const latestDispatches = useMemo(
    () => dispatchesByItem(activeDispatchesQuery.data?.latest ?? activeDispatchesQuery.data?.active ?? []),
    [activeDispatchesQuery.data],
  );
  const inProgressHandlers = useMemo(
    () => new Map((activeDispatchesQuery.data?.handlers ?? []).map((handler) => [handler.itemKey, handler])),
    [activeDispatchesQuery.data],
  );
  // A dispatch that launched keeps reading "sent to {node}" for good, so a row
  // whose session then died has to take the failure from the session behind it
  // (AND-180). `null` is a failed session with no error text of its own.
  const sessionFailures = useMemo(() => {
    const byItem = new Map<string, string | null>();
    for (const session of allAgentSessions) {
      if (!agentSessionDispatchFailed(session)) continue;
      for (const item of session.items) byItem.set(item.key, session.lastError ?? null);
    }
    return byItem;
  }, [allAgentSessions]);
  const agentConsoleListFetching = useIsFetching({ queryKey: ["agent-sessions"] });
  const agentConsoleConversationFetching = useIsFetching({ queryKey: ["agent-session"] });
  const agentConsoleRefreshing = agentConsoleListFetching + agentConsoleConversationFetching > 0;
  const refreshAgentConsole = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
    queryClient.invalidateQueries({ queryKey: ["agent-session"] }),
  ]);
  const visibleItems = items;
  const showAttachmentColumn = visibleItems.some((item) => item.attachments.some(isMediaAttachment));
  const selectedItems = visibleItems.filter((item) => selectedItemKeys.has(item.key));
  // A selection is one status: the one both batch actions are keyed on (AND-66).
  const selectionStatus = selectedItems[0]?.status;

  // Permissions can be changed while this tab is open. A ready-item selection
  // must disappear with the dispatch controls, while verification selections
  // remain ordinary product operation and are left intact.
  useEffect(() => {
    if (!selectedProductCanUseAi && selectionStatus === "ready") setSelectedItemKeys(new Set());
  }, [selectedProductCanUseAi, selectionStatus]);

  /**
   * A selection belongs to the rows it was made on. Once the filters move those
   * rows off screen, keeping the ticks would mean dispatching work nobody can
   * see -- and across products, items whose repository is not the one the batch
   * would run in.
   */
  const listScope = advancedFilterKey + builderFilter + selectionScope({
    productId: selectedProductId,
    status: statusFilter,
    type: typeFilter,
    search: deferredSearch,
  });
  // Returning the set unchanged when it is already empty keeps the first render
  // after boot, and every filter change made with nothing ticked, free.
  useEffect(() => setSelectedItemKeys((current) => current.size === 0 ? current : new Set()), [listScope]);

  const selectItemProduct = useCallback((item: WorkItem) => {
    if (item.productId !== selectedProductId) setSelectedProductId(item.productId);
  }, [selectedProductId]);
  // The unfiltered list leaves cancelled items out, so the "all items" badge has
  // to leave them out too or it disagrees with the rows underneath it.
  const listedCount = itemSummary
    ? itemSummary.total - itemSummary.byStatus.cancelled
    : items.length;
  const openCount = itemSummary
    ? itemSummary.total - itemSummary.byStatus.done - itemSummary.byStatus.cancelled
    : items.filter((item) => !["done", "cancelled"].includes(item.status)).length;
  const verifyCount = itemSummary?.byStatus.pending_verification ?? items.filter((item) => item.status === "pending_verification").length;
  const statusCount = (status: WorkItemStatus) =>
    itemSummary?.byStatus[status] ?? items.filter((item) => item.status === status).length;
  const shownCount = (count: number): number | string => (countsPending ? "–" : count);
  useEffect(() => {
    if (!selectedProduct) return undefined;
    return registerMissionGoWebMcp(document.modelContext, {
      product: selectedProduct,
      visibleItems,
      activeFilters: { status: statusFilter, type: typeFilter, search },
      createItem: async (input) => {
        if (!selectedProductCanCapture) throw new Error(t("captureReadOnly"));
        const { platform, ...workItemInput } = input;
        const item = await api.createItem({ productId: selectedProduct.id, ...workItemInput, environment: { platform } });
        openItemPage(item.key);
        setNotice(t("capturedInInbox", { key: item.key }));
        await queryClient.invalidateQueries({ queryKey: ["items", selectedProduct.id] });
        return item;
      },
      openItem: (itemKey) => {
        const item = items.find((candidate) => candidate.key === itemKey);
        if (!item) throw new Error(t("itemNotLoaded", { key: itemKey }));
        openItemPage(item.key);
        return item;
      },
      reportError: (error) => setNotice(t("webToolError", { message: errorMessage(error, t("somethingWentWrong")) })),
    });
  }, [items, queryClient, search, selectedProduct, selectedProductCanCapture, statusFilter, t, typeFilter, visibleItems]);

  const selectStatus = (status: WorkItemStatus | "all") => {
    setStatusFilter(status);
    closeSidebar();
  };

  // Clearing list conditions preserves the product and sidebar status.
  const listFiltersActive = Boolean(search.trim() || builderFilter || typeFilter !== "all" || advancedFilterKey !== itemFilterKey());
  const clearFilters = () => {
    setBuilderFilter("");
    setAdvancedFilters({});
    setTypeFilter("all");
    setSearch("");
    setMobileSearchOpen(false);
  };

  // No full-screen spinner here any more. There were two -- "checking your
  // account", then "opening your workspace" -- one per request in the old chain,
  // and together they withheld the entire shell for two round trips. There is one
  // request now, and while it is in flight the visitor gets the same skeleton
  // that covered the chunk fetch, so the boot reads as one continuous load
  // rather than a blank screen followed by two spinners.
  // Cached from a previous visit and already hydrated, so the shell below can
  // render now and let the in-flight bootstrap replace it when it lands.
  const hasCachedScreen = products.length > 0;

  // Only when there is genuinely nothing to draw. With a cache, showing the
  // skeleton would hide a screen we already have.
  if (bootstrapQuery.isPending && !hasCachedScreen) return <BootSkeleton />;

  // Only a *refused* session, not any failure. Rendering cached items to someone
  // the server just turned away is exactly the failure a cache like this invites,
  // so a 401 reaches sign-in whatever this device still holds. An unreachable
  // server is the opposite case: the cached screen plus the offline banner is a
  // far better answer than a sign-in form the visitor cannot submit.
  const sessionRefused = bootstrapQuery.error instanceof ApiError && bootstrapQuery.error.status === 401;
  if (sessionRefused || (!bootstrapQuery.isPending && !bootstrapQuery.data && !hasCachedScreen)) {
    return (
      <main className="connection-page">
        <Brand />
        <section className="connection-card">
          <div className="round-icon"><KeyRound size={24} /></div>
          <p className="eyebrow">{t("privateWorkspace")}</p>
          <h1>{t("connectTitle")}</h1>
          <p>{t("connectBody")}</p>
          <LoginForm
            onAuthenticated={(session) => {
              queryClient.removeQueries({ queryKey: ["items"] });
              queryClient.removeQueries({ queryKey: ["components"] });
              queryClient.removeQueries({ queryKey: ["project-insights"] });
              queryClient.removeQueries({ queryKey: ["project-insight-items"] });
              queryClient.setQueryData(["auth-session"], session);
              // Whoever signed in may not be who this device cached.
              clearPersistedQueryCache();
              // Refetching bootstrap is what draws the workspace: it carries the
              // products, the first page of items and the components in one go,
              // and re-seeds the caches the shell reads.
              void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
              void queryClient.invalidateQueries({ queryKey: ["products"] });
            }}
          />
        </section>
      </main>
    );
  }

  if (settings.route) {
    if (!bootstrapQuery.data) return <BootSkeleton />;
    return <SettingsPage route={settings.route} user={bootstrapQuery.data.user} products={products}
      canUseAi={hasAnyAiPermission} navigate={settings.navigate} guard={settings.guard}
      onLoggedOut={() => { clearPersistedQueryCache(); window.location.reload(); }}
      renderProduct={(product, section) => <ProductSettings key={`${product.id}:${section}`} product={product} user={bootstrapQuery.data.user} section={section} componentId={settings.route?.componentId} onOpenComponent={componentId => settings.navigate({ section: "components", productId: product.id, componentId })} onSelected={() => undefined} />}
      renderNewProduct={() => <ProductForm onCreated={async product => {
        await queryClient.invalidateQueries({ queryKey: ["products"] });
        settings.navigate({ section: "overview", productId: product.id }, true);
      }} />}
    />;
  }

  if (products.length === 0) {
    return (
      <main className="onboarding-page">
        <header className="onboarding-header"><Brand /></header>
        <section className="onboarding-card">
          <div className="step-marker">01</div>
          <p className="eyebrow">{t("startWorkspace")}</p>
          <h1>{t("createFirstProduct")}</h1>
          <p>{t("productHelp")}</p>
          <ProductForm
            onCreated={(product) => {
              setSelectedProductId(product.id);
              void queryClient.invalidateQueries({ queryKey: ["products"] });
            }}
          />
        </section>
        <p className="onboarding-tagline">From idea to shipped.</p>
      </main>
    );
  }

  if (statisticsOpen && !selectedItemKey) return <Suspense fallback={<BootSkeleton />}><StatisticsCenter accountId={bootstrapQuery.data?.user.id} products={products} onClose={closeStatistics} onOpenItem={(key,productId)=>{setSelectedProductId(productId);openItemPage(key);}} /></Suspense>;

  return (
    <div className={`app-shell ${agentConsoleOpen ? "agent-console-open" : ""} ${
      agentConsoleOpen && agentConsoleSinglePane && agentConversationOpen ? "agent-conversation-open" : ""
    }`}>
      <header className={`topbar ${agentConsoleOpen ? "agent-console-topbar" : ""} ${mobileSearchOpen ? "searching" : ""}`} inert={sidebarIsDrawer && sidebarOpen}>
        {!agentConsoleOpen && <button ref={sidebarTriggerRef} className="icon-button mobile-only" onClick={() => openSidebar()} aria-label={t("openNavigation")}>
          <Menu size={20} />
        </button>}
        {agentConsoleOpen ? (
          <BackButton className="agent-console-topbar-back" onClick={closeAgentConsole} label={t("agentConsoleBack")} />
        ) : (
          <>
            <Brand compact />
            <div className="topbar-divider" />
          </>
        )}
        <div className={agentConsoleOpen ? "agent-console-projects" : "product-switcher-slot"}>
          <ProductSwitcher
            products={products}
            selectedProductId={selectedProductId}
            unreadCounts={agentConsoleOpen && products.length > 0 ? unreadCounts.byProduct : undefined}
            unreadCountsLoaded={agentSessionsQuery.data !== undefined}
            onSelect={(productId) => {
              agentConsoleMoreRef.current?.removeAttribute("open");
              // A manual pick wins over session alignment (AND-263): mark the
              // open session as aligned so the refetch loop never bounces back.
              if (agentConsoleOpen && agentSessionId) {
                agentConsoleProductAlignedRef.current = agentSessionId;
              }
              setSelectedProductId(productId);
              setAgentConsoleBulkMode(false);
              // A filter chosen for one product says nothing about the next one,
              // and the item asks for the default view "no matter what".
              setStatusFilter(DEFAULT_STATUS);
              setTypeFilter("all");
              setBuilderFilter("");
              setAdvancedFilters({});
              setSearch("");
              clearItemPage();
            }}
          />
          {agentConsoleOpen && agentSessionsQuery.data !== undefined && (
            <span
              className="agent-console-total-unread agent-unread-badge"
              aria-label={t("agentConsoleUnreadCount", { count: unreadCounts.total })}
              title={t("agentConsoleUnreadCount", { count: unreadCounts.total })}
            ><BellRing size={13} aria-hidden="true" />{unreadCounts.total}</span>
          )}
        </div>
        {products.length > 0 && !agentConsoleOpen && (
          <button
            type="button"
            className="ai-console-toggle"
            aria-pressed="false"
            aria-label={t("agentConsoleOpen")}
            onClick={openAgentConsole}
          >
            <Sparkles size={16} />
            <span>{t("agentConsoleOpen")}</span>
            {agentSessionsQuery.data !== undefined && (
              <small
                className="agent-unread-badge"
                aria-label={t("agentConsoleUnreadCount", { count: unreadCounts.total })}
                title={t("agentConsoleUnreadCount", { count: unreadCounts.total })}
              >{unreadCounts.total}</small>
            )}
          </button>
        )}
        {agentConsoleOpen && (
          <div className={`agent-console-topbar-actions ${agentConsoleBulkAvailable && !agentConversationOpen ? "has-bulk" : ""}`}>
            {agentConsoleBulkAvailable && !agentConversationOpen && (
              <button
                type="button"
                className={`secondary-button agent-console-topbar-bulk ${agentConsoleBulkMode ? "active" : ""}`}
                aria-label={t(agentConsoleBulkMode ? "agentConsoleBulkDone" : "agentConsoleBulkMode")}
                aria-pressed={agentConsoleBulkMode}
                title={t(agentConsoleBulkMode ? "agentConsoleBulkDone" : "agentConsoleBulkMode")}
                onClick={() => setAgentConsoleBulkMode((current) => !current)}
              >
                <CheckCircle2 size={17} />
              </button>
            )}
            <button
              type="button"
              className="secondary-button agent-console-topbar-refresh"
              title={t("refresh")}
              aria-label={t("refresh")}
              onClick={() => void refreshAgentConsole()}
            >
              <RefreshCw className={agentConsoleRefreshing ? "spin" : ""} size={18} />
            </button>
            {agentConsoleBulkAvailable && !agentConversationOpen && (
              <details className="agent-console-topbar-more" ref={agentConsoleMoreRef}>
                <summary className="secondary-button" aria-label={t("moreActions")} title={t("moreActions")}><MoreVertical size={18} /></summary>
                <div className="agent-console-topbar-more-menu">
                  <button type="button" onClick={() => {
                    agentConsoleMoreRef.current?.removeAttribute("open");
                    setAgentConsoleBulkMode((current) => !current);
                  }}><CheckCircle2 size={16} />{t(agentConsoleBulkMode ? "agentConsoleBulkDone" : "agentConsoleBulkMode")}</button>
                  <button type="button" onClick={() => {
                    agentConsoleMoreRef.current?.removeAttribute("open");
                    void refreshAgentConsole();
                  }}><RefreshCw size={16} />{t("refresh")}</button>
                </div>
              </details>
            )}
          </div>
        )}
        {!agentConsoleOpen && (
          <>
            <div className="header-search">
              <Search size={17} />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMobileSearchOpen(false);
                }}
                placeholder={t("searchItems")}
              />
              <kbd>{SEARCH_SHORTCUT}</kbd>
              <button className="icon-button mobile-only mobile-search-close" onClick={() => setMobileSearchOpen(false)} aria-label={t("closeSearch")}><X size={18} /></button>
            </div>
            <button className="icon-button mobile-only mobile-search-trigger" onClick={() => setMobileSearchOpen(true)} aria-label={t("searchItems")}><Search size={19} /></button>
            <button className="primary-button capture-button" disabled={!selectedProductCanCapture} title={!selectedProductCanCapture ? t("captureReadOnly") : undefined} onClick={openCapture}>
              <Plus size={18} /> <span>{t("capture")}</span>
            </button>
          </>
        )}
      {foregroundSyncing && (
          <span className="sync-indicator" role="status" aria-label={t("syncing")} title={t("syncing")}>
            <RefreshCw className="spin" size={15} aria-hidden="true" />
          </span>
        )}
      </header>
      {!isOnline && <div className="offline-banner" role="status"><WifiOff size={15} /> {t("offlineMode")}</div>}

      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "open" : ""}`} inert={sidebarIsDrawer && !sidebarOpen}>
        <div className="sidebar-mobile-head mobile-only">
          <Brand compact />
          <button className="icon-button" onClick={() => closeSidebar()} aria-label={t("closeNavigation")}><X size={20} /></button>
        </div>
        <nav aria-label={t("workspace")}>
          <p className="sidebar-label">{t("workspace")}</p>
          {ITEM_STATUS_NAV_ORDER.map((status) => {
            const Icon = STATUS_ICONS[status];
            return (
              <StatusNavItem
                key={status}
                label={statusLabel(status)}
                count={shownCount(statusCount(status))}
                active={statusFilter === status}
                onClick={() => selectStatus(status)}
              >
                <Icon size={17} />
              </StatusNavItem>
            );
          })}
          {/* "All" is last (AND-197): it is the catch-all, not the default. */}
          <StatusNavItem label={t("allItems")} count={shownCount(listedCount)} active={statusFilter === "all"} onClick={() => selectStatus("all")}>
            <ListTodo size={17} />
          </StatusNavItem>
        </nav>
        <div className="sidebar-spacer" />
        <button type="button" className="text-button add-product" onClick={openStatistics}><BarChart3 size={15}/>{t("statisticsEntry")}</button>
        {androidFeedbackBridge() && (
          <button
            className="text-button add-product"
            onClick={() => {
              closeSidebar();
              androidFeedbackBridge()?.openFeedback();
            }}
          ><MessageSquarePlus size={15} /> {t("submitFeedback")}</button>
        )}
        <button
          className="text-button add-product"
          onClick={() => {
            closeSidebar();
            setDownloadsOpen(true);
          }}
        ><Download size={15} /> {t("downloadsEntry")}</button>
        <div className="sidebar-utilities">
          <button
            className="text-button sidebar-utility-button"
            onClick={() => {
              openSettings("account");
            }}
          ><Settings size={15} /> {t("settingsEntry")}</button>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim mobile-only" onClick={() => closeSidebar()} aria-label={t("closeNavigation")} />}

      <main
        className={`workspace ${selectedItemKey ? "detail-open" : ""}`}
        ref={workspaceRef}
        inert={sidebarIsDrawer && sidebarOpen}
        style={{ "--list-pane-width": `${listPaneWidth}px` } as CSSProperties}
      >
        {/* Visibility is a layout decision: below the two-pane breakpoint the
            list gives way to the detail, above it they sit side by side. */}
        <section className="list-page">
          <nav className="mobile-status-nav mobile-only" aria-label={t("workspace")}>
            {ITEM_STATUS_NAV_ORDER.map((status) => {
              const Icon = STATUS_ICONS[status];
              return (
                <button key={status} className={statusFilter === status ? "active" : ""} aria-pressed={statusFilter === status} onClick={() => selectStatus(status)}>
                  <Icon size={16} />
                  <span>{statusLabel(status)}</span>
                  <small>{shownCount(statusCount(status))}</small>
                </button>
              );
            })}
            {/* "All" is last (AND-197): it is the catch-all, not the default. */}
            <button className={statusFilter === "all" ? "active" : ""} aria-pressed={statusFilter === "all"} onClick={() => selectStatus("all")}>
              <ListTodo size={16} />
              <span>{t("allItems")}</span>
              <small>{shownCount(listedCount)}</small>
            </button>
          </nav>
          <section className="workspace-head">
            <div>
              <p className="eyebrow">{t("productWorkspace", { prefix: selectedProduct?.keyPrefix ?? "" })}</p>
              <h1>{statusFilter === "all" ? t("allWork") : statusLabel(statusFilter)}</h1>
            </div>
            <div className="workspace-head-side">
              <div className="workspace-stats" aria-label={t("workspaceSummary")}>
                <span><strong>{shownCount(openCount)}</strong> {t("open")}</span>
                <span><strong>{shownCount(verifyCount)}</strong> {t("toVerify")}</span>
              </div>
              {/* Nothing pushes changes to the console: items the SDK or an AI
                  creates elsewhere only show up on a refetch, so give people
                  one they can ask for. Counts come from the same query. */}
              {selectedProduct && <StatusCheckButton productId={selectedProduct.id} canOperate={selectedProduct.access?.canOperate ?? true} />}
              <RefreshButton
                refreshing={itemsQuery.isFetching}
                onRefresh={() => queryClient.invalidateQueries({ queryKey: ["items"] })}
              />
            </div>
          </section>

          <ListFilters
            key={selectedProductId}
            productId={selectedProductId}
            value={{ ...advancedFilters, builder: builderFilter, types: advancedFilters.types ?? (typeFilter === "all" ? [] : [typeFilter]) }}
            search={search}
            builders={buildersQuery.data?.builders ?? []}
            buildersFailed={buildersQuery.isError}
            onChange={({builder, types = [], ...rest}) => {
              setBuilderFilter(builder);
              setTypeFilter(types.length === 1 ? types[0]! : "all");
              setAdvancedFilters({ ...rest, ...(types.length > 1 ? {types} : {}) });
            }}
            onClearSearch={() => setSearch("")}
            onClear={clearFilters}
          />

          {selectedItemKeys.size > 0
            && (selectionStatus === "pending_verification" || selectionStatus === "in_progress" || selectedProductCanUseAi) && (
            <div className="bulk-bar" role="status">
              {selectionStatus === "pending_verification"
                ? <ClipboardCheck size={15} aria-hidden="true" />
                : selectionStatus === "in_progress"
                  ? <Undo2 size={15} aria-hidden="true" />
                  : <Rocket size={15} aria-hidden="true" />}
              <span className="bulk-bar-count">{t("selectedForDispatch", { count: selectedItemKeys.size })}</span>
              <button type="button" className="text-button bulk-bar-clear" onClick={() => setSelectedItemKeys(new Set())}>
                {t("clearSelection")}
              </button>
              {selectionStatus === "pending_verification" ? (
                <button
                  type="button"
                  className="primary-button positive"
                  onClick={() => setVerifyBatch(selectedItems.filter((item) => item.status === "pending_verification"))}
                >
                  <CheckCircle2 size={16} /> {t("verifySelected", { count: selectedItems.length })}
                </button>
              ) : selectionStatus === "in_progress" ? (
                // A wrong or stale dispatch is undone on many items at once
                // (AND-160); the domain's note travels with the whole batch.
                <button
                  type="button"
                  className="primary-button"
                  disabled={selectedItems.length === 0}
                  onClick={() => setReleaseBatch(selectedItems.filter((item) => item.status === "in_progress"))}
                >
                  <Undo2 size={16} /> {t("releaseSelected", { count: selectedItems.length })}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  disabled={selectedItems.length === 0}
                  onClick={() => setDispatchBatch(selectedItems)}
                >
                  <Rocket size={16} /> {t("dispatchSelected")}
                </button>
              )}
            </div>
          )}

          <section className={`list-surface ${showAttachmentColumn ? "with-media" : "without-media"}`} aria-label={t("workItems")}>
            <div className="list-columns" aria-hidden="true">
              <span>{t("itemInformation")}</span>
              {showAttachmentColumn && <span>{t("attachments")}</span>}
              <span>{t("capturedContext")}</span>
              <span>{t("status")}</span>
              <span>{t("creatorAndUpdated")}</span>
              <span />
            </div>
            <div className="item-list">
              {itemsQuery.isLoading && <ListSkeleton />}
              {itemsQuery.isError && <InlineError message={errorMessage(itemsQuery.error, t("somethingWentWrong"))} />}
              {!itemsQuery.isLoading && visibleItems.length === 0 && (
                <div className="empty-list">
                  <div className="round-icon"><Lightbulb size={22} /></div>
                  <h2>{!listFiltersActive && (itemSummary?.productTotal ?? 0) === 0 ? t("captureFirstSpark") : t("noMatchingItems")}</h2>
                  <p>{!selectedProductCanCapture ? t("captureReadOnly") : !listFiltersActive && (itemSummary?.productTotal ?? 0) === 0 ? t("firstSparkHelp") : t("noMatchHelp")}</p>
                  {listFiltersActive && <button className="secondary-button" onClick={clearFilters}>{t("clearListFilters")}</button>}
                  {!listFiltersActive && (itemSummary?.productTotal ?? 0) === 0 && <button className="primary-button" disabled={!selectedProductCanCapture} onClick={openCapture}><Plus size={17} /> {t("captureItem")}</button>}
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  canOperate={selectedProductCanCapture}
                  selected={item.key === selectedItemKey}
                  checked={selectedItemKeys.has(item.key)}
                  selectionVisible={item.status === "pending_verification"
                    || item.status === "in_progress"
                    || (selectedProductCanUseAi && isDispatchable(item.status))}
                  selectable={selectedItemKeys.has(item.key) || canJoinSelection(item.status, selectionStatus)}
                  dispatchSummary={latestDispatches.get(item.key)}
                  sessionFailure={sessionFailures.get(item.key)}
                  handlerSummary={inProgressHandlers.get(item.key)}
                  onToggleChecked={() => setSelectedItemKeys((current) => toggleItemSelection(current, item, selectionStatus))}
                  sourceComponent={item.sourceComponentId ? componentsById.get(item.sourceComponentId) : undefined}
                  showAttachmentColumn={showAttachmentColumn}
                  onOpen={() => openItemPage(item.key)}
                  onEdit={() => openItemPage(item.key, true)}
                  onNotice={setNotice}
                  onStartWork={setStartWorkItem}
                />
              ))}
              {(items.length > 0 || itemsQuery.hasNextPage) && (
                <div className="list-pagination">
                  <span>{t("loadedItems", { loaded: items.length, total: itemSummary?.total ?? items.length })}</span>
                  {itemsQuery.hasNextPage && (
                    <button className="secondary-button" disabled={itemsQuery.isFetchingNextPage} onClick={() => void itemsQuery.fetchNextPage()}>
                      {itemsQuery.isFetchingNextPage ? <LoaderCircle className="spin" size={16} /> : <ChevronDown size={16} />}
                      {itemsQuery.isFetchingNextPage ? t("loadingMore") : t("loadMore")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </section>

        {selectedItemKey && (
          <PaneSplitter width={listPaneWidth} onWidth={applyListPaneWidth} />
        )}

        {selectedItemKey && (
          <div className="detail-page-shell">
            <DetailPane itemKey={selectedItemKey} openInEdit={detailOpenInEdit} onClose={closeItemPage} onItemLoaded={selectItemProduct} onNotice={setNotice} onOpenItem={openItemPage} onStartWork={setStartWorkItem} onTakeOver={(item) => setDispatchBatch([item])} sessionFailure={sessionFailures.get(selectedItemKey)} onOpenConsoleSession={openAgentSession} />
          </div>
        )}
      </main>

      {agentConsoleOpen && selectedProductId && (
        <AgentSessionConsole
          productId={selectedProductId}
          initialFilter={agentConsoleLinkedFilter}
          allSessions={allAgentSessions}
          sessionsLoaded={agentSessionsQuery.data !== undefined}
          sessionsError={agentSessionsQuery.error}
          selectedSessionId={agentSessionId}
          conversationOpen={agentConversationOpen}
          bulkMode={agentConsoleBulkMode}
          onBulkModeChange={setAgentConsoleBulkMode}
          onBulkAvailabilityChange={setAgentConsoleBulkAvailable}
          onSelectSession={selectAgentSession}
          onBackToSessions={closeAgentConversation}
        />
      )}

      {!agentConsoleOpen && !selectedItemKey && <button className="mobile-fab mobile-only" disabled={!selectedProductCanCapture} title={!selectedProductCanCapture ? t("captureReadOnly") : undefined} onClick={openCapture} aria-label={t("captureNewItem")}><Plus size={24} /></button>}

      {captureOpen && selectedProduct && (
        <Modal historyManaged title={t("captureWork")} subtitle={t("addToProduct", { product: selectedProduct.name })} onClose={closeCapture}>
          <CaptureForm
            product={selectedProduct}
            onCreated={(item, failedUploads) => {
              setCaptureOpen(false);
              clearItemPage();
              restoreListScroll();
              setNotice(
                failedUploads > 0
                  ? t("uploadPartial", { key: item.key, count: failedUploads })
                  : t(item.status === "ready" ? "submittedForProcessing" : "capturedInInbox", { key: item.key }),
              );
              void queryClient.invalidateQueries({ queryKey: ["items", selectedProduct.id] });
            }}
          />
        </Modal>
      )}
      {startWorkItem && (
        <Modal
          title={t("startWorkTitle")}
          subtitle={t("startWorkSubtitle", { key: startWorkItem.key })}
          onClose={() => setStartWorkItem(null)}
        >
          <StartWorkDialog
            item={startWorkItem}
            product={products.find((product) => product.id === startWorkItem.productId)}
            onClose={() => setStartWorkItem(null)}
            onClaimed={(updated) => {
              setStartWorkItem(null);
              setNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
              void queryClient.invalidateQueries({ queryKey: ["items"] });
              void queryClient.invalidateQueries({ queryKey: ["item", updated.key] });
              void queryClient.invalidateQueries({ queryKey: ["timeline", updated.key] });
            }}
            onDispatch={() => {
              setDispatchBatch([startWorkItem]);
              setStartWorkItem(null);
            }}
            onOpenAgents={() => {
              setStartWorkItem(null);
              openSettings("agents");
            }}
          />
        </Modal>
      )}
      {releaseBatch && (
        <Modal
          title={t("releaseSelectedTitle")}
          subtitle={t("releaseSelectedSubtitle", { count: releaseBatch.length })}
          onClose={() => setReleaseBatch(null)}
        >
          <BulkReleaseDialog
            items={releaseBatch}
            onClose={() => setReleaseBatch(null)}
            onDone={(results) => {
              setReleaseBatch(null);
              const failed = results.filter((result) => !result.ok);
              setSelectedItemKeys(new Set(failed.map((result) => result.itemKey)));
              setNotice(failed.length === 0
                ? t("releasedAll", { count: results.length })
                : t("releasedSome", {
                  ok: results.length - failed.length,
                  failed: failed.length,
                  keys: failed.map((result) => result.itemKey).join("、"),
                }));
              void queryClient.invalidateQueries({ queryKey: ["items"] });
              for (const result of results) {
                void queryClient.invalidateQueries({ queryKey: ["item", result.itemKey] });
                void queryClient.invalidateQueries({ queryKey: ["timeline", result.itemKey] });
              }
            }}
          />
        </Modal>
      )}
      {verifyBatch && (
        <Modal
          title={t("verifySelectedTitle")}
          subtitle={t("verifySelectedSubtitle", { count: verifyBatch.length })}
          onClose={() => setVerifyBatch(null)}
        >
          <BulkVerifyDialog
            items={verifyBatch}
            onClose={() => setVerifyBatch(null)}
            onDone={(results) => {
              setVerifyBatch(null);
              const failed = results.filter((result) => !result.ok);
              // Keep what did not close ticked, so it can be looked at or retried.
              setSelectedItemKeys(new Set(failed.map((result) => result.itemKey)));
              setNotice(failed.length === 0
                ? t("verifiedAll", { count: results.length })
                : t("verifiedSome", {
                  ok: results.length - failed.length,
                  failed: failed.length,
                  keys: failed.map((result) => result.itemKey).join("、"),
                }));
              void queryClient.invalidateQueries({ queryKey: ["items"] });
              for (const result of results) {
                void queryClient.invalidateQueries({ queryKey: ["item", result.itemKey] });
                void queryClient.invalidateQueries({ queryKey: ["timeline", result.itemKey] });
              }
            }}
          />
        </Modal>
      )}
      {dispatchBatch && dispatchBatch.every((item) => productAllowsAi(products.find((product) => product.id === item.productId))) && (
        <Modal
          title={t("dispatchTitle")}
          subtitle={t("dispatchSubtitle", { count: dispatchBatch.length })}
          onClose={() => setDispatchBatch(null)}
        >
          <DispatchDialog
            items={dispatchBatch}
            products={products}
            onClose={() => setDispatchBatch(null)}
            onDispatched={(dispatch: Dispatch) => {
              setSelectedItemKeys(new Set());
              setNotice(t("dispatchSent", { node: dispatch.nodeName }));
              void queryClient.invalidateQueries({ queryKey: ["items"] });
              void queryClient.invalidateQueries({ queryKey: ACTIVE_DISPATCHES_QUERY_KEY });
              // The dispatch wrote a `dispatched` event on every item in the
              // batch, so an open detail pane is already out of date.
              for (const itemKey of dispatch.itemKeys) {
                void queryClient.invalidateQueries({ queryKey: ["timeline", itemKey] });
                void queryClient.invalidateQueries({ queryKey: ["dispatches", itemKey] });
              }
            }}
          />
        </Modal>
      )}
      {downloadsOpen && (
        <Modal title={t("downloadsTitle")} subtitle={t("downloadsSubtitle")} onClose={() => setDownloadsOpen(false)}>
          <DownloadsPanel />
        </Modal>
      )}
      {notice && <div className="toast" role="status"><Check size={16} /> {notice}<button onClick={() => setNotice(null)} aria-label={t("dismiss")}><X size={14} /></button></div>}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark"><Rocket size={18} strokeWidth={2.4} /></span>
      <span className="brand-name">Mission<span>Go</span></span>
      {!compact && <span className="brand-tagline">From idea to shipped.</span>}
    </div>
  );
}

function StatusNavItem({ children, label, count, active, onClick }: { children: ReactNode; label: string; count: number | string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{children}<span>{label}</span><small>{count}</small></button>;
}

function ItemRow({
  item,
  canOperate,
  sourceComponent,
  showAttachmentColumn,
  selected,
  checked,
  selectionVisible,
  selectable,
  dispatchSummary,
  sessionFailure,
  handlerSummary,
  onToggleChecked,
  onOpen,
  onEdit,
  onNotice,
  onStartWork,
}: {
  item: WorkItem;
  canOperate: boolean;
  sourceComponent: Component | undefined;
  showAttachmentColumn: boolean;
  selected: boolean;
  checked: boolean;
  /** Whether this row participates in a batch action available to this account. */
  selectionVisible: boolean;
  /** Whether the checkbox can be used: the row can join, or leave, the current selection. */
  selectable: boolean;
  /** The latest dispatch attempt for this ready cycle, if there is one. */
  dispatchSummary: ItemDispatchSummary | undefined;
  /** The error from the session behind that dispatch, when it died before claiming (AND-180). */
  sessionFailure: string | null | undefined;
  /** The agent behind the item's in-progress claim, when it came from a dispatch. */
  handlerSummary: ItemDispatchHandler | undefined;
  onToggleChecked: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onNotice: (message: string) => void;
  onStartWork: (item: WorkItem) => void;
}) {
  const { actorLabel, formatTime, locale, priorityLabel, statusLabel, t, typeLabel } = useI18n();
  const TypeIcon = TYPE_ICONS[item.type];
  const environment = item.environment;
  const overview = item.report?.overview ?? item.description;
  // An attached log file and a structured log entry are not the same unit, and showing their sum
  // made a whole attached history look like one more line.
  const logFileCount = Math.max(
    item.attachments.filter((attachment) => attachment.kind === "log").length,
    item.diagnosticSummary?.logFileCount ?? 0,
  );
  const logCount = item.diagnosticSummary?.logCount ?? 0;
  const contextPrimary = sourceComponent?.name ?? (environment ? platformName(environment.platform, t) : t("notSpecified"));
  const contextDetails = environmentSummary(environment, Boolean(sourceComponent), t);
  const creator = creatorLabel(item.createdBy, { human: actorLabel("human"), sdk: t("creatorSdk"), agent: actorLabel("agent") });
  // The list answers "who is moving this", and the client alone answers it.
  const shortCreator = creatorShort(creator);
  const handlerAgentKey = handlerSummary ? agentLabelKey(handlerSummary.agentKind) : null;
  // Where the work went stays on the row whatever status the item has now
  // (AND-216), so a finished item still names the agent that did it. An
  // in-progress item keeps its handler instead: the claim is what says an agent
  // is on it now, and a person who took over an unclaimed launch must not read
  // as that agent (AND-163).
  const handlerBadge = item.status === "in_progress" && handlerSummary ? handlerSummary : undefined;
  const latestDispatch = handlerBadge ? undefined : dispatchSummary;
  const dispatchAgentKey = latestDispatch ? agentLabelKey(latestDispatch.agentKind) : null;
  const pendingDispatchStatusKey = latestDispatch ? activeDispatchStatusKey(latestDispatch.status) : null;
  // A launch that later fell over still carries `launched`, so the row calls it
  // a failure when the session behind it did (AND-180).
  const sessionFailed = sessionFailure !== undefined;
  const dispatchFailed = latestDispatch !== undefined
    && (latestDispatch.status === "failed" || sessionFailed);
  return (
    <article
      className={`item-row ${selected ? "selected" : ""} ${selectionVisible ? "has-select" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        const target = event.target;
        // Form options can be portalled into a native dialog inside this row
        // or outside its DOM. Neither should open the detail pane.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest("button, a, input, label, select, textarea, summary, details, video, dialog, [role='dialog']")) return;
        onOpen();
      }}
    >
      <span className="item-row-lead">
        {/* Dispatching is a batch action, so the pick has to happen in the list.
            The click guard on the row above already exempts inputs, which is what
            keeps ticking a box from opening the detail pane. */}
        {/* The label is the finger-sized target: the box stays 20px to look at,
            and a pseudo-element spreads the hit area to 44px around it without
            taking part in the layout. It is in the guard's list too, so tapping
            its padding ticks rather than opens. */}
        {selectionVisible && (
          <label className="item-select-hit">
            <input
              type="checkbox"
              className="item-select"
              checked={checked}
              disabled={!selectable}
              aria-label={t("selectForBatch", { key: item.key })}
              title={selectable ? undefined : t("onlySameStatusSelectable")}
              onChange={onToggleChecked}
            />
          </label>
        )}
        <button className="item-row-main" onClick={onOpen} aria-label={t("openItem", { key: item.key })}>
          <span className="item-copy">
            {/* The icon is a flex item of this line, not a sibling column beside
                it, so it centres on the key's own line even when a badge wraps to
                a second one -- and the key can never be separated from its icon.
                A nested title line allowed both. */}
            <span className="item-meta">
              <span className={`type-icon type-${item.type}`} role="img" aria-label={typeLabel(item.type)}><TypeIcon size={16} /></span>
              <code>{item.key}</code>
              <BuilderBadge name={item.builderName} needsReassignment={item.builderNeedsReassignment} />
              {/* First of the badges, so the one that names the machine and
                  agent keeps its width when the line runs out. A failure calls
                  out that the item needs attention; a hand-off just says where
                  the work went (AND-216). */}
              {handlerBadge ? (
                <small
                  className="item-handler-badge"
                  title={t("itemHandlerBadgeTitle", {
                    agent: handlerAgentKey ? t(handlerAgentKey) : handlerBadge.agentKind,
                    node: handlerBadge.nodeName,
                    time: formatTime(handlerBadge.createdAt),
                    at: new Date(handlerBadge.createdAt).toLocaleString(locale, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                >
                  {t("itemHandlerBadge", {
                    agent: handlerAgentKey ? t(handlerAgentKey) : handlerBadge.agentKind,
                    node: handlerBadge.nodeName,
                  })}
                </small>
              ) : latestDispatch ? (
                <small
                  className={dispatchFailed ? "item-dispatch-badge" : "item-handler-badge"}
                  title={t(
                    dispatchFailed
                      ? sessionFailed && sessionFailure
                        ? "dispatchSessionFailedTitle"
                        : "failedDispatchBadgeTitle"
                      : "itemDispatchBadgeTitle",
                    {
                      agent: dispatchAgentKey ? t(dispatchAgentKey) : latestDispatch.agentKind,
                      node: latestDispatch.nodeName,
                      status: pendingDispatchStatusKey ? t(pendingDispatchStatusKey) : latestDispatch.status,
                      time: formatTime(latestDispatch.createdAt),
                      at: new Date(latestDispatch.createdAt).toLocaleString(locale, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                      reason: sessionFailure ?? "",
                    },
                  )}
                >
                  {dispatchFailed
                    ? t("failedDispatchBadge")
                    : t("itemDispatchBadge", {
                        agent: dispatchAgentKey ? t(dispatchAgentKey) : latestDispatch.agentKind,
                        node: latestDispatch.nodeName,
                      })}
                </small>
              ) : null}
              {item.derivedFrom && <small className="item-derived-badge" title={item.derivedFrom.title}>{t("derivedFromBadge", { key: item.derivedFrom.key })}</small>}
              {item.verificationReturn && <VerificationReturnBadge />}
              <span className="item-evidence-summary">
                {item.type === "bug" && item.report?.reproductionSteps && <small className="evidence-strong">{t("hasReproduction")}</small>}
                {logCount > 0 && <small>{t("logCount", { count: logCount })}</small>}
                {logFileCount > 0 && <small className="evidence-strong">{t("logFileCount", { count: logFileCount })}</small>}
                {(item.diagnosticSummary?.contextEntryCount ?? 0) > 0 && <small>{t("contextCount", { count: item.diagnosticSummary.contextEntryCount })}</small>}
              </span>
            </span>
            {/* Out of the meta line, so the title gets the whole column on a
                phone instead of losing the key's width and its gap. See AND-32. */}
            <span className="item-title">{item.title}</span>
            {item.verificationReturn
              ? <VerificationReturnSummary info={item.verificationReturn} />
              : <span className={`item-description ${overview ? "" : "muted"}`}>{overview || t("noDescription")}</span>}
          </span>
        </button>
      </span>
      <ItemMediaStrip itemKey={item.key} attachments={item.attachments} preserveColumn={showAttachmentColumn} />
      <span className="item-context">
        <strong className={environment ? "item-context-primary-with-platform" : undefined}>{contextPrimary}</strong>
        {environment && <strong className="item-context-platform">{platformName(environment.platform, t)}</strong>}
        {/* No placeholder when there is nothing to say: on a phone this row is
            one line shared with the platform, and "no version or device
            details" was taking enough of it to truncate "Android" to "Andr...".
            A line that only reports an absence is not worth that. See AND-32. */}
        {contextDetails && <small>{contextDetails}</small>}
        {/* Only drawn in the compact layouts, which hide the creator column. */}
        {creator && <small className="item-context-creator">{creator}</small>}
      </span>
      {/* One line at the foot of the card: where it came from and when, then how
          it stands. The wrapper is `display: contents` above the compact shell so
          the two halves keep their own grid columns there; on a phone it is a
          flex line with the divider in its border. */}
      <span className="item-footer">
        {/* Nothing in the trace shrinks. A byline cut to `AI · OpenCo…` names
            nobody, and a time cut to `3 小时…` says nothing at all -- so when the
            line cannot fit, the footer wraps and the state cluster drops to its
            own line instead. That costs one line on the rare long byline and
            mangles none. */}
        <span className="item-trace">
          <strong>{contextPrimary}</strong>
          {shortCreator && <i className="sep">·</i>}
          {shortCreator && <span className="item-creator" title={creator}>{shortCreator}</span>}
          {item.createdBy?.kind === "agent" && item.createdBy.name && <small className="item-assisted-source">{t("aiAssistedSubmission")}</small>}
          <i className="sep">·</i>
          <span className="item-stamp">{formatTime(item.updatedAt)}</span>
        </span>
        <span className="item-state">
          <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
          <small><i className={`priority-dot priority-${item.priority}`} /> {priorityLabel(item.priority)}</small>
        </span>
      </span>
      <span className="item-updated">
        {creator && <span className="item-creator" title={creator}>{creator}</span>}
        <span>{formatTime(item.updatedAt)}</span>
      </span>
      <span className="item-row-actions">
        {canOperate && <ItemRowActions item={item} onEdit={onEdit} onNotice={onNotice} onStartWork={onStartWork} />}
      </span>
    </article>
  );
}
/** Product metadata uses the same combobox interaction and popup as forms. */
function ProductSwitcher({
  products, selectedProductId, unreadCounts, unreadCountsLoaded, onSelect,
}: {
  products: readonly Product[];
  selectedProductId: string;
  unreadCounts: ReadonlyMap<string, number> | undefined;
  unreadCountsLoaded: boolean;
  onSelect: (productId: string) => void;
}) {
  const { t } = useI18n();
  const content = (id: string, expanded: boolean) => {
    const product = products.find(entry => entry.id === id);
    if (!product) return null;
    return <>
      <ProductBadge product={product} />
      {expanded
        ? <span className="product-switcher-option"><strong>{product.name}</strong><small>{product.keyPrefix}</small></span>
        : <span className="product-switcher-name">{product.name}</span>}
      {unreadCounts && unreadCountsLoaded && <small className="agent-unread-badge"
        aria-label={t("agentConsoleUnreadCount", { count: unreadCounts.get(id) ?? 0 })}>
        {unreadCounts.get(id) ?? 0}
      </small>}
    </>;
  };
  if (!products.length) return null;
  return <div className="product-switcher-wrap">
    <Select className="product-switcher" aria-label={t("selectedProduct")}
      value={selectedProductId} onChange={event => onSelect(event.target.value)}
      renderValue={id => content(id, false)} renderOption={id => content(id, true)}>
      {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
    </Select>
  </div>;
}

/** Below this the workspace shows one pane at a time, and so should the manager. */
function useSinglePaneLayout(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}

/**
 * The drag handle between the list and the detail.
 *
 * Hand-rolled rather than pulled in: the app has no layout library, and the
 * whole interaction is a pointer capture plus one subtraction. Keyboard and
 * double-click-to-reset are here because a separator that only responds to a
 * precise 6px drag is not reachable for everyone.
 */
function PaneSplitter({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const { t } = useI18n();
  const dragRef = useRef<{ readonly startX: number; readonly startWidth: number } | null>(null);

  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    onWidth(drag.startWidth + (event.clientX - drag.startX));
  };

  return (
    <div
      className={`pane-splitter ${dragRef.current ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resizeListPane")}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(event) => {
        dragRef.current = { startX: event.clientX, startWidth: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={track}
      onPointerUp={(event) => {
        track(event);
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragRef.current = null; }}
      onDoubleClick={() => onWidth(DEFAULT_LIST_PANE_WIDTH)}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
        if (step === 0) return;
        event.preventDefault();
        onWidth(width + step);
      }}
    />
  );
}

function ItemMediaStrip({
  itemKey,
  attachments,
  preserveColumn,
}: {
  itemKey: string;
  attachments: readonly WorkItemAttachment[];
  preserveColumn: boolean;
}) {
  const { t } = useI18n();
  const mediaAttachments = attachments.filter(
    (attachment): attachment is WorkItemAttachment & { readonly kind: "image" | "video" } => isMediaAttachment(attachment),
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Three thumbnails, then a count on the last rather than shrinking every
  // tile. This used to be two on a wide viewport and three on a phone, but the
  // card row is now chosen by the pane's width, which no JS media query can
  // see -- so render three and let the strip clip what will not fit.
  const visible = mediaAttachments.slice(0, 3);
  if (visible.length === 0) return preserveColumn ? <div className="item-media-strip empty-slot" aria-hidden="true" /> : null;
  return (
    <>
      <div className="item-media-strip" aria-label={t("mediaCount", { count: mediaAttachments.length })}>
        {visible.map((attachment, index) => (
          <ItemMediaThumbnail
            key={attachment.id}
            itemKey={itemKey}
            attachment={attachment}
            overflowCount={index === visible.length - 1 ? mediaAttachments.length - visible.length : 0}
            onOpen={() => setActiveIndex(index)}
          />
        ))}
      </div>
      {activeIndex !== null && <ItemMediaGallery itemKey={itemKey} attachments={mediaAttachments} activeIndex={activeIndex} onIndexChange={setActiveIndex} onClose={() => setActiveIndex(null)} />}
    </>
  );
}
/** Holds a blob URL for the life of the blob and revokes it on the way out. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return undefined;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

function ItemMediaThumbnail({
  itemKey,
  attachment,
  overflowCount,
  onOpen,
}: {
  itemKey: string;
  attachment: WorkItemAttachment & { readonly kind: "image" | "video" };
  overflowCount: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [thumbnailRef, isNearViewport] = useNearViewport<HTMLButtonElement>("80px");
  // Two separate fetches on purpose. The tile needs a few kilobytes and is
  // fetched as soon as the row nears the viewport; the original is worth
  // megabytes and is only worth fetching once someone actually opens it.
  const thumbnailQuery = useQuery({
    queryKey: ["attachment-thumbnail", itemKey, attachment.id, attachment.revision, LIST_THUMBNAIL_EDGE],
    queryFn: () => api.downloadAttachmentThumbnail(itemKey, attachment.id, LIST_THUMBNAIL_EDGE, attachment.revision),
    enabled: attachment.kind === "image" && isNearViewport,
    staleTime: Infinity,
  });
  const thumbnailUrl = useObjectUrl(thumbnailQuery.data);

  const Icon = attachment.kind === "video" ? Video : ImageIcon;
  return (
    <div className="item-media-thumb-wrap">
      <button
        ref={thumbnailRef}
        className={`item-media-thumb media-${attachment.kind}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        title={attachment.filename}
        aria-label={t("previewAttachment", { filename: attachment.filename })}
      >
        {attachment.kind === "image" && thumbnailUrl && <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />}
        {!thumbnailUrl && <span className="media-file-tile">{thumbnailQuery.isLoading ? <LoaderCircle className="spin" size={18} /> : <Icon size={18} />}<small>{attachment.filename.split(".").pop()?.toUpperCase()}</small></span>}
        {overflowCount > 0 && <span className="media-overflow">+{overflowCount}</span>}
      </button>
    </div>
  );
}

type MediaAttachment = WorkItemAttachment & { readonly kind: "image" | "video" };

function ItemMediaGallery({ itemKey, attachments, activeIndex, onIndexChange, onClose }: {
  itemKey: string;
  attachments: readonly MediaAttachment[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const active = attachments[activeIndex];
  if (!active) return null;
  return (
    <MediaLightbox
      title={`${mediaNumberLabel(active.kind, active.displayNumber, t)} · ${active.filename} (${activeIndex + 1}/${attachments.length})`}
      onClose={onClose}
      onPrevious={activeIndex > 0 ? () => onIndexChange(activeIndex - 1) : undefined}
      onNext={activeIndex < attachments.length - 1 ? () => onIndexChange(activeIndex + 1) : undefined}
      showNavigation={attachments.length > 1}
    >
      <ActiveMediaPreview key={active.id} itemKey={itemKey} attachment={active} />
    </MediaLightbox>
  );
}

function ActiveMediaPreview({ itemKey, attachment }: { itemKey: string; attachment: MediaAttachment }) {
  const { t } = useI18n();
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id, attachment.revision, attachment.kind === "image" ? "drawable" : "original"],
    queryFn: () => attachment.kind === "image"
      ? api.downloadAttachmentPreview(itemKey, attachment.id, attachment.revision)
      : api.downloadAttachment(itemKey, attachment.id),
    staleTime: Infinity,
  });
  const objectUrl = useObjectUrl(contentQuery.data);
  return (
    <>
      {contentQuery.isLoading && <div className="media-viewer-loading"><LoaderCircle className="spin" size={22} /> {t("attachmentLoading")}</div>}
      {contentQuery.isError && <div className="media-viewer-loading attachment-error">{t("attachmentFailed")}</div>}
      {attachment.kind === "image" && objectUrl && <img src={objectUrl} alt={attachment.filename} />}
      {attachment.kind === "video" && objectUrl && <PlayableVideo src={objectUrl} autoPlay />}
    </>
  );
}

function TransferItemDialog({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const productsQuery = useQuery({ queryKey: ["products"], queryFn: () => api.listProducts() });
  const products = (productsQuery.data ?? []).filter((p) => p.id !== item.productId && !p.archivedAt && p.access?.canOperate);
  const source = productsQuery.data?.find((p) => p.id === item.productId);
  const [targetId, setTargetId] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const target = products.find((p) => p.id === targetId);
  const mutation = useMutation({
    mutationFn: () => api.transferItem(item.key, targetId, requestId),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ["items"] });
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("product", updated.productId);
      url.searchParams.set("item", updated.key);
      window.location.assign(url.toString());
    },
  });
  return <Modal title={t("transferItem")} subtitle={item.key} onClose={mutation.isPending ? () => {} : onClose}>
    <div className="transfer-form">
      {confirming && target ? <>
        <h3>{t("transferConfirm", { key: item.key, project: target.name })}</h3>
        <p>{t("transferConfirmHelp")}</p>
      </> : <>
        <p>{t("transferHelp")}</p>
        <label htmlFor="transfer-target">{t("transferTarget")}</label>
        <Select id="transfer-target" value={targetId} disabled={productsQuery.isLoading || mutation.isPending}
          onChange={(event) => { setTargetId(event.target.value); setRequestId(crypto.randomUUID()); mutation.reset(); }}>
          <option value="">{t("transferChoose")}</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {productsQuery.isSuccess && !products.length && <p role="status">{t("transferNoTargets")}</p>}
      </>}
      {productsQuery.isError && <InlineError message={localizedErrorText(productsQuery.error, t)} />}
      {mutation.isError && <InlineError message={localizedErrorText(mutation.error, t)} />}
      <div className="transfer-actions">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => { if (confirming) setConfirming(false); else onClose(); }}>{confirming ? t("transferBack") : t("cancel")}</button>
        <button type="button" className="primary-button" disabled={!target || !source?.access?.canOperate || mutation.isPending}
          onClick={() => { if (confirming) mutation.mutate(); else setConfirming(true); }}>
          {mutation.isPending ? t("transferBusy") : confirming ? t("transferItem") : t("transferNext")}
        </button>
      </div>
    </div>
  </Modal>;
}

function ItemRowActions({ item, onEdit, onNotice, onStartWork }: {
  item: WorkItem;
  onEdit: () => void;
  onNotice: (message: string) => void;
  onStartWork: (item: WorkItem) => void;
}) {
  const queryClient = useQueryClient();
  const { statusLabel, t, transitionLabel } = useI18n();
  const actions = item.transferred ? [] : TRANSITIONS[item.status];
  const primaryAction = actions[0];
  const PrimaryActionIcon = primaryAction ? STATUS_ICONS[primaryAction.to] : CircleDot;
  // Destructive last, whatever order the table lists them in.
  const secondaryActions = actions.slice(1).filter((action) => action.tone !== "danger");
  const destructiveActions = actions.slice(1).filter((action) => action.tone === "danger");
  const manualTargets = item.transferred ? [] : manualMoves(item.status);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);
  const [transferring, setTransferring] = useState(false);
  const [noteAction, setNoteAction] = useState<TransitionAction | null>(null);
  const mutation = useMutation({
    mutationFn: ({ action, note }: { action: TransitionAction; note?: string }) =>
      api.transitionItem(item.key, action, note),
    onSuccess: async (updated) => {
      setNoteAction(null);
      await applyConfirmedItemTransition(queryClient, updated);
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
    onError: (error) => onNotice(errorMessage(error, t("somethingWentWrong"))),
  });

  // Whether this move needs a reason is the domain's call, not a second table
  // kept in the browser.
  const startTransition = (action: TransitionAction) => {
    // Picking up waiting work asks how first: by hand, or through an AI (AND-68).
    if (isStartWork(item.status, action)) onStartWork(item);
    else if (transitionRequiresNote(item.status, action.to)) setNoteAction(action);
    else mutation.mutate({ action });
  };

  useEffect(() => {
    const closeMoreActions = (event: MouseEvent) => {
      if (!moreActionsRef.current?.contains(event.target as Node)) moreActionsRef.current?.removeAttribute("open");
    };
    const closeMoreActionsOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") moreActionsRef.current?.removeAttribute("open");
    };
    document.addEventListener("mousedown", closeMoreActions);
    document.addEventListener("keydown", closeMoreActionsOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMoreActions);
      document.removeEventListener("keydown", closeMoreActionsOnEscape);
    };
  }, []);

  if (item.transferred) return null;

  return (
    <>
    <details className="detail-more-menu row-more-menu" ref={moreActionsRef} onToggle={(event) => {
      const menu = event.currentTarget;
      if (!menu.open) {
        menu.querySelector(".detail-move-menu")?.removeAttribute("open");
        return;
      }
      const trigger = menu.querySelector("summary")!.getBoundingClientRect();
      const below = window.innerHeight - trigger.bottom - 16;
      const above = trigger.top - 16;
      const openAbove = below < 320 && above > below;
      menu.dataset.side = openAbove ? "above" : "below";
      menu.style.setProperty("--row-menu-height", `${Math.max(100, openAbove ? above : below)}px`);
    }}>
      <summary className="secondary-button" aria-label={t("moreActionsFor", { key: item.key })} title={t("moreActions")}>
        {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <MoreVertical size={16} />}
      </summary>
      <div className="detail-more-menu-popover detail-actions-popover">
        <div className="detail-action-group">
          <p className="detail-action-heading">{t("actionGroupCollaboration")}</p>
          <button type="button" disabled={mutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); setTransferring(true); }}><ArrowRight size={17} aria-hidden="true" />{t("transferItem")}</button>
        </div>
        <div className="detail-action-group">
          <p className="detail-action-heading">{t("actionGroupStatus")}</p>
          {primaryAction && <button
            type="button"
            className={`menu-primary ${primaryAction.tone === "positive" ? "positive" : ""}`}
            disabled={mutation.isPending}
            onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(primaryAction); }}
          >
            <PrimaryActionIcon size={17} aria-hidden="true" />{quickActionLabel(item.status, t)}
          </button>}
          {secondaryActions.map((action) => <button
            key={`${action.to}-${action.reason}`}
            type="button"
            disabled={mutation.isPending}
            onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}
          >
            {action.to === "on_hold" ? <CirclePause size={17} aria-hidden="true" /> : <Undo2 size={17} aria-hidden="true" />}{transitionLabel(action.label)}
          </button>)}
          {manualTargets.length > 0 && <details className="detail-move-menu">
            <summary><ArrowRight size={17} aria-hidden="true" /><span>{t("moveTo")}</span><ChevronRight className="detail-move-chevron" size={16} aria-hidden="true" /></summary>
            <div className="detail-move-popover">
              {manualTargets.map((action) => <button key={action.to} type="button" disabled={mutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}><CircleDot size={17} aria-hidden="true" />{statusLabel(action.to)}</button>)}
            </div>
          </details>}
        </div>
        <div className="detail-action-group">
          <p className="detail-action-heading">{t("actionGroupTools")}</p>
          <button type="button" disabled={mutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); onEdit(); }}><Pencil size={17} aria-hidden="true" />{t("edit")}</button>
        </div>
        {destructiveActions.map((action) => <div className="detail-action-group" key={`${action.to}-${action.reason}`}>
          <button type="button" className="danger" disabled={mutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}><X size={17} aria-hidden="true" />{transitionLabel(action.label)}</button>
        </div>)}
      </div>
    </details>
    {/* Outside the menu on purpose: a closed <details> hides everything but its
        <summary>, and a <dialog> under a hidden ancestor never paints. */}
    {transferring && <TransferItemDialog item={item} onClose={() => setTransferring(false)} />}
    {noteAction && (
      <Modal
        title={t(transitionNoteCopy(noteAction.to).title)}
        subtitle={t("transitionNoteSubtitle", { key: item.key, status: statusLabel(item.status) })}
        onClose={() => { setNoteAction(null); mutation.reset(); }}
      >
        <TransitionNoteDialog
          action={noteAction}
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error, t("somethingWentWrong")) : null}
          onSubmit={(note) => mutation.mutate({ action: noteAction, note })}
          onCancel={() => { setNoteAction(null); mutation.reset(); }}
        />
      </Modal>
    )}
    </>
  );
}
function mediaNumberLabel(kind: "image" | "video", displayNumber: number, t: ReturnType<typeof useI18n>["t"]): string {
  return t(kind === "image" ? "imageNumber" : "videoNumber", { number: displayNumber });
}

/** The pickup of waiting work, which asks how before it happens (AND-68). */
function isStartWork(status: WorkItemStatus, action: TransitionAction): boolean {
  return status === "ready" && action.to === "in_progress" && action.reason === "claim";
}

function quickActionLabel(status: WorkItemStatus, t: ReturnType<typeof useI18n>["t"]): string {
  const keys = {
    inbox: "quickReady",
    ready: "quickStart",
    in_progress: "quickDevComplete",
    development_complete: "quickVerify",
    on_hold: "quickResume",
    pending_verification: "quickComplete",
    done: "quickReopen",
    cancelled: "quickRestore",
  } as const;
  return t(keys[status]);
}

function DetailPane({
  itemKey,
  openInEdit,
  onClose,
  onItemLoaded,
  onNotice,
  onOpenItem,
  onStartWork,
  onTakeOver,
  sessionFailure,
  onOpenConsoleSession,
}: {
  itemKey: string | null;
  openInEdit: boolean;
  onClose: () => void;
  onItemLoaded: (item: WorkItem) => void;
  onNotice: (message: string) => void;
  onOpenItem: (itemKey: string) => void;
  onStartWork: (item: WorkItem) => void;
  onTakeOver: (item: WorkItem) => void;
  /** The error from the session behind the item's latest launch, when it died before finishing (AND-180). */
  sessionFailure: string | null | undefined;
  onOpenConsoleSession: (sessionId: string) => void;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { actorLabel, eventLabel, formatTime, priorityLabel, statusLabel, t, transitionLabel, typeLabel } = useI18n();
  const itemQuery = useQuery({ queryKey: ["item", itemKey], queryFn: () => api.getItem(itemKey!), enabled: Boolean(itemKey) });
  const timelineQuery = useQuery({ queryKey: ["timeline", itemKey], queryFn: () => api.getTimeline(itemKey!), enabled: Boolean(itemKey) });
  // The same cache entry the dispatch history below reads: the newest record is
  // the one the detail's own line reports (AND-217).
  const dispatchesQuery = useQuery({
    queryKey: ["dispatches", itemKey],
    queryFn: () => api.listItemDispatches(itemKey!),
    enabled: Boolean(itemKey),
  });
  // Same cache entry the delivery panel reads, so the Builder can sit in the
  // title line without a second request.
  const deliveryQuery = useItemDelivery(itemKey);
  const item = itemQuery.data;
  const componentsQuery = useQuery({
    queryKey: ["components", item?.productId, "with-archived"],
    queryFn: () => api.listComponents(item!.productId, { includeArchived: true }),
    enabled: Boolean(item?.productId),
  });
  const [editing, setEditing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const detailPaneRef = useRef<HTMLElement>(null);

  // Some mobile browsers shrink only the visual viewport when the keyboard
  // opens. Keep the footer inside that viewport without covering the report.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const pane = detailPaneRef.current;
      if (!pane) return;
      if (viewport && viewport.scale !== 1) {
        pane.style.removeProperty("--detail-visible-height");
        return;
      }
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      pane.style.setProperty("--detail-visible-height", `${Math.max(0, bottom - pane.getBoundingClientRect().top)}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, [itemKey, item?.key]);
  const [transferBuilderOpen, setTransferBuilderOpen] = useState(false);
  const [statusChecksOpen, setStatusChecksOpen] = useState(false);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!item) return;
    onItemLoaded(item);
  }, [item, onItemLoaded]);

  useEffect(() => {
    setEditing(openInEdit);
    setStatusChecksOpen(false);
  }, [itemKey, openInEdit]);

  useEffect(() => {
    const closeMoreActions = (event: MouseEvent) => {
      if (!moreActionsRef.current?.contains(event.target as Node)) moreActionsRef.current?.removeAttribute("open");
    };
    const closeMoreActionsOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") moreActionsRef.current?.removeAttribute("open");
    };
    document.addEventListener("mousedown", closeMoreActions);
    document.addEventListener("keydown", closeMoreActionsOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMoreActions);
      document.removeEventListener("keydown", closeMoreActionsOnEscape);
    };
  }, []);

  const refreshItem = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["item", itemKey] }),
      queryClient.invalidateQueries({ queryKey: ["timeline", itemKey] }),
      queryClient.invalidateQueries({ queryKey: ["items"] }),
    ]);
  };


  const [noteAction, setNoteAction] = useState<TransitionAction | null>(null);
  const transitionMutation = useMutation({
    mutationFn: ({ action, note }: { action: TransitionAction; note?: string }) =>
      api.transitionItem(itemKey!, action, note),
    onSuccess: async (updated) => {
      setNoteAction(null);
      await applyConfirmedItemTransition(queryClient, updated);
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
    onError: (error) => onNotice(errorMessage(error, t("somethingWentWrong"))),
  });

  const withdrawMutation = useMutation({
    mutationFn: (commentId: string) => api.withdrawComment(itemKey!, commentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["timeline", itemKey] });
      onNotice(t("commentWithdrawnToast"));
    },
    onError: (error) => onNotice(errorMessage(error, t("somethingWentWrong"))),
  });

  if (!itemKey) {
    return null;
  }
  if (itemQuery.isError) {
    return (
      <section className="detail-pane detail-error-state">
        <InlineError message={errorMessage(itemQuery.error, t("somethingWentWrong"))} />
        <BackButton onClick={onClose} label={t("backToList")} />
      </section>
    );
  }
  if (itemQuery.isLoading || !item) {
    return <section className="detail-pane detail-loading"><LoaderCircle className="spin" size={24} /></section>;
  }

  const PrimaryIcon = TYPE_ICONS[item.type];
  // Same rule as the list row: the domain decides whether this move owes a reason.
  const startTransition = (action: TransitionAction) => {
    if (isStartWork(item.status, action)) onStartWork(item);
    else if (transitionRequiresNote(item.status, action.to)) setNoteAction(action);
    else transitionMutation.mutate({ action });
  };
  const actions = item.transferred ? [] : TRANSITIONS[item.status];
  const primaryAction = actions[0];
  const secondaryActions = actions.slice(1);
  const manualTargets = item.transferred ? [] : manualMoves(item.status);
  const sourceComponent = componentsQuery.data?.find((component) => component.id === item.sourceComponentId);
  const affectedComponents = (componentsQuery.data ?? []).filter((component) => item.affectedComponentIds.includes(component.id));
  const environment = environmentFields(item.environment, t);
  const detailCreator = creatorLabel(item.createdBy, { human: actorLabel("human"), sdk: t("creatorSdk"), agent: actorLabel("agent") });
  const createdEvent = timelineQuery.data?.events.find((event) => event.eventType === "item_created");
  const sdkDiagnostics = diagnosticsFromEvent(createdEvent);
  const logAttachments = item.attachments.filter((attachment) => attachment.kind === "log");
  const documentAttachments = item.attachments.filter((attachment) => attachment.kind === "document");
  const archiveAttachments = item.attachments.filter((attachment) => attachment.kind === "archive");
  const mediaAttachments = item.attachments.filter(isMediaAttachment);
  // The newest hand-off, whatever status the item is in, so the detail says
  // where the work went even for a finished item (AND-217). The server orders
  // this newest first.
  const latestDispatch = dispatchesQuery.data?.dispatches[0];
  const dispatchAgentKey = latestDispatch ? agentLabelKey(latestDispatch.agentKind) : null;
  // A launch that later fell over still carries `launched`; the session behind
  // it is what failed (AND-180).
  const dispatchSessionFailed = sessionFailure !== undefined;
  const dispatchFailed = latestDispatch !== undefined
    && (latestDispatch.status === "failed" || dispatchSessionFailed);
  const dispatchFailureReason = latestDispatch?.status === "failed" ? latestDispatch.error : sessionFailure ?? "";
  // Only a dispatch that reached a session can be opened in the console; one
  // that failed before starting left nothing to jump to (AND-217).
  const jumpSessionId = latestDispatch?.agentSessionId;
  const dispatchStatusKey = latestDispatch ? dispatchStatusLabelKey(latestDispatch.status) : null;
  // An inferred execution uses the session creation time. Recorded work rounds
  // have their own start time, which must not be presented as a session launch.
  const summarizedSession = deliveryQuery.data?.executions.find(execution =>
    Boolean(jumpSessionId) && execution.kind === "agent" && execution.recorded !== true && execution.sessionId === jumpSessionId);
  const dispatchStateLabel = dispatchFailed ? t("failedDispatchBadge")
    : summarizedSession ? executionStatusLabel(summarizedSession.status)
    : dispatchStatusKey ? t(dispatchStatusKey) : null;
  return (
    <section className="detail-pane" ref={detailPaneRef}>
      <div className="detail-toolbar">
        <BackButton className="detail-back-button" onClick={onClose} label={t("backToList")} />
        <code>{item.key}</code>
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <span className="toolbar-spacer" />
        <div className="detail-toolbar-actions">
          {primaryAction && (
            <button
              className={`primary-button toolbar-primary-action ${primaryAction.tone === "positive" ? "positive" : ""}`}
              disabled={transitionMutation.isPending}
              onClick={() => startTransition(primaryAction)}
              title={transitionLabel(primaryAction.label)}
            >
              {transitionMutation.isPending && <LoaderCircle className="spin" size={15} />}
              {quickActionLabel(item.status, t)}
            </button>
          )}
          <RefreshButton refreshing={itemQuery.isFetching || timelineQuery.isFetching} onRefresh={refreshItem} />
          <button className="secondary-button" disabled={item.transferred} onClick={() => setEditing(true)}>{t("edit")}</button>
          <details className="detail-more-menu" ref={moreActionsRef} onToggle={(event) => { if (!event.currentTarget.open) event.currentTarget.querySelector(".detail-move-menu")?.removeAttribute("open"); }}>
            <summary className="secondary-button" aria-label={t("moreActions")} title={t("moreActions")}><MoreHorizontal size={19} /></summary>
            <div className="detail-more-menu-popover detail-actions-popover">
              {(deliveryQuery.data?.canManageBuilder || !item.transferred) && <div className="detail-action-group">
                <p className="detail-action-heading">{t("actionGroupCollaboration")}</p>
                {deliveryQuery.data?.canManageBuilder && <button type="button" onClick={() => { moreActionsRef.current?.removeAttribute("open"); setTransferBuilderOpen(true); }}><UserRoundCog size={17} aria-hidden="true" />{t("transferBuilder")}</button>}
                {!item.transferred && <button type="button" onClick={() => { moreActionsRef.current?.removeAttribute("open"); setTransferring(true); }}><ArrowRight size={17} aria-hidden="true" />{t("transferItem")}</button>}
              </div>}
              {(secondaryActions.some((action) => action.tone !== "danger") || manualTargets.length > 0) && <div className="detail-action-group">
                <p className="detail-action-heading">{t("actionGroupStatus")}</p>
                {secondaryActions.filter((action) => action.tone !== "danger").map((action) => (
                  <button key={`${action.to}-${action.reason}`} type="button" disabled={transitionMutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}>
                    {action.to === "on_hold" ? <CirclePause size={17} aria-hidden="true" /> : <Undo2 size={17} aria-hidden="true" />}{transitionLabel(action.label)}
                  </button>
                ))}
                {manualTargets.length > 0 && <details className="detail-move-menu">
                  <summary><ArrowRight size={17} aria-hidden="true" /><span>{t("moveTo")}</span><ChevronRight className="detail-move-chevron" size={16} aria-hidden="true" /></summary>
                  <div className="detail-move-popover">
                    {manualTargets.map((action) => <button key={action.to} type="button" disabled={transitionMutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}><CircleDot size={17} aria-hidden="true" />{statusLabel(action.to)}</button>)}
                  </div>
                </details>}
              </div>}
              <div className="detail-action-group">
                <p className="detail-action-heading">{t("actionGroupTools")}</p>
                <button type="button" onClick={() => { moreActionsRef.current?.removeAttribute("open"); setStatusChecksOpen(true); }}><ClipboardCheck size={17} aria-hidden="true" />{t("statusChecks")}</button>
              </div>
              {secondaryActions.filter((action) => action.tone === "danger").map((action) => (
                <div className="detail-action-group" key={`${action.to}-${action.reason}`}><button type="button" className="danger" disabled={transitionMutation.isPending} onClick={() => { moreActionsRef.current?.removeAttribute("open"); startTransition(action); }}><X size={17} aria-hidden="true" />{transitionLabel(action.label)}</button></div>
              ))}
            </div>
          </details>
        </div>
      </div>
      <div className="detail-scroll">
        {deliveryQuery.data && <BuilderHandoverNotice itemKey={item.key} delivery={deliveryQuery.data} onTakeOver={() => onTakeOver(item)} />}
        {(item.transferred || item.transferredFrom) && <div className="transfer-banner" role="status">
          {item.transferred && <p>{t("transferReadOnly")}</p>}
          {item.transferredTo && <button type="button" className="text-button" onClick={() => onOpenItem(item.transferredTo!.key)}>{t("transferDestination", { key: item.transferredTo.key })}</button>}
          {item.transferredFrom && <button type="button" className="text-button" onClick={() => onOpenItem(item.transferredFrom!.key)}>{t("transferSource", { key: item.transferredFrom.key })}</button>}
        </div>}
        <>
            {/* Between the toolbar and the title: who the work was last handed
                to, which the toolbar's chip used to squeeze in and only for an
                in-progress item (AND-217). A jump to the console session is
                offered only when one was actually started for it. */}
            {latestDispatch && (
              <div className={`detail-dispatch-line ${dispatchFailed ? "failed" : ""}`}>
                <Bot size={16} aria-hidden="true" />
                <span className="detail-dispatch-target">
                  <strong>
                    {t("itemDispatchBadge", {
                      agent: dispatchAgentKey ? t(dispatchAgentKey) : latestDispatch.agentKind,
                      node: latestDispatch.nodeName,
                    })}
                  </strong>
                  <small>
                    {dispatchStateLabel && <>{dispatchStateLabel} · </>}
                    {summarizedSession?.startedAt
                      ? t("sessionStartedTime", { time: formatTime(summarizedSession.startedAt) })
                      : t("dispatchTime", { time: formatTime(latestDispatch.createdAt) })}
                  </small>
                </span>
                {dispatchFailed && dispatchFailureReason && <span className="detail-dispatch-reason">{dispatchFailureReason}</span>}
                {jumpSessionId && (
                  <button
                    type="button"
                    className="secondary-button detail-dispatch-jump"
                    aria-label={t("openDispatchInConsole")}
                    title={t("openDispatchInConsole")}
                    onClick={() => onOpenConsoleSession(jumpSessionId)}
                  >
                    <ExternalLink size={15} aria-hidden="true" /><span>{t("consoleShort")}</span>
                  </button>
                )}
              </div>
            )}
            <div className="detail-title-block">
              <span className={`type-icon large type-${item.type}`}><PrimaryIcon size={20} /></span>
              <div className="detail-title-copy">
                <p className="eyebrow">
                  <span>
                    {typeLabel(item.type)} · {priorityLabel(item.priority)}
                    {detailCreator && <> · {t("createdBy", { name: detailCreator })}</>}
                    {item.createdBy?.kind === "agent" && item.createdBy.name && <> · {t("aiAssistedSubmission")}{item.createdBy.clientName ? ` · ${item.createdBy.clientName}` : ""}</>}
                  </span>
                  {deliveryQuery.data && <BuilderBadge name={deliveryQuery.data.builderName} needsReassignment={deliveryQuery.data.builderNeedsReassignment} />}
                </p>
                <h2>{item.title}</h2>
              </div>
            </div>
            <ItemDeliveryPanel key={item.key} item={item} summarizedSessionId={jumpSessionId} dispatches={dispatchesQuery.data?.dispatches ?? []} dispatchesFailed={dispatchesQuery.isError} renderDispatch={dispatch => <DispatchRow dispatch={dispatch} itemKey={item.key} />} />
            <ItemRelations item={item} onOpenItem={onOpenItem} />
            <ItemDingTalkNotifications key={`dingtalk:${item.key}`} itemKey={item.key} pending={item.status==="pending_verification"} />
            {item.verificationReturn && <VerificationReturnCallout info={item.verificationReturn} />}
            {/* Read the item, then the evidence a person went and looked at --
                screenshots, documents, logs. The captured environment is the
                machine's own footnote to all of it, so it sits underneath them
                rather than between the report and the pictures of the problem. */}
            <ReportDetails type={item.type} report={item.report} fallbackDescription={item.description} />
            <AttachmentSection
              itemKey={item.key}
              attachments={mediaAttachments}
              title={t("mediaAttachments")}
              emptyMessage={t("noMediaAttachments")}
            />
            {documentAttachments.length > 0 && (
              <AttachmentSection
                itemKey={item.key}
                attachments={documentAttachments}
                title={t("documentAttachments")}
              />
            )}
            {archiveAttachments.length > 0 && (
              <AttachmentSection
                itemKey={item.key}
                attachments={archiveAttachments}
                title={t("archiveAttachments")}
              />
            )}
            <DiagnosticDetails
              itemKey={item.key}
              logs={sdkDiagnostics.logs}
              context={sdkDiagnostics.context}
              attachments={logAttachments}
            />
            <section className="environment-block">
              <h3>{t("capturedContext")}</h3>
              {item.environment || sourceComponent || affectedComponents.length > 0 ? (
                <div className="context-grid">
                  {sourceComponent && (
                    <span>
                      <small>{t("sourceComponent")}</small>
                      {sourceComponent.name}{sourceComponent.archivedAt ? ` · ${t("archived")}` : ""}
                    </span>
                  )}
                  {affectedComponents.length > 0 && <span><small>{t("affectedComponents")}</small>{affectedComponents.map((component) => component.name).join("、")}</span>}
                  {environment.primary.map((field) => <EnvironmentCell key={field.key} field={field} />)}
                </div>
              ) : <p className="section-empty">{t("noEnvironment")}</p>}
              {environment.more.length > 0 && (
                <details className="comment-collapsible environment-more">
                  <summary>
                    <small className="when-closed">{t("environmentMore", { count: environment.more.length })}</small>
                    <small className="when-open">{t("environmentLess")}</small>
                  </summary>
                  <div className="context-grid">
                    {environment.more.map((field) => <EnvironmentCell key={field.key} field={field} />)}
                  </div>
                </details>
              )}
            </section>
            <section className="timeline-block">
              <header className="timeline-head">
                <h3>{t("timeline")}</h3>
                <small>{t("newestFirst")}</small>
              </header>
              {timelineQuery.isLoading && <LoaderCircle className="spin" size={18} />}
              <div className="timeline">
                {groupTimeline(timelineQuery.data?.events ?? []).map(({ id, event, count, filenames }) => (
                  <div
                    className={event.actorKind === "agent" ? "timeline-event timeline-event--agent" : "timeline-event"}
                    key={id}
                  >
                    <span className="timeline-dot" />
                    <div>
                      {event.historySourceKey && <span className="timeline-tag">{t("transferHistory", { key: event.historySourceKey })}</span>}
                      <strong>
                        {event.eventType === "status_changed"
                          ? `${event.fromStatus ? statusLabel(event.fromStatus) : t("status")} → ${event.toStatus ? statusLabel(event.toStatus) : t("updated")}`
                          : event.eventType === "comment_added"
                            ? commentHeading(event, t("agentAnalysis"), eventLabel("comment_added"))
                            : count > 1
                              ? t("eventRepeated", { event: eventLabel(event.eventType), count })
                              : eventLabel(event.eventType)}
                      </strong>
                      {/* A direct jump skipped the steps in between; say so, or the
                          history reads as if the work went through them. */}
                      {event.payload?.reason === "manual_override" && <span className="timeline-tag">{t("movedDirectly")}</span>}
                      {/* The AI hands work over naming the pull request that carried
                          it, which is the thing to open when deciding to verify. */}
                      {typeof event.payload?.pullRequestUrl === "string" && (
                        <p className="timeline-pull-request">
                          <a href={event.payload.pullRequestUrl} target="_blank" rel="noreferrer noopener">
                            {t("mergedPullRequest")}
                          </a>
                        </p>
                      )}
                      {event.eventType.startsWith("builder_handover_") && <p>{String(event.payload.reason ?? event.payload.note ?? "正在停止旧执行并交接 Builder")}</p>}
                      {event.eventType === "builder_changed" && <p>{String(event.payload.fromName ?? "待分配")} → {String(event.payload.toName ?? "待分配")}：{String(event.payload.note ?? "")}</p>}
                      {["execution_assigned","execution_handed_over","execution_follow_up","execution_updated"].includes(event.eventType) && <p>{String(event.payload.performer ?? "")}{event.payload.scope ? ` · ${String(event.payload.scope)}` : ""}{event.payload.status ? ` · ${String(event.payload.status)}` : ""} {String(event.payload.note ?? event.payload.result ?? "")}</p>}
                      {event.eventType === "handover_human_confirmed" && <p>{typeof event.payload.note === "string" ? event.payload.note : ""}</p>}
                      {typeof event.payload.completion === "object" && event.payload.completion !== null && "commit" in event.payload.completion && typeof event.payload.completion.commit === "string" && <p><code>{event.payload.completion.commit}</code></p>}
                      {/* Why it moved. Going back to Ready has to say so, which is
                          the case this is here for; a handover carries the agent's
                          summary in the same field and is worth reading too. */}
                      {event.eventType === "status_changed" && <StatusNoteLine payload={event.payload} />}
                      {["item_transferred_in", "item_transferred_out"].includes(event.eventType) && Array.isArray(event.payload.clearedComponents) && event.payload.clearedComponents.length > 0 && (
                        <p>{t("transferClearedComponents", { names: event.payload.clearedComponents.flatMap((c: unknown) => c && typeof c === "object" && "name" in c && typeof c.name === "string" ? [c.name] : []).join("、") })}</p>
                      )}
                      {/* Which machine took it, with what. The batch is named too:
                          one session handles all of it, so the other keys explain
                          work that will appear on this item's branch. */}
                      {event.eventType === "dispatched" && <DispatchedLine payload={event.payload} />}
                      {event.eventType === "derived_item_created" && typeof event.payload.itemKey === "string" && (
                        <p className="timeline-dispatch">
                          <button type="button" className="text-button" onClick={() => onOpenItem(event.payload.itemKey as string)}>
                            {t("derivedItemCreated", { key: event.payload.itemKey })}
                          </button>
                          {typeof event.payload.title === "string" && <span>{event.payload.title}</span>}
                        </p>
                      )}
                      <p>
                        {commentAuthor(
                          { ...event, agentName: eventAgentName(event.payload) },
                          actorLabel(event.actorKind),
                        )} · {formatTime(event.createdAt)}
                      </p>
                      {filenames.length > 0 && <p className="timeline-files">{filenames.join("、")}</p>}
                      {event.eventType === "comment_added" && (
                        <CommentBody
                          payload={event.payload}
                          item={item}
                          readOnly={Boolean(item.transferred)}
                          onWithdraw={async () => {
                            if (await confirm(t("withdrawCommentConfirm"))) withdrawMutation.mutate(event.id);
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
        </>
      </div>
      {!item.transferred && <CommentComposer key={item.key} item={item} onPosted={refreshItem} onNotice={onNotice} />}
      {transferring && <TransferItemDialog item={item} onClose={() => setTransferring(false)} />}
      {statusChecksOpen && <StatusCheckPanel key={item.key} productId={item.productId} itemKey={item.key} canOperate={!item.transferred} onClose={() => setStatusChecksOpen(false)} />}
      {transferBuilderOpen && deliveryQuery.data && (
        <TransferBuilderModal itemKey={item.key} delivery={deliveryQuery.data} onClose={() => setTransferBuilderOpen(false)} />
      )}
      {editing && !item.transferred && (
        <Modal title={t("editItem", { key: item.key })} subtitle="" onClose={() => setEditing(false)}>
          <EditItemForm
            item={item}
            onCancel={() => setEditing(false)}
            onSaved={async (failedUploads) => {
              setEditing(false);
              await refreshItem();
              onNotice(
                failedUploads > 0
                  ? t("uploadPartial", { key: item.key, count: failedUploads })
                  : t("itemUpdated", { key: item.key }),
              );
            }}
          />
        </Modal>
      )}
      {noteAction && (
        <Modal
          title={t(transitionNoteCopy(noteAction.to).title)}
          subtitle={t("transitionNoteSubtitle", { key: item.key, status: statusLabel(item.status) })}
          onClose={() => { setNoteAction(null); transitionMutation.reset(); }}
        >
          <TransitionNoteDialog
            action={noteAction}
            pending={transitionMutation.isPending}
            error={transitionMutation.isError ? errorMessage(transitionMutation.error, t("somethingWentWrong")) : null}
            onSubmit={(note) => transitionMutation.mutate({ action: noteAction, note })}
            onCancel={() => { setNoteAction(null); transitionMutation.reset(); }}
          />
        </Modal>
      )}
    </section>
  );
}

function DispatchRow({ dispatch, itemKey }: { dispatch: Dispatch; itemKey: string }) {
  const { formatTime, t } = useI18n();
  const agentKey = agentLabelKey(dispatch.agentKind);
  const modeKey = dispatchModeLabelKey(dispatch.agentKind, dispatch.mode);
  const statusKey = dispatchStatusLabelKey(dispatch.status);
  const batch = dispatch.itemKeys.filter((key) => key !== itemKey);
  return (
    <article className="dispatch-row">
      <div className="dispatch-row-head">
        <strong>{dispatch.nodeName}</strong>
        <span className={`status-pill dispatch-status-${dispatch.status}`}>{statusKey ? t(statusKey) : dispatch.status}</span>
        <small>{formatTime(dispatch.createdAt)}</small>
      </div>
      <small className="dispatch-row-detail">
        {agentKey ? t(agentKey) : dispatch.agentKind} · {modeKey ? t(modeKey) : dispatch.mode}
        {dispatch.sessionName ? ` · ${dispatch.sessionName}` : ""}
      </small>
      {batch.length > 0 && <small className="dispatch-row-detail">{t("dispatchBatch", { keys: batch.join("、") })}</small>}
      {dispatch.sessionUrl && <SessionLink url={dispatch.sessionUrl} />}
      {dispatch.agentSessionId && <AgentSessionPanel sessionId={dispatch.agentSessionId} />}
      {dispatch.error && <InlineError message={dispatch.error} />}
    </article>
  );
}

function StatusNoteLine({ payload }: { payload: Readonly<Record<string, unknown>> }) {
  const note = statusChangeNote(payload);
  if (!note) return null;
  return <p className="timeline-note">{note}</p>;
}

/** The `dispatched` timeline line, when the payload can say where it went. */
/**
 * Where this item came from and what came out of it (AND-50). Follow-ups keep
 * their own sequential keys, so this is the only place the lineage shows.
 */
function ItemRelations({ item, onOpenItem }: { item: WorkItem; onOpenItem: (itemKey: string) => void }) {
  const { statusLabel, t } = useI18n();
  if (!item.derivedFrom && !item.derivedItems?.length) return null;
  const link = (reference: WorkItemReference) => (
    <button key={reference.key} type="button" className="item-relation-link" onClick={() => onOpenItem(reference.key)}>
      <code>{reference.key}</code>
      <span>{reference.title}</span>
      <small className={`status-pill status-${reference.status}`}>{statusLabel(reference.status)}</small>
    </button>
  );
  return (
    <div className="item-relations">
      {item.derivedFrom && (
        <div><span className="item-relations-label">{t("derivedFrom")}</span>{link(item.derivedFrom)}</div>
      )}
      {item.derivedItems && item.derivedItems.length > 0 && (
        <div><span className="item-relations-label">{t("derivedItems")}</span>{item.derivedItems.map(link)}</div>
      )}
    </div>
  );
}

function DispatchedLine({ payload }: { payload: Readonly<Record<string, unknown>> }) {
  const { t } = useI18n();
  const summary = dispatchedEvent(payload);
  if (!summary) return null;
  const agentKey = agentLabelKey(summary.agentKind);
  const modeKey = dispatchModeLabelKey(summary.agentKind, summary.mode);
  return (
    <p className="timeline-dispatch">
      {t("dispatchedTo", {
        node: summary.nodeName,
        agent: agentKey ? t(agentKey) : summary.agentKind,
        mode: modeKey ? t(modeKey) : summary.mode,
      })}
      {summary.itemKeys.length > 1 && <span>{t("dispatchBatch", { keys: summary.itemKeys.join("、") })}</span>}
    </p>
  );
}

/** A structured analysis reads as an agent's formal finding, so it keeps its own heading. */
function commentHeading(event: WorkItemEvent, analysisLabel: string, commentLabel: string): string {
  return event.actorKind === "agent" && event.payload.bodyKind === "structured" ? analysisLabel : commentLabel;
}

function CommentComposer({ item, onPosted, onNotice }: {
  item: WorkItem; onPosted: () => Promise<void>; onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new Map<File, string>());
  const uploadIds = useRef(new Map<File, string>());
  const attempt = useRef({ fingerprint: "", key: "" });
  const existingIds = new Set(item.attachments.map(attachment => attachment.id));
  const selectedAlreadyCounted = files.filter(file => existingIds.has(uploaded.current.get(file) ?? "")).length;
  const capacity = Math.max(0, 10 - item.attachments.length + selectedAlreadyCounted);
  const remaining = Math.max(0, capacity - files.length);
  const mutation = useMutation({
    mutationFn: async () => {
      const attachmentIds: string[] = [];
      for (const file of files) {
        let id = uploaded.current.get(file);
        if (!id) {
          let uploadId = uploadIds.current.get(file);
          if (!uploadId) { uploadId = crypto.randomUUID(); uploadIds.current.set(file, uploadId); }
          id = (await api.uploadAttachment(item.key, file, uploadId)).id;
          uploaded.current.set(file, id);
        }
        attachmentIds.push(id);
      }
      const fingerprint = JSON.stringify({ text: text.trim(), attachmentIds });
      if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      return api.createComment(item.key, { text: text.trim(), attachmentIds, idempotencyKey: attempt.current.key });
    },
    onSuccess: async () => {
      setText(""); setFiles([]); setError(null); uploaded.current.clear(); uploadIds.current.clear(); attempt.current = { fingerprint: "", key: "" };
      await onPosted(); onNotice(t("commentPosted"));
    },
    onError: async (failure) => { setError(errorMessage(failure, t("somethingWentWrong"))); await onPosted(); },
  });
  const addFiles = (incoming: readonly File[]) => {
    if (mutation.isPending) return;
    const result = validateIncomingFiles(files, incoming, t, capacity);
    setFiles(result.files); setError(result.error ?? null);
  };
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addFiles, { canAccept: remaining > 0 && !mutation.isPending });
  return <form className="comment-form detail-composer" aria-label={t("addComment")} {...dropHandlers}
    onPaste={event => { const incoming = Array.from(event.clipboardData.files); if (incoming.length) { event.preventDefault(); addFiles(incoming); } }}
    onSubmit={event => { event.preventDefault(); if (!mutation.isPending && (text.trim() || files.length)) mutation.mutate(); }}>
    {isDraggingFiles && <FileDropOverlay remaining={remaining} />}
    <fieldset disabled={mutation.isPending}>
      <label className="sr-only" htmlFor="comment-draft">{t("addComment")}</label>
      {files.length > 0 && <div className="agent-chat-draft-files">
        {files.map((file, index) => <DraftChatFile key={`${file.name}-${file.lastModified}-${index}`} file={file} disabled={mutation.isPending}
          onRemove={() => setFiles(current => current.filter((_, fileIndex) => fileIndex !== index))} />)}
      </div>}
      <div className="detail-composer-row">
        <AutoGrowTextarea id="comment-draft" value={text} onChange={event => setText(event.target.value)} placeholder={t("commentPlaceholder")} rows={1} maximumHeight={240} submitOnEnter />
        <div className="agent-chat-send-actions">
          <input ref={fileInputRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.md,.txt,.csv,.json,.pdf,.html,.zip"
            onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          <button type="button" className="secondary-button agent-chat-icon-button" disabled={remaining < 1 || mutation.isPending}
            title={t("addAttachments")} aria-label={t("addAttachments")} onClick={() => fileInputRef.current?.click()}><Plus size={18} /></button>
          <button type="submit" className="primary-button agent-chat-icon-button" disabled={!(text.trim() || files.length) || mutation.isPending}
            title={t(mutation.isPending ? "commentSending" : "commentSend")} aria-label={t(mutation.isPending ? "commentSending" : "commentSend")}>
            {mutation.isPending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </fieldset>
    {error && <InlineError message={error} />}
    {mutation.isError && uploaded.current.size > 0 && <p className="detail-composer-hint">{t("commentUploadRetained")}</p>}
  </form>;
}

function CommentBody({
  payload,
  item,
  onWithdraw,
  readOnly = false,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly item: WorkItem;
  readonly readOnly?: boolean;
  readonly onWithdraw: () => void;
}) {
  const { t } = useI18n();
  const body = (payload.body ?? {}) as Readonly<Record<string, unknown>>;
  const withdrawn = typeof payload.withdrawnAt === "string";
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
  const attachments = item.attachments.filter(attachment => attachmentIds.includes(attachment.id));
  const textContent = payload.bodyKind === "structured"
    ? <AnalysisDetails payload={body} />
    : typeof body.text === "string" && body.text
      ? <MarkdownText className="comment-text">{body.text}</MarkdownText>
      : null;
  if (!textContent && !attachmentIds.length) return null;
  const rendered = <>{textContent}{attachmentIds.length > 0 && <AttachmentSection itemKey={item.key} attachments={attachments} />}</>;

  // Agents write a lot, and at length. A long comment folds behind one line so
  // a timeline of them can be skimmed; a short one is already its own summary,
  // and putting a summary above it would just say everything twice.
  const plain = commentPlainText(payload.bodyKind, body);
  const summary = typeof payload.summary === "string" && payload.summary.trim()
    ? payload.summary.trim()
    : deriveSummary(plain);
  const collapsible = !withdrawn && summary.length > 0 && plain.length > COMMENT_COLLAPSE_THRESHOLD;

  // Withdrawn comments stay on the record but fold away: they are no longer sent
  // to an AI reading the item, and leaving one open invites reading it as current.
  if (withdrawn) {
    return (
      <details className="comment-withdrawn">
        <summary>{t("commentWithdrawn")}</summary>
        <p className="comment-withdrawn-help">{t("commentWithdrawnHelp")}</p>
        {rendered}
      </details>
    );
  }

  const withdrawButton = !readOnly && (
    /* Withdrawing is the person's alone: an agent that could take its own
       words back could erase the record of having said them. */
    <button type="button" className="comment-withdraw" onClick={onWithdraw}>{t("withdrawComment")}</button>
  );

  if (collapsible) {
    return (
      <details className="comment-collapsible">
        <summary>
          <span className="comment-summary-text">{summary}</span>
          <small className="when-closed">{t("commentExpand")}</small>
          <small className="when-open">{t("commentCollapse")}</small>
        </summary>
        {rendered}
        {withdrawButton}
      </details>
    );
  }

  return (
    <div className="comment-body">
      {rendered}
      {withdrawButton}
    </div>
  );
}

function AnalysisDetails({ payload }: { payload: Readonly<Record<string, unknown>> }) {
  const { t } = useI18n();
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const list = (key: string) => (Array.isArray(payload[key])
    ? (payload[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : []);
  const understanding = text("understanding");
  const finding = text("finding");
  const proposal = text("proposal");
  const evidence = list("evidence");
  const openQuestions = list("openQuestions");
  if (!understanding && !finding && !proposal && evidence.length === 0 && openQuestions.length === 0) return null;
  const section = (label: string, body: string) => (body ? <div><span>{label}</span><MarkdownText>{body}</MarkdownText></div> : null);
  const bullets = (label: string, entries: readonly string[]) => (entries.length > 0
    ? <div><span>{label}</span><ul>{entries.map((entry, index) => <li key={`${index}-${entry}`}><MarkdownText>{entry}</MarkdownText></li>)}</ul></div>
    : null);
  return (
    <div className="analysis-details">
      {section(t("analysisUnderstanding"), understanding)}
      {section(t("analysisFinding"), finding)}
      {bullets(t("analysisEvidence"), evidence)}
      {section(t("analysisProposal"), proposal)}
      {bullets(t("analysisOpenQuestions"), openQuestions)}
    </div>
  );
}

interface DiagnosticEventLog {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly attributes: Readonly<Record<string, string>>;
}

function diagnosticsFromEvent(event: WorkItemEvent | undefined): {
  context: Readonly<Record<string, string>>;
  logs: readonly DiagnosticEventLog[];
} {
  if (!event) return { context: {}, logs: [] };
  const rawContext = event.payload.context;
  const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
    ? Object.fromEntries(Object.entries(rawContext).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const rawLogs = Array.isArray(event.payload.logs) ? event.payload.logs : [];
  const logs = rawLogs.flatMap((entry): DiagnosticEventLog[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.timestamp !== "string" || typeof value.message !== "string" || !["debug", "info", "warn", "error"].includes(String(value.level))) return [];
    const rawAttributes = value.attributes;
    const attributes = rawAttributes && typeof rawAttributes === "object" && !Array.isArray(rawAttributes)
      ? Object.fromEntries(Object.entries(rawAttributes).filter((attribute): attribute is [string, string] => typeof attribute[1] === "string"))
      : {};
    return [{
      timestamp: value.timestamp,
      level: value.level as DiagnosticEventLog["level"],
      message: value.message,
      attributes,
    }];
  });
  return { context, logs };
}

function ReportDetails({ type, report, fallbackDescription }: { type: WorkItemType; report: WorkItemReport | undefined; fallbackDescription: string }) {
  const { t } = useI18n();
  const copy = REPORT_COPY[type];
  const overview = report?.overview ?? fallbackDescription;
  const frequencyLabels: Record<WorkItemOccurrenceFrequency, string> = {
    unknown: t("frequencyUnknown"),
    once: t("frequencyOnce"),
    intermittent: t("frequencyIntermittent"),
    frequent: t("frequencyFrequent"),
    always: t("frequencyAlways"),
  };
  const hasBugDetails = type === "bug";
  const hasDetails = Boolean(overview || (hasBugDetails && (report?.reproductionSteps || report?.expectedOutcome || report?.impact || report?.occurrenceFrequency)));
  return (
    <section className="description-block report-detail-block">
      <h3>{t(copy.title)}</h3>
      {!hasDetails ? <p className="section-empty">{t("noDescription")}</p> : (
        <div className="report-detail-grid">
          {overview && <article className="wide"><small>{t(copy.overview)}</small><MarkdownText>{overview}</MarkdownText></article>}
          {hasBugDetails && report?.reproductionSteps && <article><small>{t("reproductionSteps")}</small><MarkdownText>{report.reproductionSteps}</MarkdownText></article>}
          {hasBugDetails && report?.expectedOutcome && <article><small>{t("expectedOutcome")}</small><MarkdownText>{report.expectedOutcome}</MarkdownText></article>}
          {hasBugDetails && report?.impact && <article><small>{t("impact")}</small><MarkdownText>{report.impact}</MarkdownText></article>}
          {hasBugDetails && report?.occurrenceFrequency && <article><small>{t("occurrenceFrequency")}</small><MarkdownText>{frequencyLabels[report.occurrenceFrequency]}</MarkdownText></article>}
        </div>
      )}
    </section>
  );
}

function DiagnosticDetails({
  itemKey,
  logs,
  context,
  attachments,
}: {
  itemKey: string;
  logs: readonly DiagnosticEventLog[];
  context: Readonly<Record<string, string>>;
  attachments: readonly WorkItemAttachment[];
}) {
  const { formatTime, t } = useI18n();
  // Diagnostics submitted through the SDK arrive as a .log attachment. Parsing
  // it back gives the same level-and-attribute view the entries used to get
  // when they rode along inside the creation event.
  const diagnosticsFile = attachments.find((attachment) => attachment.filename.endsWith("-diagnostics.log"));
  const parsedQuery = useQuery({
    queryKey: ["diagnostics-log", itemKey, diagnosticsFile?.id],
    queryFn: async () => parseFeedbackLog(await api.readTextAttachment(itemKey, diagnosticsFile!.id)),
    enabled: Boolean(diagnosticsFile),
    staleTime: Infinity,
  });
  const parsedLogs: readonly DiagnosticEventLog[] = (parsedQuery.data ?? []).map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    attributes: entry.attributes ?? {},
  }));
  const allLogs = logs.length > 0 ? logs : parsedLogs;
  const hasDiagnostics = allLogs.length > 0 || attachments.length > 0 || Object.keys(context).length > 0;
  return (
    <section className="attachment-block diagnostic-detail-block">
      <header>
        <div><h3>{t("diagnostics")}</h3></div>
      </header>
      {!hasDiagnostics ? <p className="section-empty">{t("noDiagnostics")}</p> : (
        <div className="diagnostic-detail-content">
          {Object.keys(context).length > 0 && (
            <details className="diagnostic-context-details">
              <summary>{t("runtimeContext")}<small>{t("entryCount", { count: Object.keys(context).length })}</small></summary>
              <div className="diagnostic-context-grid">{Object.entries(context).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>
            </details>
          )}
          {allLogs.length > 0 && (
            <details className="structured-log-details" open>
              <summary>{t("sdkLogs")}<small>{t("logCount", { count: allLogs.length })}</small></summary>
              <div className="structured-log-list">
                {allLogs.map((log, index) => (
                  <article key={`${log.timestamp}-${index}`} className={`log-${log.level}`}>
                    <header><strong>{log.level.toUpperCase()}</strong><time>{formatTime(log.timestamp)}</time></header>
                    <pre>{log.message}</pre>
                    {Object.keys(log.attributes).length > 0 && <dl>{Object.entries(log.attributes).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
                  </article>
                ))}
              </div>
            </details>
          )}
          {attachments.length > 0 && <div className="attachment-grid">{attachments.map((attachment) => <AttachmentCard key={attachment.id} itemKey={itemKey} attachment={attachment} />)}</div>}
        </div>
      )}
    </section>
  );
}

function EditItemForm({ item, onSaved, onCancel }: { item: WorkItem; onCancel: () => void; onSaved: (failedUploads: number) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [partiallySaved, setPartiallySaved] = useState(false);
  const [appliedRemovals, setAppliedRemovals] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<CaptureDraft>(() => ({
    title: item.title,
    description: item.report?.overview ?? item.description,
    reproductionSteps: item.report?.reproductionSteps ?? "",
    expectedOutcome: item.report?.expectedOutcome ?? "",
    impact: item.report?.impact ?? "",
    occurrenceFrequency: item.report?.occurrenceFrequency ?? "unknown",
    diagnosticLog: "",
    type: item.type,
    priority: item.priority,
    sourceComponentId: item.sourceComponentId ?? "",
    environment: environmentDraft(item.environment),
  }));
  const [files, setFiles] = useState<readonly File[]>([]);
  const [removedAttachments, setRemovedAttachments] = useState<readonly string[]>([]);
  const [replacementFiles, setReplacementFiles] = useState<Record<string, File>>({});
  const remainingAttachments = item.attachments.filter(attachment => !removedAttachments.includes(attachment.id) && !appliedRemovals.includes(attachment.id));
  const [fileError, setFileError] = useState<string | null>(null);
  // Unlike the capture form, an edit in progress is mirrored nowhere: closing the tab
  // loses it. Captured once, from the first render, so it stays the value to compare against.
  const [savedDraft] = useState(draft);
  useUnsavedChangesGuard(JSON.stringify(draft) !== JSON.stringify(savedDraft) || files.length > 0 || removedAttachments.length > 0 || Object.keys(replacementFiles).length > 0);

  const addIncomingFiles = (incoming: readonly File[]) => {
    const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
    const result = validateIncomingFiles(files, incoming, t, Math.max(0, 10 - remainingAttachments.length - diagnosticSlots));
    setFiles(result.files);
    setFileError(result.error ?? null);
  };
  const remainingDropSlots = Math.max(0, 10 - remainingAttachments.length - (draft.diagnosticLog.trim() ? 1 : 0) - files.length);
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addIncomingFiles, { canAccept: remainingDropSlots > 0 });

  const mutation = useMutation({
    mutationFn: async () => {
      const attachmentLimit = Math.max(0, 10 - remainingAttachments.length);
      if (files.length + (draft.diagnosticLog.trim() ? 1 : 0) > attachmentLimit) {
        throw new Error(t("tooManyFiles", { count: attachmentLimit }));
      }
      if (diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES) {
        throw new Error(t("diagnosticTooLarge"));
      }
      await api.updateItem(item.key, {
        title: draft.title,
        description: draft.description,
        report: workItemReportPayload(draft),
        type: draft.type,
        priority: draft.priority,
        sourceComponentId: draft.sourceComponentId || null,
        affectedComponentIds: draft.sourceComponentId
          ? [...new Set([draft.sourceComponentId, ...item.affectedComponentIds])]
          : item.affectedComponentIds,
        environment: environmentPayload(
          draft.environment,
          draft.environment.platform === item.environment?.platform ? item.environment?.metadata : undefined,
        ) ?? null,
      });
      setPartiallySaved(true);
      for (const id of removedAttachments) {
        await api.deleteAttachment(item.key, id);
        setAppliedRemovals(previous => [...previous, id]);
        setRemovedAttachments(previous => previous.filter(value => value !== id));
        setReplacementFiles(previous => { const next = { ...previous }; delete next[id]; return next; });
      }
      for (const [id, file] of Object.entries(replacementFiles)) {
        if (removedAttachments.includes(id)) continue;
        await api.replaceAttachment(item.key, id, file);
        setReplacementFiles(previous => { const next = { ...previous }; delete next[id]; return next; });
      }
      return uploadAttachmentsSequentially(item.key, filesWithDiagnosticLog(files, draft.diagnosticLog));
    },
    onSuccess: onSaved,
    onError: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["item", item.key] }), queryClient.invalidateQueries({ queryKey: ["items"] }), queryClient.invalidateQueries({ queryKey: ["timeline", item.key] })]); },
  });

  useDialogDraft(false, mutation.isPending);

  return (
    <form
      className="capture-form quick-capture-form"
      onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending) mutation.mutate(); }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      onPaste={(event) => {
        const pastedFiles = Array.from(event.clipboardData.files);
        if (pastedFiles.length > 0) {
          event.preventDefault();
          addIncomingFiles(pastedFiles);
        }
      }}
      {...dropHandlers}
    >
      {isDraggingFiles && <FileDropOverlay remaining={remainingDropSlots} />}
      <WorkItemFields
        productId={item.productId}
        draft={draft}
        onDraft={setDraft}
        files={files}
        onFiles={setFiles}
        fileError={fileError}
        attachmentLimit={Math.max(0, 10 - remainingAttachments.length)}
        existingItemKey={item.key}
        existingAttachments={remainingAttachments}
        onDeleteExistingAttachment={attachmentId => setRemovedAttachments(previous => [...previous, attachmentId])}
        replacementFiles={replacementFiles}
        onStageReplacement={(id, file) => setReplacementFiles(previous => ({ ...previous, [id]: file }))}
      />
      {mutation.isError && <InlineError message={partiallySaved ? `${t("partialItemSave")} ${errorMessage(mutation.error, t("somethingWentWrong"))}` : errorMessage(mutation.error, t("somethingWentWrong"))} />}
      {removedAttachments.length > 0 && <p role="status" className="account-note">{t("stagedAttachmentRemoval", { count: removedAttachments.length })}<button type="button" className="text-button" disabled={mutation.isPending} onClick={() => setRemovedAttachments([])}>{t("undoAttachmentRemoval")}</button></p>}
      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>{t("cancel")}</button>
        <button className="primary-button" disabled={mutation.isPending || !draft.title.trim() || !draft.description.trim() || !draft.environment.platform || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > Math.max(0, 10 - remainingAttachments.length)}>
          {mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} {t("saveChanges")}
        </button>
      </div>
    </form>
  );
}

function WorkItemFields({
  productId,
  draft,
  onDraft,
  files,
  onFiles,
  fileError,
  attachmentLimit = 10,
  existingItemKey,
  existingAttachments = [],
  onDeleteExistingAttachment,
  onExistingAttachmentReplaced,
  deletingExistingAttachmentId,
  replacementFiles,
  onStageReplacement,
}: {
  productId: string;
  draft: CaptureDraft;
  onDraft: ReactDispatch<SetStateAction<CaptureDraft>>;
  files: readonly File[];
  onFiles: (files: readonly File[]) => void;
  fileError: string | null;
  attachmentLimit?: number;
  existingItemKey?: string;
  existingAttachments?: readonly WorkItemAttachment[];
  onDeleteExistingAttachment?: ((attachmentId: string) => void) | undefined;
  onExistingAttachmentReplaced?: (() => void | Promise<void>) | undefined;
  deletingExistingAttachmentId?: string | undefined;
  replacementFiles?: Readonly<Record<string, File>>;
  onStageReplacement?: (id: string, file: File) => void;
}) {
  const { priorityLabel, t, typeLabel } = useI18n();
  const productsQuery = useQuery({ queryKey: ["products"], queryFn: () => api.listProducts() });
  const canOperate = productsQuery.data?.find(product => product.id === productId)?.access?.canOperate === true;
  const componentsQuery = useQuery({ queryKey: ["components", productId], queryFn: () => api.listComponents(productId) });
  const logBytes = diagnosticLogBytes(draft.diagnosticLog);
  const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
  const remainingAttachments = Math.max(0, attachmentLimit - files.length - diagnosticSlots);
  const attachmentOverflow = files.length + diagnosticSlots > attachmentLimit;
  const existingLogAttachments = existingAttachments.filter((attachment) => attachment.kind === "log");
  const existingDocumentAttachments = existingAttachments.filter((attachment) => attachment.kind === "document");
  const existingArchiveAttachments = existingAttachments.filter((attachment) => attachment.kind === "archive");
  const existingMediaAttachments = existingAttachments.filter(isMediaAttachment);
  const selectedLogFiles = files.filter(isDiagnosticFile);
  const selectedDocumentFiles = files.filter(isDocumentFile);
  const selectedArchiveFiles = files.filter(isArchiveFile);
  const selectedMediaFiles = files.filter((file) => !isDiagnosticFile(file) && !isDocumentFile(file) && !isArchiveFile(file));
  const withMediaFiles = (next: readonly File[]) => [...selectedLogFiles, ...selectedDocumentFiles, ...selectedArchiveFiles, ...next];
  const withDocumentFiles = (next: readonly File[]) => [...selectedLogFiles, ...next, ...selectedArchiveFiles, ...selectedMediaFiles];
  const withArchiveFiles = (next: readonly File[]) => [...selectedLogFiles, ...selectedDocumentFiles, ...next, ...selectedMediaFiles];
  const withLogFiles = (next: readonly File[]) => [...next, ...selectedDocumentFiles, ...selectedArchiveFiles, ...selectedMediaFiles];
  const reportCopy = REPORT_COPY[draft.type];
  const showsBugFields = draft.type === "bug";
  const platformRequired = draft.type === "bug" || draft.type === "task";
  // Diagnostics belong to something that runs. Keep the block available for
  // every type, but only unfolded where a log is part of the report.
  const diagnosticsOpen = platformRequired
    || Boolean(draft.diagnosticLog.trim())
    || selectedLogFiles.length > 0
    || existingLogAttachments.length > 0;

  const updateDraft = <Key extends keyof CaptureDraft>(key: Key, value: CaptureDraft[Key]) => {
    onDraft({ ...draft, [key]: value });
  };
  const titleMutation = useMutation({
    mutationFn: () => {
      if (!canOperate) throw new Error(t("captureReadOnly"));
      return api.generateTitle(productId, draft.description);
    },
    onSuccess: ({ title }) => onDraft((current) => ({ ...current, title })),
  });

  useEffect(() => {
    if (!draft.sourceComponentId || !componentsQuery.data) return;
    const selectedModule = componentsQuery.data.find((component) => component.id === draft.sourceComponentId);
    if (!selectedModule || (draft.environment.platform && selectedModule.kind !== draft.environment.platform)) {
      updateDraft("sourceComponentId", "");
    }
  }, [componentsQuery.data, draft.environment.platform, draft.sourceComponentId]);

  return (
    <>
      <div className="capture-type-grid" aria-label={t("type")}>
        {ITEM_TYPES.map((value) => {
          const Icon = TYPE_ICONS[value];
          return (
            <button key={value} type="button" className={`capture-type ${draft.type === value ? "active" : ""} type-${value}`} onClick={() => updateDraft("type", value)}>
              <Icon size={16} /> {typeLabel(value)}
            </button>
          );
        })}
      </div>
      <div className="classification-row">
        <label><FieldLabel required={platformRequired}>{t("platform")}</FieldLabel>
          <Select
            value={draft.environment.platform}
            onChange={(event) => {
              const platform = event.target.value as EnvironmentDraft["platform"];
              const selectedModule = componentsQuery.data?.find((component) => component.id === draft.sourceComponentId);
              onDraft({
                ...draft,
                sourceComponentId: selectedModule && selectedModule.kind !== platform ? "" : draft.sourceComponentId,
                environment: { ...draft.environment, platform },
              });
            }}
            required={platformRequired}
          >
            <option value="">{t("selectPlatform")}</option>
            {COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}
          </Select>
        </label>
        <label><FieldLabel>{t("sourceComponent")}</FieldLabel>
          <Select
            value={draft.sourceComponentId}
            onChange={(event) => {
              const sourceComponentId = event.target.value;
              const kind = componentsQuery.data?.find((component) => component.id === sourceComponentId)?.kind;
              onDraft({
                ...draft,
                sourceComponentId,
                environment: kind
                  ? { ...draft.environment, platform: kind }
                  : draft.environment,
              });
            }}
            disabled={componentsQuery.isLoading || !draft.environment.platform}
          >
            <option value="">{t("allModules")}</option>
            {(componentsQuery.data ?? []).filter((component) => component.kind === draft.environment.platform).map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
          </Select>
        </label>
        <label><FieldLabel>{t("priority")}</FieldLabel><Select value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</Select></label>
      </div>
      <div className="ai-title-field">
        <label><FieldLabel required>{t("whatNeedsAttention")}</FieldLabel><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus data-initial-focus /></label>
        <button type="button" className="secondary-button" disabled={!canOperate || titleMutation.isPending || !draft.description.trim()}
          title={!canOperate ? t("captureReadOnly") : !draft.description.trim() ? t("aiTitleNeedsContent") : undefined}
          onClick={() => titleMutation.mutate()}>
          {titleMutation.isPending ? t("aiTitleGenerating") : t("aiTitleButton")}
        </button>
      </div>
      <small className="ai-title-privacy">{t("aiTitlePrivacy")}</small>
      {titleMutation.isError && <InlineError message={localizedErrorText(titleMutation.error, t)} />}
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("mediaAttachments")}</FieldLabel></strong><p>{t("mediaAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedMediaFiles}
            onFiles={(nextMediaFiles) => onFiles(withMediaFiles(nextMediaFiles))}
            remaining={remainingAttachments}
            showSelectedFiles={false}
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm"
            allowedExtensions={["png", "jpg", "jpeg", "webp", "gif", "heic", "mp4", "mov", "webm"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingMediaAttachments.length > 0 && (
          <div className="attachment-grid compact-attachment-grid">{existingMediaAttachments.map((attachment) => (
            <AttachmentCard
              key={attachment.id}
              itemKey={existingItemKey}
              attachment={attachment}
              onDelete={onDeleteExistingAttachment}
              onReplaced={onExistingAttachmentReplaced}
              replacementFile={replacementFiles?.[attachment.id]}
              onStageReplacement={onStageReplacement}
              deleting={deletingExistingAttachmentId === attachment.id}
            />
          ))}</div>
        )}
        {selectedMediaFiles.length > 0 && (
          <SelectedFilePreviews
            files={selectedMediaFiles}
            onFiles={(nextMediaFiles) => onFiles(withMediaFiles(nextMediaFiles))}
            startingNumbers={{
              image: Math.max(0, ...existingMediaAttachments.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.displayNumber)),
              video: Math.max(0, ...existingMediaAttachments.filter((attachment) => attachment.kind === "video").map((attachment) => attachment.displayNumber)),
            }}
          />
        )}
      </section>
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("documentAttachments")}</FieldLabel></strong><p>{t("documentAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedDocumentFiles}
            onFiles={(nextDocumentFiles) => onFiles(withDocumentFiles(nextDocumentFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            showSelectedFiles
            accept=".md,.txt,.csv,.json,.pdf,.html,text/markdown,text/plain,text/csv,application/json,application/pdf,text/html"
            allowedExtensions={["md", "txt", "csv", "json", "pdf", "html"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingDocumentAttachments.length > 0 && (
          <div className="attachment-grid compact-attachment-grid">{existingDocumentAttachments.map((attachment) => (
            <AttachmentCard
              key={attachment.id}
              itemKey={existingItemKey}
              attachment={attachment}
              onDelete={onDeleteExistingAttachment}
              onReplaced={onExistingAttachmentReplaced}
              deleting={deletingExistingAttachmentId === attachment.id}
            />
          ))}</div>
        )}
      </section>
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("archiveAttachments")}</FieldLabel></strong><p>{t("archiveAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedArchiveFiles}
            onFiles={(nextArchiveFiles) => onFiles(withArchiveFiles(nextArchiveFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            showSelectedFiles
            accept=".zip,application/zip,application/x-zip-compressed"
            allowedExtensions={["zip"]}
            buttonLabel={t("add")}
            addIcon
          />
        </div>
        {existingItemKey && existingArchiveAttachments.length > 0 && (
          <div className="attachment-grid compact-attachment-grid">{existingArchiveAttachments.map((attachment) => (
            <AttachmentCard
              key={attachment.id}
              itemKey={existingItemKey}
              attachment={attachment}
              onDelete={onDeleteExistingAttachment}
              onReplaced={onExistingAttachmentReplaced}
              deleting={deletingExistingAttachmentId === attachment.id}
            />
          ))}</div>
        )}
      </section>
      {attachmentOverflow && <InlineError message={t("tooManyFiles", { count: attachmentLimit })} />}
      {fileError && <InlineError message={fileError} />}
      <section className="report-input-block">
        <header><strong>{t(reportCopy.title)}</strong><small>{t(reportCopy.help)}</small></header>
        <label><FieldLabel required>{t(reportCopy.overview)}</FieldLabel><AutoGrowTextarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t(reportCopy.placeholder)} rows={4} maxLength={20_000} required /></label>
        {showsBugFields && (
          <details className="bug-optional-details">
            <summary><ChevronRight size={16} /><span>{t("bugOptionalDetails")}</span></summary>
            <div className="report-field-grid">
            <label><FieldLabel>{t("reproductionSteps")}</FieldLabel><AutoGrowTextarea value={draft.reproductionSteps} onChange={(event) => updateDraft("reproductionSteps", event.target.value)} placeholder={t("reproductionStepsPlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("expectedOutcome")}</FieldLabel><AutoGrowTextarea value={draft.expectedOutcome} onChange={(event) => updateDraft("expectedOutcome", event.target.value)} placeholder={t("expectedOutcomePlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("impact")}</FieldLabel><AutoGrowTextarea value={draft.impact} onChange={(event) => updateDraft("impact", event.target.value)} placeholder={t("impactPlaceholder")} rows={3} maxLength={10_000} /></label>
            <label><FieldLabel>{t("occurrenceFrequency")}</FieldLabel>
              <Select value={draft.occurrenceFrequency} onChange={(event) => updateDraft("occurrenceFrequency", event.target.value as WorkItemOccurrenceFrequency)}>
                <option value="unknown">{t("frequencyUnknown")}</option>
                <option value="once">{t("frequencyOnce")}</option>
                <option value="intermittent">{t("frequencyIntermittent")}</option>
                <option value="frequent">{t("frequencyFrequent")}</option>
                <option value="always">{t("frequencyAlways")}</option>
              </Select>
            </label>
            </div>
          </details>
        )}
      </section>
      <details className="diagnostic-input-block" open={diagnosticsOpen}>
        <summary className="diagnostic-input-heading">
          <span><strong>{t("diagnostics")}</strong><small>{t("diagnosticsHelp")}</small></span>
          <FilePicker
            files={selectedLogFiles}
            onFiles={(nextLogFiles) => onFiles(withLogFiles(nextLogFiles))}
            remaining={remainingAttachments}
            showCamera={false}
            accept=".log,text/plain"
            allowedExtensions={["log"]}
            buttonLabel={t("uploadLog")}
          />
        </summary>
        <label><FieldLabel>{t("diagnosticLog")}</FieldLabel>
          <textarea
            className="diagnostic-log-input"
            value={draft.diagnosticLog}
            onChange={(event) => updateDraft("diagnosticLog", event.target.value)}
            placeholder={t("diagnosticLogPlaceholder")}
            rows={5}
            spellCheck={false}
          />
        </label>
        <footer>
          <small className={logBytes > MAX_DIAGNOSTIC_LOG_BYTES ? "over-limit" : ""}>{t("pastedLogSize", { size: formatBytes(logBytes), limit: formatBytes(MAX_DIAGNOSTIC_LOG_BYTES) })}</small>
          {draft.diagnosticLog && <button type="button" className="text-button" onClick={() => updateDraft("diagnosticLog", "")}><X size={13} /> {t("clearLog")}</button>}
        </footer>
        {logBytes > MAX_DIAGNOSTIC_LOG_BYTES && <InlineError message={t("diagnosticTooLarge")} />}
        {existingItemKey && existingLogAttachments.length > 0 && (
          <div className="attachment-grid compact-attachment-grid">{existingLogAttachments.map((attachment) => (
            <AttachmentCard
              key={attachment.id}
              itemKey={existingItemKey}
              attachment={attachment}
              onDelete={onDeleteExistingAttachment}
              deleting={deletingExistingAttachmentId === attachment.id}
            />
          ))}</div>
        )}
      </details>
      <details className="capture-optional" open={hasOptionalEnvironmentDetails(draft.environment) || draft.environment.platform === "web"}>
        <summary><ChevronRight size={16} /> <span><strong>{t("optionalDetails")}</strong><small>{t("optionalDetailsHelp")}</small></span></summary>
        <div className="capture-optional-body">
          <EnvironmentFields value={draft.environment} onChange={(value) => updateDraft("environment", value)} />
          {draft.environment.platform === "web" && <p className="auto-context-note">{t("autoWebContext")}</p>}
        </div>
      </details>
    </>
  );
}

function CaptureForm({ product, onCreated }: { product: Product; onCreated: (item: WorkItem, failedUploads: number) => void }) {
  const { t } = useI18n();
  const canOperate = product.access?.canOperate === true;
  const storageKey = captureDraftStorageKey(product.id);
  const [draft, setDraft] = useState<CaptureDraft>(() => parseCaptureDraft(localStorage.getItem(storageKey)));
  const [files, setFiles] = useState<readonly File[]>([]);
  const [filesReady, setFilesReady] = useState(false);
  const [filePersistenceWarning, setFilePersistenceWarning] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [clearGalleryCopies, setClearGalleryCopies] = useState(true);
  const [mediaDeletion] = useState(androidMediaDeletion);

  useEffect(() => {
    if (hasCaptureDraftContent(draft)) localStorage.setItem(storageKey, JSON.stringify(draft));
    else localStorage.removeItem(storageKey);
  }, [draft, storageKey]);

  useEffect(() => {
    let active = true;
    void loadDraftFiles(product.id)
      .catch(() => [])
      .then((restored) => {
        if (active) setFiles((current) => current.length > 0 ? current : restored);
      })
      .finally(() => {
        if (active) setFilesReady(true);
      });
    return () => { active = false; };
  }, [product.id]);

  useEffect(() => {
    if (!filesReady) return undefined;
    void saveDraftFiles(product.id, files).then((result) => {
      setFilePersistenceWarning(result === "too-large" ? t("largeDraftAttachments") : null);
    });
    return undefined;
  }, [files, filesReady, product.id, t]);

  const addIncomingFiles = (incoming: readonly File[]) => {
    const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
    const result = validateIncomingFiles(files, incoming, t, 10 - diagnosticSlots);
    setFiles(result.files);
    setFileError(result.error ?? null);
  };
  const remainingDropSlots = Math.max(0, 10 - (draft.diagnosticLog.trim() ? 1 : 0) - files.length);
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addIncomingFiles, { canAccept: remainingDropSlots > 0 });

  const mutation = useMutation({
    mutationFn: async (status: "inbox" | "ready") => {
      if (!canOperate) throw new Error(t("captureReadOnly"));
      if (files.length + (draft.diagnosticLog.trim() ? 1 : 0) > 10) {
        throw new Error(t("tooManyFiles", { count: 10 }));
      }
      if (diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES) {
        throw new Error(t("diagnosticTooLarge"));
      }
      const environment = environmentPayload(draft.environment, undefined, true);
      const item = await api.createItem({
        productId: product.id,
        status,
        title: draft.title,
        description: draft.description,
        report: workItemReportPayload(draft),
        type: draft.type,
        priority: draft.priority,
        ...(draft.sourceComponentId
          ? { sourceComponentId: draft.sourceComponentId, affectedComponentIds: [draft.sourceComponentId] }
          : {}),
        ...(environment ? { environment } : {}),
      });
      const failedUploads = await uploadAttachmentsSequentially(item.key, filesWithDiagnosticLog(files, draft.diagnosticLog));
      // Only once the item exists and the uploads are done -- the copies on the
      // phone are the only remaining ones until then.
      if (clearGalleryCopies && failedUploads === 0) mediaDeletion?.deletePickedMedia();
      return { item, failedUploads };
    },
    onSuccess: ({ item, failedUploads }) => {
      localStorage.removeItem(storageKey);
      void clearDraftFiles(product.id);
      onCreated(item, failedUploads);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate("ready");
  };

  useDialogDraft(false, mutation.isPending);

  return (
    <form
      className="capture-form quick-capture-form"
      onSubmit={submit}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      onPaste={(event) => {
        const pastedFiles = Array.from(event.clipboardData.files);
        if (pastedFiles.length > 0) {
          event.preventDefault();
          addIncomingFiles(pastedFiles);
        }
      }}
      {...dropHandlers}
    >
      {isDraggingFiles && <FileDropOverlay remaining={remainingDropSlots} />}
      <WorkItemFields
        productId={product.id}
        draft={draft}
        onDraft={setDraft}
        files={files}
        onFiles={setFiles}
        fileError={fileError}
      />
      {!canOperate && <p role="status">{t("captureReadOnly")}</p>}
      {mutation.isError && <InlineError message={localizedErrorText(mutation.error, t)} />}
      {filePersistenceWarning && <InlineError message={filePersistenceWarning} />}
      {mediaDeletion && files.some((file) => !isDiagnosticFile(file) && !isDocumentFile(file)) && (
        <label className="clear-gallery-option">
          <input type="checkbox" checked={clearGalleryCopies} onChange={(event) => setClearGalleryCopies(event.target.checked)} />
          <span><strong>{t("clearGalleryCopies")}</strong><small>{t("clearGalleryCopiesHelp")}</small></span>
        </label>
      )}
      {/* capture-actions, not just form-footer: on a phone this one sticks to the
          bottom of the sheet, which the edit form's footer does not. See AND-30. */}
      <div className="form-footer capture-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!canOperate || mutation.isPending || !draft.title.trim() || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > 10}
          onClick={() => mutation.mutate("inbox")}
        >
          {mutation.isPending && mutation.variables === "inbox" ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />} {t("saveDraft")}
        </button>
        <button className="primary-button" disabled={!canOperate || mutation.isPending || !draft.title.trim() || !draft.description.trim() || !draft.environment.platform || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > 10}>
          {mutation.isPending && mutation.variables === "ready" ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {t("submitForProcessing")}
        </button>
      </div>
    </form>
  );
}

function EnvironmentFields({ value, onChange }: { value: EnvironmentDraft; onChange: (value: EnvironmentDraft) => void }) {
  const { t } = useI18n();
  const update = (field: keyof EnvironmentDraft, nextValue: string) => onChange({ ...value, [field]: nextValue });
  return (
    <fieldset className="environment-fields">
      <legend>{t("environmentDetails")}</legend>
      <p>{t("environmentHelp")}</p>
      <div className="field-row">
        <label>{t("appVersion")}<input value={value.appVersion} onChange={(event) => update("appVersion", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("buildNumber")}<input value={value.buildNumber} onChange={(event) => update("buildNumber", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("osVersion")}<input value={value.osVersion} onChange={(event) => update("osVersion", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("deviceModel")}<input value={value.deviceModel} onChange={(event) => update("deviceModel", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
        <label>{t("sourceRevision")}<input value={value.sourceRevision} onChange={(event) => update("sourceRevision", event.target.value)} placeholder={t("notAvailableYet")} maxLength={500} /></label>
      </div>
    </fieldset>
  );
}

// The drag overlay itself lives in file-drop-overlay.tsx, shared with the
// agent console reply box (AND-234); the + picker below stays local.

function FilePicker({
  files = [],
  onFiles,
  remaining,
  disabled = false,
  showSelectedFiles = true,
  showCamera = true,
  accept = "image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.md,.txt,.csv,.json,.pdf,.html,.zip",
  allowedExtensions,
  buttonLabel,
  addIcon = false,
}: {
  files?: readonly File[];
  onFiles: (files: readonly File[]) => void;
  remaining: number;
  disabled?: boolean;
  showSelectedFiles?: boolean;
  showCamera?: boolean;
  accept?: string;
  allowedExtensions?: readonly string[];
  buttonLabel?: string;
  addIcon?: boolean;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  const addFiles = (selected: FileList | null) => {
    if (!selected) return;
    const incoming = Array.from(selected);
    if (incoming.length > remaining) {
      setError(t("tooManyFiles", { count: remaining }));
      return;
    }
    const accepted: File[] = [];
    let nextError: string | null = null;
    for (const file of incoming) {
      const validation = validateAttachment(file, allowedExtensions);
      if (!validation.valid && validation.reason === "unsupported") {
        nextError ??= t("unsupportedFile", { filename: file.name });
        continue;
      }
      if (!validation.valid && validation.reason === "too-large") {
        nextError ??= t("fileTooLarge", { filename: file.name, size: validation.limitMiB });
        continue;
      }
      accepted.push(file);
    }
    setError(nextError);
    if (accepted.length > 0) onFiles(files.length > 0 ? [...files, ...accepted] : accepted);
  };

  return (
    <div className="file-picker">
      <div className="file-picker-actions">
        <label className={`secondary-button file-picker-button ${disabled || remaining < 1 ? "disabled" : ""}`}>
          {disabled ? <LoaderCircle className="spin" size={16} /> : addIcon ? <Plus size={16} /> : <Paperclip size={16} />}
          {buttonLabel ?? t("addAttachments")}
          <input
            type="file"
            multiple
            accept={accept}
            disabled={disabled || remaining < 1}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {showCamera && <label className={`secondary-button file-picker-button mobile-only ${disabled || remaining < 1 ? "disabled" : ""}`}>
          <Camera size={16} /> {t("takePhoto")}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={disabled || remaining < 1}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>}
      </div>
      {showSelectedFiles && files.length > 0 && (
        <div className="selected-files">
          {files.map((file, index) => (
            <span key={`${file.name}-${file.lastModified}-${index}`}>
              <Paperclip size={12} /> {file.name} <small>{formatBytes(file.size)}</small>
              <button type="button" onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={t("removeFile", { filename: file.name })}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}

function SelectedFilePreviews({
  files,
  onFiles,
  startingNumbers = { image: 0, video: 0 },
}: {
  files: readonly File[];
  onFiles: (files: readonly File[]) => void;
  startingNumbers?: Readonly<Record<"image" | "video", number>>;
}) {
  const { t } = useI18n();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const previews = useMemo(() => {
    const nextNumber = { image: startingNumbers.image, video: startingNumbers.video };
    return files.map((file) => {
      const kind = mediaKindForFile(file);
      nextNumber[kind] += 1;
      return { file, kind, displayNumber: nextNumber[kind], url: URL.createObjectURL(file) };
    });
  }, [files, startingNumbers.image, startingNumbers.video]);

  useEffect(() => () => {
    for (const preview of previews) URL.revokeObjectURL(preview.url);
  }, [previews]);

  useEffect(() => {
    if (previewIndex !== null && previewIndex >= previews.length) setPreviewIndex(null);
  }, [previewIndex, previews.length]);

  const activePreview = previewIndex === null ? undefined : previews[previewIndex];
  return (
    <div className="selected-preview-section">
      <p>{t("selectedAttachments", { count: files.length })}</p>
      <div className="selected-preview-grid">
        {previews.map(({ file, url, kind, displayNumber }, index) => {
          const isImage = kind === "image";
          const isVideo = kind === "video";
          const referenceLabel = mediaNumberLabel(kind, displayNumber, t);
          return (
            <article className="selected-preview-card" key={`${file.name}-${file.size}-${file.lastModified}`}>
              <button type="button" className="selected-preview-media" onClick={() => setPreviewIndex(index)} aria-label={t("previewAttachment", { filename: file.name })}>
                <small className="media-number-badge">{referenceLabel}</small>
                {isImage && <img src={url} alt="" />}
                {isVideo && <video src={url} muted playsInline preload="metadata" />}
                <em>{t("preview")}</em>
              </button>
              <footer>
                <span><strong>{referenceLabel} · {file.name}</strong><small>{formatBytes(file.size)}</small></span>
                {isImage && isAnnotatableImage(file) && (
                  <button type="button" onClick={() => setAnnotatingIndex(index)} aria-label={t("annotateTitle")} title={t("annotate")}><Highlighter size={14} /></button>
                )}
                <button type="button" onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={t("removeFile", { filename: file.name })}><X size={14} /></button>
              </footer>
            </article>
          );
        })}
      </div>
      {activePreview && (
        <MediaLightbox
          title={`${mediaNumberLabel(activePreview.kind, activePreview.displayNumber, t)} · ${activePreview.file.name}`}
          onClose={() => setPreviewIndex(null)}
        >
          {activePreview.kind === "image" && <img src={activePreview.url} alt={activePreview.file.name} />}
          {activePreview.kind === "video" && <video src={activePreview.url} controls playsInline preload="metadata" />}
        </MediaLightbox>
      )}
      {annotatingIndex !== null && files[annotatingIndex] && (
        <ImageAnnotator
          file={files[annotatingIndex]}
          onCancel={() => setAnnotatingIndex(null)}
          onSave={(annotated) => {
            onFiles(files.map((current, fileIndex) => fileIndex === annotatingIndex ? annotated : current));
            setAnnotatingIndex(null);
          }}
        />
      )}
    </div>
  );
}

function EnvironmentCell({ field }: { field: EnvironmentField }) {
  const { t } = useI18n();
  const label = typeof field.label === "string" ? t(field.label) : field.label.raw;
  return <span><small>{label}</small>{field.code ? <code>{field.value}</code> : field.value}</span>;
}

function AttachmentSection({
  itemKey,
  attachments,
  title,
  emptyMessage,
}: {
  itemKey: string;
  attachments: readonly WorkItemAttachment[];
  title?: string;
  emptyMessage?: string;
}) {
  const { t } = useI18n();
  const mediaAttachments = attachments.filter(
    (attachment): attachment is MediaAttachment => isMediaAttachment(attachment),
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const openMedia = (attachmentId: string) => {
    const index = mediaAttachments.findIndex((attachment) => attachment.id === attachmentId);
    if (index >= 0) setActiveIndex(index);
  };
  return (
    <section className="attachment-block">
      <header>
        {/* No helper line: this is the detail view, where the files are already
            here. What can be attached is the form's to explain (AND-65). */}
        <div><h3>{title ?? t("attachments")}</h3></div>
      </header>
      {attachments.length === 0 ? <p className="section-empty">{emptyMessage ?? t("noAttachments")}</p> : (
        <div className="attachment-grid">
          {attachments.map((attachment) => <AttachmentCard key={attachment.id} itemKey={itemKey} attachment={attachment} onOpenMedia={openMedia} />)}
        </div>
      )}
      {activeIndex !== null && <ItemMediaGallery itemKey={itemKey} attachments={mediaAttachments} activeIndex={activeIndex} onIndexChange={setActiveIndex} onClose={() => setActiveIndex(null)} />}
    </section>
  );
}

function AttachmentCard({
  itemKey,
  attachment,
  onDelete,
  onReplaced,
  onOpenMedia,
  deleting = false,
  replacementFile,
  onStageReplacement,
}: {
  itemKey: string;
  attachment: WorkItemAttachment;
  onDelete?: ((attachmentId: string) => void) | undefined;
  onReplaced?: (() => void | Promise<void>) | undefined;
  onOpenMedia?: ((attachmentId: string) => void) | undefined;
  deleting?: boolean;
  replacementFile?: File | undefined;
  onStageReplacement?: ((id: string, file: File) => void) | undefined;
}) {
  const confirm = useConfirm();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [annotating, setAnnotating] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const [cardRef, isNearViewport] = useNearViewport<HTMLElement>("180px");
  const [previewRequested, setPreviewRequested] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const isImage = attachment.kind === "image";
  // An image previews from its thumbnail, fetched once the card nears the
  // viewport. The original is megabytes and served no-store, so it is only
  // fetched when someone opens it, annotates it or downloads it -- fetching it
  // for the card is what made a detail view with a few screenshots slow.
  const shouldLoad = previewRequested;
  const [thumbnailEdge, setThumbnailEdge] = useState<number | null>(null);
  useEffect(() => {
    if (!isImage || !isNearViewport || thumbnailEdge !== null) return;
    setThumbnailEdge(previewThumbnailEdge(cardRef.current?.clientWidth ?? 0, window.devicePixelRatio));
  }, [cardRef, isImage, isNearViewport, thumbnailEdge]);
  const thumbnailQuery = useQuery({
    queryKey: ["attachment-thumbnail", itemKey, attachment.id, attachment.revision, thumbnailEdge],
    queryFn: () => api.downloadAttachmentThumbnail(itemKey, attachment.id, thumbnailEdge!, attachment.revision),
    enabled: isImage && thumbnailEdge !== null,
    staleTime: Infinity,
  });
  const stagedUrl = useObjectUrl(replacementFile);
  const originalThumbnailUrl = useObjectUrl(thumbnailQuery.data);
  const thumbnailUrl = stagedUrl ?? originalThumbnailUrl;
  // A log and a text document are both read as text, and only their head is
  // worth fetching for a preview. A PDF is neither: it can only be downloaded.
  const readsAsText = attachment.kind === "log"
    || (attachment.kind === "document" && attachment.contentType !== "application/pdf");
  // An image is opened and annotated from its drawable copy -- for HEIC a JPEG
  // the server decoded, since only Safari can draw the original (C6).
  const drawable = drawableImageFile(attachment.filename, attachment.contentType);
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id, attachment.revision, isImage ? "drawable" : "original"],
    queryFn: () => isImage
      ? api.downloadAttachmentPreview(itemKey, attachment.id, attachment.revision)
      : api.downloadAttachment(
        itemKey,
        attachment.id,
        readsAsText ? { start: 0, end: 65_535 } : undefined,
      ),
    enabled: shouldLoad,
    staleTime: Infinity,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [logText, setLogText] = useState("");
  const referenceLabel = attachment.kind === "image" || attachment.kind === "video"
    ? mediaNumberLabel(attachment.kind, attachment.displayNumber, t)
    : null;

  useEffect(() => {
    if (!contentQuery.data) return undefined;
    if (readsAsText) {
      let active = true;
      void contentQuery.data.text().then((value) => {
        if (active) setLogText(value.slice(0, 4_000));
      });
      return () => { active = false; };
    }
    const url = URL.createObjectURL(contentQuery.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [contentQuery.data, readsAsText]);

  const download = async () => {
    // A download is always the original: for HEIC the loaded copy is the
    // decoded JPEG, which is not what was uploaded.
    const blob = readsAsText || drawsFromDecodedCopy(attachment.contentType)
      ? await api.downloadAttachment(itemKey, attachment.id)
      : contentQuery.data ?? await api.downloadAttachment(itemKey, attachment.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  // The annotator keys its object URL off this file, so it has to keep the same
  // identity across renders. A new File built inline would make that effect
  // re-run and revoke the URL the image is still loading from.
  const annotationSource = useMemo(
    () => replacementFile ?? (contentQuery.data ? new File([contentQuery.data], drawable.name, { type: drawable.type }) : null),
    [drawable.name, drawable.type, contentQuery.data, replacementFile],
  );

  const openImage = () => {
    if (onOpenMedia) {
      onOpenMedia(attachment.id);
      return;
    }
    setPreviewRequested(true);
    setViewerOpen(true);
  };

  // The annotator needs the original, which is fetched only now; the button
  // shows a spinner until it arrives and the annotator opens by itself.
  const startAnnotating = () => {
    setReplaceError("");
    setPreviewRequested(true);
    setAnnotating(true);
    if (contentQuery.isError) void contentQuery.refetch();
  };
  const annotationLoadFailed = annotating && !annotationSource && contentQuery.isError && !contentQuery.isFetching;
  useEffect(() => {
    if (!annotationLoadFailed) return;
    setAnnotating(false);
    setReplaceError(t("attachmentFailed"));
  }, [annotationLoadFailed, t]);

  const saveAnnotation = async (annotated: File) => {
    setReplacing(true);
    setReplaceError("");
    try {
      if (onStageReplacement) {
        onStageReplacement(attachment.id, annotated);
        setAnnotating(false);
        return;
      }
      await api.replaceAttachment(itemKey, attachment.id, annotated);
      // The cached blob is keyed by attachment id and never goes stale on its
      // own, so drop it or the card keeps showing the image before the marks.
      queryClient.removeQueries({ queryKey: ["attachment-content", itemKey, attachment.id] });
      queryClient.removeQueries({ queryKey: ["attachment-thumbnail", itemKey, attachment.id] });
      setAnnotating(false);
      await onReplaced?.();
    } catch (error) {
      setReplaceError(errorMessage(error, t("annotateSaveFailed")));
    } finally {
      setReplacing(false);
    }
  };

  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "video" ? Video : attachment.kind === "archive" ? Archive : FileText;
  return (
    <article ref={cardRef} className={`attachment-card attachment-${attachment.kind}`}>
      <div className="attachment-preview">
        {referenceLabel && <small className="media-number-badge">{referenceLabel}</small>}
        {!shouldLoad && attachment.kind !== "image" && attachment.kind !== "archive" && (
          <button type="button" className="attachment-load-button" onClick={() => setPreviewRequested(true)}>
            <Icon size={22} /> {t("loadPreview")}
          </button>
        )}
        {attachment.kind === "archive" && <span><Archive size={22} /> ZIP</span>}
        {isImage && !thumbnailUrl && !thumbnailQuery.isLoading && !thumbnailQuery.isError && <span><ImageIcon size={22} /></span>}
        {isImage && thumbnailQuery.isLoading && <span><LoaderCircle className="spin" size={18} /> {t("attachmentLoading")}</span>}
        {isImage && thumbnailQuery.isError && <button type="button" className="attachment-load-button attachment-error" onClick={() => void thumbnailQuery.refetch()}>{t("retryAttachment")}</button>}
        {!isImage && contentQuery.isLoading && <span><LoaderCircle className="spin" size={18} /> {t("attachmentLoading")}</span>}
        {!isImage && contentQuery.isError && <button type="button" className="attachment-load-button attachment-error" onClick={() => void contentQuery.refetch()}>{t("retryAttachment")}</button>}
        {isImage && thumbnailUrl && (
          <button type="button" className="attachment-media-open" onClick={openImage} aria-label={t("previewAttachment", { filename: attachment.filename })}>
            <img src={thumbnailUrl} alt={attachment.filename} decoding="async" />
            <span><Maximize2 size={15} /> {t("preview")}</span>
          </button>
        )}
        {attachment.kind === "video" && objectUrl && (
          <div className="attachment-video-preview">
            <PlayableVideo src={objectUrl} autoPlay={false} playsInline={false} onDownload={() => void download()} />
            <button type="button" onClick={() => onOpenMedia ? onOpenMedia(attachment.id) : setViewerOpen(true)} aria-label={t("previewAttachment", { filename: attachment.filename })} title={t("preview")}><Maximize2 size={16} /></button>
          </div>
        )}
        {readsAsText && logText && <pre>{logText}</pre>}
      </div>
      <footer>
        <Icon size={15} />
        <span><strong>{referenceLabel ? `${referenceLabel} · ` : ""}{attachment.filename}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span>
        <span className="attachment-actions">
          <button type="button" onClick={() => void download()} aria-label={`${t("download")} ${attachment.filename}`} title={t("download")}><Download size={15} /></button>
          {(onReplaced || onStageReplacement) && attachment.kind === "image" && isAnnotatableImage(drawable) && (
            <button
              type="button"
              disabled={replacing || (annotating && !annotationSource)}
              onClick={startAnnotating}
              aria-label={t("annotateTitle")}
              title={t("annotate")}
            >{replacing || (annotating && !annotationSource) ? <LoaderCircle className="spin" size={15} /> : <Highlighter size={15} />}</button>
          )}
          {onDelete && <button
            type="button"
            disabled={deleting}
            onClick={async () => { if (await confirm(t("confirmDeleteAttachment", { filename: attachment.filename }))) onDelete(attachment.id); }}
            aria-label={t("deleteAttachment", { filename: attachment.filename })}
            title={t("delete")}
          >{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>}
        </span>
      </footer>
      {replacementFile && <p role="status" className="account-note">{t("stagedAnnotation")}</p>}
      {replaceError && <InlineError message={replaceError} />}
      {annotating && annotationSource && (
        <ImageAnnotator
          staged={Boolean(onStageReplacement)}
          file={annotationSource}
          onCancel={() => setAnnotating(false)}
          onSave={saveAnnotation}
        />
      )}
      {viewerOpen && (objectUrl || isImage) && attachment.kind !== "log" && (
        <MediaLightbox title={`${referenceLabel} · ${attachment.filename}`} onClose={() => setViewerOpen(false)}>
          {isImage && contentQuery.isLoading && <div className="media-viewer-loading"><LoaderCircle className="spin" size={22} /> {t("attachmentLoading")}</div>}
          {isImage && contentQuery.isError && <div className="media-viewer-loading attachment-error">{t("attachmentFailed")}</div>}
          {isImage && (stagedUrl || objectUrl) && <img src={stagedUrl ?? objectUrl!} alt={attachment.filename} />}
          {attachment.kind === "video" && objectUrl && <PlayableVideo src={objectUrl} autoPlay onDownload={() => void download()} />}
        </MediaLightbox>
      )}
    </article>
  );
}

/** An uploaded icon replaces the generated badge; removing it brings the badge back. */
function ProductIconField({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const preview = useObjectUrl(file ?? undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (file: File | null) => file ? api.setProductIcon(product.id, file) : api.removeProductIcon(product.id),
    onSuccess: async () => {
      setEditing(false);
      setFile(null);
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (mutationError) => setError(errorMessage(mutationError, t("somethingWentWrong"))),
  });


  return (
    <div className="product-icon-field">
      <ProductBadge product={product} size={48} />
      <div>
        <strong>{t("productIcon")}</strong>
        <small>{t("productIconHelp")}</small>
        <div className="product-icon-actions">
          <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => { setFile(null); setError(""); setEditing(true); }}>
            {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <ImageIcon size={15} />} {product.hasIcon ? t("replaceIcon") : t("uploadIcon")}
          </button>
          {product.hasIcon && (
            <button type="button" className="text-button" disabled={mutation.isPending} onClick={() => { setFile(null); setError(""); setEditing(true); }}>
              {t("useGeneratedIcon")}
            </button>
          )}
        </div>
        {error && <InlineError message={error} />}
      </div>
      <small className="account-note">{t("iconSavedImmediately")}</small>
      {editing && <Modal title={t("productIcon")} subtitle={product.name} onClose={() => setEditing(false)} dirty={Boolean(file)} pending={mutation.isPending}>
        <div className="dialog-form">
          {preview ? <img className="product-icon-draft" src={preview} alt={t("productIcon")} /> : <p className="account-note">{t("useGeneratedIcon")}</p>}
          <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => inputRef.current?.click()}>{t("uploadIcon")}</button>
          {error && <InlineError message={error} />}
          <div className="form-footer"><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => setEditing(false)}>{t("cancel")}</button><button type="button" className="primary-button" disabled={mutation.isPending || !file && !product.hasIcon} onClick={() => mutation.mutate(file)}>{t("save")}</button></div>
        </div>
      </Modal>}
      <input
        ref={inputRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) setFile(file);
        }}
      />
    </div>
  );
}

function ProductSettings({
  section,
  product,
  user,
  onSelected,
  componentId,
  onOpenComponent,
}: {
  product: Product;
  user?: AuthenticatedUser;
  onSelected: () => void;
  section: ProductSettingsSection;
  componentId?: string | undefined;
  onOpenComponent: (id: string) => void;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const activeSettingsTab = section;
  const [name, setName] = useState(product.name);
  // Retiring a product retires it for everyone who shares it, and deciding who
  // else reaches it is the same call, so both come from one judgement that
  // matches the server's. The server refuses either way; this only keeps a
  // control from offering something that will come back 403.
  const mayAdminister = user !== undefined && mayAdministerProduct(user, product);
  // Unknown user means the session is still loading. A button is better drawn
  // hopefully and refused than flickering disabled; a tab is better withheld
  // than shown and then failing to load, so the two differ here on purpose.
  const mayArchive = !user || mayAdminister || !product.createdByAccountId;
  const canOperate = user?.role === "admin" || product.access?.canOperate === true;
  const [newComponentName, setNewComponentName] = useState("");
  const [newComponentKind, setNewComponentKind] = useState<ComponentKind>("android");
  const [addingComponent, setAddingComponent] = useState(false);
  const componentsQuery = useQuery({
    queryKey: ["components", product.id, "with-archived"],
    queryFn: () => api.listComponents(product.id, { includeArchived: true }),
    enabled: activeSettingsTab === "components",
  });
  const components = componentsQuery.data ?? [];

  const closeComponentForm = () => {
    setAddingComponent(false);
    setNewComponentName("");
    setNewComponentKind("android");
  };

  useEffect(() => setName(product.name), [product.id, product.name]);

  const productMutation = useMutation({
    mutationFn: () => api.updateProduct(product.id, { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      onSelected();
    },
  });
  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) => api.updateProduct(product.id, { archived }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });
  const componentMutation = useMutation({
    mutationFn: () => api.createComponent(product.id, {
      name: newComponentName,
      kind: newComponentKind,
    }),
    onSuccess: async () => {
      closeComponentForm();
      await queryClient.invalidateQueries({ queryKey: ["components", product.id] });
    },
  });

  useSettingsDraft(name !== product.name, productMutation.isPending || archiveMutation.isPending);

  return (
    <div className="product-settings">
      {!canOperate && <p className="account-note">{t("settingsProductReadOnly")}</p>}
      <fieldset className="settings-product-fields" disabled={!canOperate && activeSettingsTab !== "components"}>
      {activeSettingsTab === "tokens" ? (
        <SdkTokenSettings product={product} />
      ) : activeSettingsTab === "product" ? (
        <section className="product-settings-section" role="tabpanel">
          <header><div><h3>{t("settingsBasicDetails")}</h3></div></header>
          <div className="product-settings-grid">
            <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{t("itemPrefix")}<input value={product.keyPrefix} readOnly /><small>{t("prefixLockedHelp")}</small></label>
          </div>
          <ProductIconField product={product} />
          {productMutation.isError && <InlineError message={errorMessage(productMutation.error, t("somethingWentWrong"))} />}
          {archiveMutation.isError && <InlineError message={errorMessage(archiveMutation.error, t("somethingWentWrong"))} />}
          <div className="settings-form-footer">
          {productMutation.isSuccess && name === product.name && <span className="settings-save-note" role="status">{t("permissionsSaved")}</span>}
          <button type="button" className="secondary-button" disabled={productMutation.isPending || name === product.name} onClick={() => setName(product.name)}>{t("cancel")}</button>
          <button className="primary-button settings-save" disabled={!name.trim() || name.trim() === product.name || productMutation.isPending} onClick={() => productMutation.mutate()}>
            {productMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {t("saveProduct")}
          </button>
          </div>
          <div className="archive-row">
            <p>{mayArchive ? t("archiveProductHelp") : t("archiveNotOwner")}</p>
            <button
              type="button"
              className="secondary-button archive-button"
              disabled={archiveMutation.isPending || !mayArchive}
              onClick={async () => {
                if (product.archivedAt) archiveMutation.mutate(false);
                else if (await confirm(t("confirmArchiveProduct", { name: product.name }))) archiveMutation.mutate(true);
              }}
            >
              {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
              {product.archivedAt ? t("restore") : t("archive")}
            </button>
          </div>
        </section>
      ) : activeSettingsTab === "artifacts" ? (
        <ReleaseArtifactsSettings product={product} />
      ) : (
        <section className="product-settings-section component-management" role="tabpanel">
          <header>
            <div><p className="eyebrow">{t("productComponents")}</p><h3>{t("moduleManagement")}</h3></div>
            <div className="component-header-actions">
              <span>{componentsQuery.data?.length ?? 0}</span>
              {!componentId && (componentsQuery.data?.length ?? 0) > 0 && (
                <button className="primary-button component-add-trigger" disabled={!canOperate} onClick={() => setAddingComponent(true)}><Plus size={15} /> {t("newComponent")}</button>
              )}
            </div>
          </header>
          <p className="component-management-help">{t("componentManagementHelp")}</p>
          {componentsQuery.isError && <InlineError message={errorMessage(componentsQuery.error, t("somethingWentWrong"))} />}
          <div className="component-manager-list">
            {componentId ? components.find(component => component.id === componentId) ? <fieldset className="settings-product-fields" disabled={!canOperate}><ComponentSettingsRow component={components.find(component => component.id === componentId)!} /></fieldset>
              : !componentsQuery.isLoading && <p role="alert">{t("settingsUnavailable")}</p>
              : components.map(component => <button type="button" key={component.id} className="settings-hub-row" onClick={() => onOpenComponent(component.id)}><span><strong>{component.name}</strong><small>{t(component.kind)}{component.archivedAt ? ` · ${t("archived")}` : ""}</small></span><ChevronRight size={18} /></button>)}
            {!componentId && !componentsQuery.isLoading && components.length === 0 && !addingComponent && <div className="component-empty-state"><button className="primary-button" disabled={!canOperate} onClick={() => setAddingComponent(true)}><Plus size={17} /> {t("newComponent")}</button></div>}
          </div>
          {addingComponent && (
            <Modal title={t("newComponent")} subtitle={product.name} onClose={closeComponentForm} dirty={Boolean(newComponentName || newComponentKind !== "android")} pending={componentMutation.isPending}>
            <form className="dialog-form" onSubmit={event => { event.preventDefault(); if (newComponentName.trim() && !componentMutation.isPending) componentMutation.mutate(); }}>
              <div className="dialog-fields">
                <label>{t("componentName")}<input value={newComponentName} onChange={(event) => setNewComponentName(event.target.value)} placeholder={t("componentNamePlaceholder")} autoFocus /></label>
                <label>{t("componentKind")}<Select value={newComponentKind} onChange={(event) => setNewComponentKind(event.target.value as ComponentKind)}>{COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</Select></label>
                <div className="form-footer"><button type="button" className="secondary-button" disabled={componentMutation.isPending} onClick={closeComponentForm}>{t("cancel")}</button>
                <button type="submit" className="primary-button" disabled={!newComponentName.trim() || componentMutation.isPending}>
                  {componentMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createComponent")}
                </button></div>
              </div>
              {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
            </form>
            </Modal>
          )}
          {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
        </section>
      )}
      </fieldset>
    </div>
  );
}

/** Read-only inventory recorded by development and release handovers. */
function ReleaseArtifactsSettings({ product }: { product: Product }) {
  const { t } = useI18n();
  return (
    <section className="product-settings-section release-artifacts-settings" role="tabpanel">
      <header><div><h3>{t("releaseArtifacts")}</h3></div></header>
      <p className="component-management-help">{t("releaseArtifactsHelp")}</p>
      {product.releaseArtifacts.length ? <div className="release-artifact-list">
        {product.releaseArtifacts.map((artifact) => (
          <div key={artifact} className="release-artifact-row"><code>{artifact}</code></div>
        ))}
      </div> : <p className="settings-save-note" role="status">{t("releaseArtifactsEmpty")}</p>}
    </section>
  );
}

function SdkTokenSettings({ product }: { product: Product }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { formatTime, t } = useI18n();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [sourceComponentId, setSourceComponentId] = useState("");
  // Shown once, held only in memory: the server never hands it back again.
  const [createdToken, setCreatedToken] = useState<CreatedSdkToken | null>(null);
  const [copied, setCopied] = useState(false);

  const tokensQuery = useQuery({ queryKey: ["sdk-tokens"], queryFn: api.listSdkTokens });
  const componentsQuery = useQuery({ queryKey: ["components", product.id], queryFn: () => api.listComponents(product.id) });
  const androidComponents = (componentsQuery.data ?? []).filter((component) => component.kind === "android");
  const tokens = (tokensQuery.data ?? []).filter((token) => token.productId === product.id);

  const createMutation = useMutation({
    mutationFn: () => api.createSdkToken({
      name: name.trim(),
      productId: product.id,
      ...(sourceComponentId ? { sourceComponentId } : {}),
    }),
    onSuccess: async (token) => {
      setCreatedToken(token);
      setCopied(false);

      setName("");
      setSourceComponentId("");
      await queryClient.invalidateQueries({ queryKey: ["sdk-tokens"] });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => api.revokeSdkToken(tokenId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["sdk-tokens"] }),
  });

  useSettingsDraft(false, revokeMutation.isPending);

  const closeToken = () => { if (createMutation.isPending) return; setCreating(false); setName(""); setSourceComponentId(""); setCreatedToken(null); createMutation.reset(); };

  const copyToken = async () => {
    if (!createdToken) return;
    try { await navigator.clipboard.writeText(createdToken.token); setCopied(true); } catch { /* The token remains selectable for manual copying. */ }
  };

  return (
    <section className="product-settings-section" role="tabpanel">
      <header>
        <div><h3>{t("sdkTokens")}</h3></div>
        <div className="component-header-actions"><span>{tokens.filter((token) => !token.revokedAt).length}</span><button type="button" className="primary-button" onClick={() => { setCreatedToken(null); createMutation.reset(); setCreating(true); }} disabled={creating}>{t("newSdkToken")}</button></div>
      </header>
      <p className="account-note">{t("settingsSdkScopeHelp")}</p>
      <p className="component-management-help">{t("sdkTokensHelp")}</p>

      {creating && <Modal title={t(createdToken ? "sdkTokenCreated" : "newSdkToken")} subtitle={product.name} onClose={closeToken} closeWarning={createdToken ? t("closeTokenWarning") : undefined} dirty={!createdToken && Boolean(name || sourceComponentId)} pending={createMutation.isPending}>
      {createdToken && (
        <div className="sdk-token-reveal">
          <p><KeyRound size={15} /> {t("sdkTokenCreated")}</p>
          <div>
            <code>{createdToken.token}</code>
            <button type="button" className="secondary-button" onClick={() => void copyToken()}>
              {copied ? <Check size={15} /> : <ClipboardCheck size={15} />} {copied ? t("copied") : t("copyToken")}
            </button>
          </div>
        </div>
      )}

      {!createdToken && <form className="dialog-form" onSubmit={event => { event.preventDefault(); if (name.trim() && !createMutation.isPending) createMutation.mutate(); }}>
        <div className="dialog-fields">
          <label>{t("sdkTokenName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("sdkTokenNamePlaceholder")} maxLength={100} /></label>
          <label>{t("sdkTokenScope")}
            <Select value={sourceComponentId} onChange={(event) => setSourceComponentId(event.target.value)}>
              <option value="">{t("sdkTokenAnyModule")}</option>
              {androidComponents.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
            </Select>
          </label>

        </div>
        {androidComponents.length === 0 && <p className="section-empty">{t("sdkTokenNeedsAndroidModule")}</p>}
        <div className="form-footer"><button type="button" className="secondary-button" disabled={createMutation.isPending} onClick={closeToken}>{t("cancel")}</button>          <button type="submit" className="primary-button" disabled={!name.trim() || createMutation.isPending}>
            {createMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createSdkToken")}
          </button></div>
      </form>}
        {createMutation.isError && <InlineError message={errorMessage(createMutation.error, t("somethingWentWrong"))} />}
        {createdToken && <div className="form-footer"><button type="button" className="primary-button" onClick={closeToken}>{t("tokenCopiedDone")}</button></div>}
      </Modal>}
      {createMutation.isError && <InlineError message={errorMessage(createMutation.error, t("somethingWentWrong"))} />}
      {revokeMutation.isError && <InlineError message={errorMessage(revokeMutation.error, t("somethingWentWrong"))} />}

      <div className="sdk-token-list">
        {!tokensQuery.isLoading && tokens.length === 0 && <p className="section-empty">{t("noSdkTokens")}</p>}
        {tokens.map((token) => (
          <div key={token.id} className={`sdk-token-row ${token.revokedAt ? "revoked" : ""}`}>
            <span>
              <strong>{token.name}</strong>
              <small>
                {token.revokedAt
                  ? t("revoked")
                  : token.lastUsedAt
                    ? t("lastUsed", { time: formatTime(token.lastUsedAt) })
                    : t("neverUsed")}
                {token.sourceComponentId && ` · ${androidComponents.find((component) => component.id === token.sourceComponentId)?.name ?? ""}`}
              </small>
            </span>
            {!token.revokedAt && (
              <button
                type="button"
                className="secondary-button sdk-token-revoke"
                disabled={revokeMutation.isPending}
                onClick={async () => {
                  if (await confirm(t("confirmRevokeToken", { name: token.name }))) revokeMutation.mutate(token.id);
                }}
              >
                <Trash2 size={14} /> {t("revoke")}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ComponentSettingsRow({ component }: { component: Component }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [name, setName] = useState(component.name);
  const [kind, setKind] = useState<ComponentKind>(component.kind);
  const archived = Boolean(component.archivedAt);
  useEffect(() => {
    setName(component.name);
    setKind(component.kind);
  }, [component.kind, component.name]);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["components", component.productId] });
  };
  const mutation = useMutation({
    mutationFn: () => api.updateComponent(component.productId, component.id, { name, kind }),
    onSuccess: refresh,
  });
  const archiveMutation = useMutation({
    mutationFn: (next: boolean) => api.updateComponent(component.productId, component.id, { archived: next }),
    onSuccess: refresh,
  });
  const changed = name.trim() !== component.name || kind !== component.kind;
  useSettingsDraft(changed, mutation.isPending || archiveMutation.isPending);
  return (
    <div className={`component-settings-row ${archived ? "archived" : ""}`}>
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("componentName")} disabled={archived} />
      <Select value={kind} onChange={(event) => setKind(event.target.value as ComponentKind)} aria-label={t("componentKind")} disabled={archived}>
        {COMPONENT_KINDS.map((value) => <option key={value} value={value}>{t(value)}</option>)}
      </Select>
      {archived ? (
        <button className="secondary-button" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate(false)}>
          {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />} {t("restore")}
        </button>
      ) : changed ? (
        <div className="inline-form-actions"><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => { setName(component.name); setKind(component.kind); mutation.reset(); }}>{t("cancel")}</button>
        <button className="primary-button" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
        </button></div>
      ) : (
        <button
          className="secondary-button archive-button"
          disabled={archiveMutation.isPending}
          onClick={async () => {
            if (await confirm(t("confirmArchiveComponent", { name: component.name }))) archiveMutation.mutate(true);
          }}
        >
          {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />} {t("archive")}
        </button>
      )}
      <ModuleBuilderSetting component={component} />
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      {archiveMutation.isError && <InlineError message={errorMessage(archiveMutation.error, t("somethingWentWrong"))} />}
    </div>
  );
}

function ProductForm({ onCreated }: { onCreated: (product: Product) => void | Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [keyPrefix, setKeyPrefix] = useState("");
  const mutation = useMutation({ mutationFn: api.createProduct, onSuccess: onCreated });
  useSettingsDraft(Boolean(name || keyPrefix), mutation.isPending);
  return (
    <form className="product-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate({ name, keyPrefix }); }}>
      <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Hermes Go" required autoFocus /></label>
      <label>{t("itemPrefix")}<input value={keyPrefix} onChange={(event) => setKeyPrefix(event.target.value.toUpperCase())} placeholder="HG" minLength={2} maxLength={10} required /><small>{t("prefixHelp")}</small></label>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <button className="primary-button wide" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {t("addProduct")}</button>
    </form>
  );
}


function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => unknown }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="secondary-button refresh-button"
      disabled={refreshing}
      onClick={() => void onRefresh()}
      aria-label={t("refresh")}
      title={t("refresh")}
    >
      <RefreshCw className={refreshing ? "spin" : undefined} size={16} />
    </button>
  );
}

/**
 * Confirming a bulk verification close (AND-66). Closing is the last word on an
 * item, so the list of what is about to close is shown before it happens.
 */
function BulkVerifyDialog({ items, onClose, onDone }: {
  readonly items: readonly WorkItem[];
  readonly onClose: () => void;
  readonly onDone: (results: readonly BulkTransitionResult[]) => void;
}) {
  const { t } = useI18n();
  const mutation = useMutation({
    mutationFn: () => api.closeVerifications(items.map((item) => item.key)),
    onSuccess: (response) => onDone(response.results),
  });
  useDialogDraft(false, mutation.isPending);

  return (
    <div className="bulk-verify">
      <p className="dispatch-note">{t("verifySelectedHelp")}</p>
      <ul className="bulk-verify-list">
        {items.map((item) => <li key={item.key}><code>{item.key}</code> {item.title}</li>)}
      </ul>
      {mutation.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{errorMessage(mutation.error, t("somethingWentWrong"))}</span></div>
      )}
      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onClose}>{t("cancel")}</button>
        <button
          type="button"
          className="primary-button positive"
          data-initial-focus
          disabled={mutation.isPending || items.length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}
          {t("verifySelected", { count: items.length })}
        </button>
      </div>
    </div>
  );
}

/**
 * Returning a batch of in-progress work to ready (AND-160). The domain demands
 * a note on that edge; one note explains the undo, so it is asked once and
 * stamped on every item in the batch.
 */
function BulkReleaseDialog({ items, onClose, onDone }: {
  readonly items: readonly WorkItem[];
  readonly onClose: () => void;
  readonly onDone: (results: readonly BulkTransitionResult[]) => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: () => api.releaseItems(items.map((item) => item.key), note.trim()),
    onSuccess: (response) => onDone(response.results),
  });
  useDialogDraft(Boolean(note), mutation.isPending);

  return (
    <form
      className="bulk-verify"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim()) mutation.mutate();
      }}
    >
      <p className="dispatch-note">{t("releaseSelectedHelp")}</p>
      <ul className="bulk-verify-list">
        {items.map((item) => <li key={item.key}><code>{item.key}</code> {item.title}</li>)}
      </ul>
      <label>
        {t("releaseNoteLabel")}
        <textarea
          data-initial-focus
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("releaseNotePlaceholder")}
          maxLength={TRANSITION_NOTE_MAX_LENGTH}
          required
        />
      </label>
      {mutation.isError && (
        <div className="inline-error"><CirclePause size={16} /><span>{errorMessage(mutation.error, t("somethingWentWrong"))}</span></div>
      )}
      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onClose}>{t("cancel")}</button>
        <button
          type="submit"
          className="primary-button"
          disabled={!note.trim() || mutation.isPending || items.length === 0}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Undo2 size={16} />}
          {t("releaseSelected", { count: items.length })}
        </button>
      </div>
    </form>
  );
}


/**
 * A video, or -- when this browser cannot decode it -- a plain statement that it
 * cannot, with the way out. An iPhone records HEVC in a .mov, which Firefox and
 * some Chrome builds on Windows cannot play; the <video> element then sat as an
 * empty black box with a greyed-out play button and no explanation (C6).
 */
function PlayableVideo({
  src,
  autoPlay,
  playsInline = true,
  onDownload,
}: {
  src: string;
  autoPlay: boolean;
  playsInline?: boolean;
  onDownload?: () => void;
}) {
  const { t } = useI18n();
  const [unplayable, setUnplayable] = useState(false);
  useEffect(() => setUnplayable(false), [src]);
  if (unplayable) {
    return (
      <div className="video-unplayable" role="status">
        <p>{t("videoUnplayable")}</p>
        {onDownload && (
          <button type="button" className="secondary-button" onClick={onDownload}>
            <Download size={15} /> {t("download")}
          </button>
        )}
      </div>
    );
  }
  return (
    <video
      src={src}
      controls
      autoPlay={autoPlay}
      playsInline={playsInline}
      preload="metadata"
      // A format the browser has no decoder for fails here, on the element, and
      // only here: the network request itself succeeded.
      onError={() => setUnplayable(true)}
    />
  );
}

function MediaLightbox({
  title,
  onClose,
  onPrevious,
  onNext,
  showNavigation = false,
  children,
}: {
  title: string;
  onClose: () => void;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  showNavigation?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="selected-media-lightbox"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!showNavigation || event.target instanceof HTMLVideoElement) return;
        const navigate = event.key === "ArrowLeft" ? onPrevious : event.key === "ArrowRight" ? onNext : undefined;
        if (navigate) {
          event.preventDefault();
          navigate();
        }
      }}
      onTouchStart={(event) => {
        if (!showNavigation || event.touches.length !== 1) return;
        touchStart.current = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY };
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || !showNavigation || event.changedTouches.length !== 1) return;
        const dx = event.changedTouches[0]!.clientX - start.x;
        const dy = event.changedTouches[0]!.clientY - start.y;
        if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        (dx > 0 ? onPrevious : onNext)?.();
      }}
    >
      <section>
        <header>
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label={t("closePreview")}><X size={20} /></button>
        </header>
        {showNavigation ? (
          <div className="media-gallery-stage">
            {children}
            <button type="button" className="media-gallery-nav previous" disabled={!onPrevious} onClick={onPrevious} aria-label={t("previousMedia")}><ChevronLeft size={24} /></button>
            <button type="button" className="media-gallery-nav next" disabled={!onNext} onClick={onNext} aria-label={t("nextMedia")}><ChevronRight size={24} /></button>
          </div>
        ) : children}
      </section>
    </dialog>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="inline-error"><CirclePause size={16} /><span>{message}</span></div>;
}

function ListSkeleton() {
  const { t } = useI18n();
  return <div className="skeleton-list" aria-label={t("loadingItems")}>{[0, 1, 2, 3].map((value) => <div className="skeleton-row" key={value}><i /><span /><small /></div>)}</div>;
}
