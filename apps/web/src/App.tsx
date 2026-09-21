import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type Dispatch as ReactDispatch, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction, type TextareaHTMLAttributes } from "react";
import { useInfiniteQuery, useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Archive,
  ArrowRight,
  Bot,
  Bug,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CirclePause,
  ClipboardCheck,
  Download,
  FileText,
  Filter,
  Highlighter,
  ImageIcon,
  Inbox,
  KeyRound,
  Languages,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Video,
  WifiOff,
  X,
} from "lucide-react";

import { api, ApiError, productIconUrl, type AuthSession, type AuthenticatedUser, type BulkTransitionResult } from "./api";
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
import {
  MAX_DIAGNOSTIC_LOG_BYTES,
  collectWebContext,
  diagnosticLogBytes,
  diagnosticLogFile,
} from "./diagnostics";
import {
  COMPONENT_KINDS,
  ITEM_PRIORITIES,
  ITEM_STATUSES,
  ITEM_TYPES,
  type Product,
  type Component,
  type ComponentKind,
  type CreatedSdkToken,
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
import { AccountSettings, ProductAccessSettings } from "./account-settings";
import { mayAdministerProduct } from "./product-permissions";
import { NodeSettings } from "./node-settings";
import { parseFeedbackLog, transitionRequiresNote } from "@missiongo/domain";
import { statusChangeNote, dispatchedEvent, groupTimeline } from "./timeline";
import { TransitionNoteDialog, transitionNoteCopy } from "./transition-note-dialog";
import { VerificationReturnBadge, VerificationReturnCallout, VerificationReturnSummary } from "./verification-return";
import { StartWorkDialog } from "./start-work-dialog";
import { cachedListSummary } from "./list-summary";
import { useUnsavedChangesGuard } from "./unsaved-changes";
import { manualMoves, TRANSITIONS } from "./work-item-transitions";
import {
  creatorLabel,
  COMMENT_COLLAPSE_THRESHOLD,
  commentAuthor,
  commentPlainText,
  deriveSummary,
  eventAgentName,
} from "./comment-summary";
import { isAnnotatableImage } from "./image-annotation";
import { LIST_THUMBNAIL_EDGE, previewThumbnailEdge } from "./attachment-thumbnail";
import { MarkdownText } from "./markdown-text";
import {
  AGENT_CONSOLE_HISTORY_MARKER,
  AGENT_CONSOLE_LAYOUT_KEY,
  AGENT_CONVERSATION_HISTORY_MARKER,
  DEFAULT_STATUS,
  ITEM_HISTORY_MARKER,
  OVERLAY_HISTORY_MARKER,
  SIDEBAR_HISTORY_MARKER,
  agentConsoleExitUrl,
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
import { productBadgeColor } from "./product-color";
import { SessionLink } from "./session-link";
import { AgentSessionPanel } from "./agent-session-panel";
import { AgentSessionConsole } from "./agent-session-console";
import { agentAttentionCounts } from "./agent-session-view";
import { registerMissionGoWebMcp } from "./webmcp";

const STATUS_ICONS: Record<WorkItemStatus, typeof Inbox> = {
  inbox: Inbox,
  ready: CircleDot,
  in_progress: Rocket,
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
const DOCUMENT_FILE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "pdf"]);
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

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  const maximumHeight = 480;
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maximumHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
}

function AutoGrowTextarea({ className, onInput, value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      className={`auto-grow-textarea ${className ?? ""}`.trim()}
      value={value}
      onInput={(event) => {
        resizeTextarea(event.currentTarget);
        onInput?.(event);
      }}
    />
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

export function App() {
  const queryClient = useQueryClient();
  const { statusLabel, t, typeLabel } = useI18n();
  const initialFilters = useRef(filtersFromUrl()).current;
  const [selectedProductId, setSelectedProductId] = useState(
    () => initialFilters.productId || localStorage.getItem("missiongo.product") || "",
  );
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(() => itemKeyFromUrl());
  const [detailOpenInEdit, setDetailOpenInEdit] = useState(false);
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "all">(initialFilters.status);
  const [typeFilter, setTypeFilter] = useState<WorkItemType | "all">(initialFilters.type);
  const [search, setSearch] = useState(initialFilters.search);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentConsoleOpen, setAgentConsoleOpen] = useState(agentConsoleIsOpen);
  const [agentSessionId, setAgentSessionId] = useState<string | null>(agentSessionIdFromUrl);
  const [agentConversationOpen, setAgentConversationOpen] = useState(
    () => Boolean(history.state?.[AGENT_CONVERSATION_HISTORY_MARKER]),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [startWorkItem, setStartWorkItem] = useState<WorkItem | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const listScrollTopRef = useRef(0);
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

  const openAgentConsole = () => {
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

  const openItemFromAgentConsole = (itemKey: string) => {
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
    setAgentConsoleOpen(false);
    setAgentSessionId(null);
    setAgentConversationOpen(false);
    openItemPage(itemKey);
  };

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
      // The overlay entry carries no URL of its own, so the marker on the state
      // is what says whether the sheet is still the top of the stack.
      syncBackDepth();
      if (!history.state?.[OVERLAY_HISTORY_MARKER]) setCaptureOpen(false);
      if (!history.state?.[SIDEBAR_HISTORY_MARKER]) setSidebarOpen(false);
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
    const deepLinkedConsole = agentConsoleIsOpen();
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
    const deepLinkedItem = itemKeyFromUrl();
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
            limit: ITEM_PAGE_SIZE,
          },
        );
      } catch (error) {
        // A refused session means the screen cached on this device belongs to
        // someone who is no longer signed in here. Evict the restored queries as
        // well as the copy on disk: clearing only the disk leaves them in memory,
        // where the persistence subscription promptly writes them back out.
        if (error instanceof ApiError && error.status === 401) {
          for (const key of ["products", "items", "components"]) {
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
          ["items", data.productId, initialFilters.status, initialFilters.type, initialFilters.search.trim()],
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
  const hasAnyAiPermission = products.some(productAllowsAi);
  // One all-product feed drives every attention badge as well as the selected
  // product's console. Product switching is then a local filter, not another
  // request, and the header counts keep updating while the console is closed.
  const agentSessionsQuery = useQuery({
    queryKey: ["agent-sessions"],
    queryFn: () => api.listAgentSessions(),
    enabled: bootstrapQuery.isSuccess && hasAnyAiPermission,
    refetchInterval: 5_000,
  });
  const allAgentSessions = agentSessionsQuery.data?.sessions ?? [];
  const attentionCounts = useMemo(() => agentAttentionCounts(allAgentSessions), [allAgentSessions]);

  useEffect(() => {
    if (products.length === 0 || hasAnyAiPermission || !agentConsoleOpen) return;
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
  }, [agentConsoleOpen, hasAnyAiPermission, products.length]);

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
    if (!selectedProductId) return;
    const next = filtersToUrl({ productId: selectedProductId, status: statusFilter, type: typeFilter, search });
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      history.replaceState(history.state, "", next);
    }
  }, [search, selectedProductId, statusFilter, typeFilter]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const deferredSearch = useDeferredValue(search.trim());
  const itemsQuery = useInfiniteQuery({
    queryKey: ["items", selectedProductId, statusFilter, typeFilter, deferredSearch],
    queryFn: ({ pageParam }) => api.listItems(selectedProductId, {
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
      { productId: selectedProductId, type: typeFilter, search: deferredSearch },
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
  const listScope = selectionScope({
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
  }, [items, queryClient, search, selectedProduct, statusFilter, t, typeFilter, visibleItems]);

  const selectStatus = (status: WorkItemStatus | "all") => {
    setStatusFilter(status);
    closeSidebar();
  };

  // The status lives in the sidebar and the type in the tab row above the list,
  // so a chip repeating either of them is the third place the same thing is
  // shown. Only the search has nowhere else to appear, and it is what brings the
  // match count and the clear button with it.
  const searchFilterActive = Boolean(search.trim());
  const clearFilters = () => {
    setStatusFilter(DEFAULT_STATUS);
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
        <div className="page-language"><LanguageSwitch /></div>
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

  if (products.length === 0) {
    return (
      <main className="onboarding-page">
        <div className="page-language"><LanguageSwitch /></div>
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

  return (
    <div className={`app-shell ${agentConsoleOpen ? "agent-console-open" : ""} ${
      agentConsoleOpen && agentConsoleSinglePane && agentConversationOpen ? "agent-conversation-open" : ""
    }`}>
      <header className={`topbar ${agentConsoleOpen ? "agent-console-topbar" : ""} ${mobileSearchOpen ? "searching" : ""}`}>
        {!agentConsoleOpen && <button className="icon-button mobile-only" onClick={() => openSidebar()} aria-label={t("openNavigation")}>
          <Menu size={20} />
        </button>}
        {agentConsoleOpen ? (
          <button type="button" className="icon-button agent-console-topbar-back" onClick={closeAgentConsole} aria-label={t("agentConsoleBack")}>
            <ArrowLeft size={20} />
          </button>
        ) : (
          <>
            <Brand compact />
            <div className="topbar-divider" />
          </>
        )}
        <ProductSwitcher
          products={products}
          selectedProductId={selectedProductId}
          attentionCounts={hasAnyAiPermission ? attentionCounts.byProduct : undefined}
          attentionCountsLoaded={agentSessionsQuery.data !== undefined}
          onSelect={(productId) => {
            setSelectedProductId(productId);
            // A filter chosen for one product says nothing about the next one,
            // and the item asks for the default view "no matter what".
            setStatusFilter(DEFAULT_STATUS);
            setTypeFilter("all");
            setSearch("");
            clearItemPage();
          }}
        />
        {hasAnyAiPermission && !agentConsoleOpen && (
          <button
            type="button"
            className="ai-console-toggle"
            aria-pressed="false"
            onClick={openAgentConsole}
          >
            <Sparkles size={16} />
            <span>{t("agentConsoleOpen")}</span>
            <small
              className="agent-attention-badge"
              aria-label={t("agentConsoleAttentionCount", {
                count: agentSessionsQuery.data === undefined ? "–" : attentionCounts.total,
              })}
              title={t("agentConsoleNeedsAttention")}
            >{agentSessionsQuery.data === undefined ? "–" : attentionCounts.total}</small>
          </button>
        )}
        {agentConsoleOpen && (
          <button
            type="button"
            className="icon-button agent-console-topbar-refresh"
            aria-label={t("refresh")}
            onClick={() => void refreshAgentConsole()}
          >
            <RefreshCw className={agentConsoleRefreshing ? "spin" : ""} size={18} />
          </button>
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
              <kbd>⌘ K</kbd>
              <button className="icon-button mobile-only mobile-search-close" onClick={() => setMobileSearchOpen(false)} aria-label={t("closeSearch")}><X size={18} /></button>
            </div>
            <button className="icon-button mobile-only mobile-search-trigger" onClick={() => setMobileSearchOpen(true)} aria-label={t("searchItems")}><Search size={19} /></button>
            <button className="primary-button capture-button" onClick={openCapture}>
              <Plus size={18} /> <span>{t("capture")}</span>
            </button>
          </>
        )}
      </header>
      {!isOnline && <div className="offline-banner" role="status"><WifiOff size={15} /> {t("offlineMode")}</div>}

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-mobile-head mobile-only">
          <Brand compact />
          <button className="icon-button" onClick={() => closeSidebar()} aria-label={t("closeNavigation")}><X size={20} /></button>
        </div>
        <nav aria-label={t("workspace")}>
          <p className="sidebar-label">{t("workspace")}</p>
          <StatusNavItem label={t("allItems")} count={shownCount(listedCount)} active={statusFilter === "all"} onClick={() => selectStatus("all")}>
            <ListTodo size={17} />
          </StatusNavItem>
          {ITEM_STATUSES.map((status) => {
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
        </nav>
        <div className="sidebar-spacer" />
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
        {hasAnyAiPermission && (
          <button
            className="text-button add-product"
            onClick={() => {
              closeSidebar();
              setAgentsOpen(true);
            }}
          ><Bot size={15} /> {t("agentManagementEntry")}</button>
        )}
        <button className="text-button add-product" onClick={() => setProductOpen(true)}><Settings2 size={15} /> {t("manageProductsEntry")}</button>
        <div className="sidebar-utilities">
          <LanguageSwitch sidebar />
          <button
            className="text-button sidebar-utility-button"
            onClick={() => {
              closeSidebar();
              setConnectionOpen(true);
            }}
          ><Settings2 size={15} /> {t("connectionSettings")}</button>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim mobile-only" onClick={() => closeSidebar()} aria-label={t("closeNavigation")} />}

      <main
        className={`workspace ${selectedItemKey ? "detail-open" : ""}`}
        ref={workspaceRef}
        style={{ "--list-pane-width": `${listPaneWidth}px` } as CSSProperties}
      >
        {/* Visibility is a layout decision: below the two-pane breakpoint the
            list gives way to the detail, above it they sit side by side. */}
        <section className="list-page">
          <nav className="mobile-status-nav mobile-only" aria-label={t("workspace")}>
            <button className={statusFilter === "all" ? "active" : ""} aria-pressed={statusFilter === "all"} onClick={() => selectStatus("all")}>
              <ListTodo size={16} />
              <span>{t("allItems")}</span>
              <small>{shownCount(listedCount)}</small>
            </button>
            {ITEM_STATUSES.map((status) => {
              const Icon = STATUS_ICONS[status];
              return (
                <button key={status} className={statusFilter === status ? "active" : ""} aria-pressed={statusFilter === status} onClick={() => selectStatus(status)}>
                  <Icon size={16} />
                  <span>{statusLabel(status)}</span>
                  <small>{shownCount(statusCount(status))}</small>
                </button>
              );
            })}
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
              <RefreshButton
                refreshing={itemsQuery.isFetching}
                onRefresh={() => queryClient.invalidateQueries({ queryKey: ["items"] })}
              />
            </div>
          </section>

          <div className="type-filters" aria-label={t("filterByType")}>
            <button className={typeFilter === "all" ? "active" : ""} aria-pressed={typeFilter === "all"} onClick={() => setTypeFilter("all")}>{t("allTypes")}</button>
            {ITEM_TYPES.map((type) => (
              <button key={type} className={typeFilter === type ? "active" : ""} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>
                {typeLabel(type)}
              </button>
            ))}
          </div>

          {searchFilterActive && (
            <div className="active-filters" role="status">
              <Filter size={14} aria-hidden="true" />
              <span className="active-filters-label">{t("filtersActive")}</span>
              <button type="button" className="filter-chip" onClick={() => setSearch("")}>
                {t("searchChip", { query: search.trim() })}<X size={12} aria-hidden="true" />
              </button>
              <span className="active-filters-count">
                {t("filterMatchCount", { matched: statusFilter === "all" ? listedCount : (itemSummary?.byStatus[statusFilter] ?? items.length), total: itemSummary?.productTotal ?? items.length })}
              </span>
              <button type="button" className="text-button active-filters-clear" onClick={clearFilters}>{t("clearFilters")}</button>
            </div>
          )}

          {selectedItemKeys.size > 0 && (selectionStatus === "pending_verification" || selectedProductCanUseAi) && (
            <div className="bulk-bar" role="status">
              {selectionStatus === "pending_verification"
                ? <ClipboardCheck size={15} aria-hidden="true" />
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
                  <h2>{(itemSummary?.total ?? 0) === 0 ? t("captureFirstSpark") : t("noMatchingItems")}</h2>
                  <p>{(itemSummary?.total ?? 0) === 0 ? t("firstSparkHelp") : t("noMatchHelp")}</p>
                  {(itemSummary?.total ?? 0) === 0 && <button className="primary-button" onClick={openCapture}><Plus size={17} /> {t("captureItem")}</button>}
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  selected={item.key === selectedItemKey}
                  checked={selectedItemKeys.has(item.key)}
                  selectionVisible={item.status === "pending_verification" || (selectedProductCanUseAi && isDispatchable(item.status))}
                  selectable={selectedItemKeys.has(item.key) || canJoinSelection(item.status, selectionStatus)}
                  dispatchSummary={latestDispatches.get(item.key)}
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
            <DetailPane itemKey={selectedItemKey} products={products} openInEdit={detailOpenInEdit} onClose={closeItemPage} onItemLoaded={selectItemProduct} onNotice={setNotice} onOpenItem={openItemPage} onStartWork={setStartWorkItem} />
          </div>
        )}
      </main>

      {agentConsoleOpen && selectedProductId && (
        <AgentSessionConsole
          productId={selectedProductId}
          allSessions={allAgentSessions}
          sessionsLoaded={agentSessionsQuery.data !== undefined}
          sessionsError={agentSessionsQuery.error}
          selectedSessionId={agentSessionId}
          conversationOpen={agentConversationOpen}
          onSelectSession={selectAgentSession}
          onBackToSessions={closeAgentConversation}
          onOpenItem={openItemFromAgentConsole}
        />
      )}

      {!agentConsoleOpen && !selectedItemKey && <button className="mobile-fab mobile-only" onClick={openCapture} aria-label={t("captureNewItem")}><Plus size={24} /></button>}

      {captureOpen && selectedProduct && (
        <Modal title={t("captureWork")} subtitle={t("addToProduct", { product: selectedProduct.name })} onClose={closeCapture}>
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
              setAgentsOpen(true);
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
      {productOpen && (
        <Modal title={t("manageProducts")} subtitle={t("productManagementHelp")} onClose={() => setProductOpen(false)} wide>
          <ProductManager
            products={products}
            {...(bootstrapQuery.data ? { user: bootstrapQuery.data.user } : {})}
            selectedProductId={selectedProductId}
            onSelectProduct={(product) => {
              setSelectedProductId(product.id);
              clearItemPage();
            }}
          />
        </Modal>
      )}
      {agentsOpen && hasAnyAiPermission && (
        <Modal title={t("nodeSettings")} subtitle={t("nodeSettingsHelp")} onClose={() => setAgentsOpen(false)} wide scrolls>
          <NodeSettings products={products} />
        </Modal>
      )}
      {downloadsOpen && (
        <Modal title={t("downloadsTitle")} subtitle={t("downloadsSubtitle")} onClose={() => setDownloadsOpen(false)}>
          <DownloadsPanel />
        </Modal>
      )}
      {connectionOpen && (
        <Modal title={t("accountSettings")} subtitle={t("accountSettingsHelp")} onClose={() => setConnectionOpen(false)}>
          {/* The shell can be on screen from cache before the session is known,
              so the panel waits for the real user rather than inventing one. */}
          {!bootstrapQuery.data ? (
            <div className="centered-state"><LoaderCircle className="spin" size={22} /></div>
          ) : (
          <AccountSettings
            user={bootstrapQuery.data.user}
            products={bootstrapQuery.data.products}
            onLoggedOut={() => {
              // Before the reload, not after: the cache on disk holds this
              // account's work items, and a restore on the next start would
              // paint them for whoever opens the app next.
              clearPersistedQueryCache();
              window.location.reload();
            }}
          />
          )}
        </Modal>
      )}
      {notice && <div className="toast" role="status"><Check size={16} /> {notice}<button onClick={() => setNotice(null)} aria-label={t("dismiss")}><X size={14} /></button></div>}
    </div>
  );
}

function LanguageSwitch({ sidebar = false }: { sidebar?: boolean }) {
  const { locale, t, toggleLocale } = useI18n();
  return (
    <button
      className={sidebar ? "text-button sidebar-utility-button" : "language-button"}
      onClick={toggleLocale}
      aria-label={t("switchLanguage")}
      title={t("switchLanguage")}
    >
      <Languages size={sidebar ? 15 : 17} />
      <span>{sidebar ? t("switchLanguage") : locale === "zh-CN" ? "EN" : "中"}</span>
    </button>
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
  sourceComponent,
  showAttachmentColumn,
  selected,
  checked,
  selectionVisible,
  selectable,
  dispatchSummary,
  onToggleChecked,
  onOpen,
  onEdit,
  onNotice,
  onStartWork,
}: {
  item: WorkItem;
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
  const dispatchable = isDispatchable(item.status);
  // Only on a ready row: the list can refetch before the dispatch list does, and
  // an item a session has just claimed must not still read as waiting on a Mac.
  const latestDispatch = dispatchable ? dispatchSummary : undefined;
  const pendingDispatchStatusKey = latestDispatch ? activeDispatchStatusKey(latestDispatch.status) : null;
  return (
    <article
      className={`item-row ${selected ? "selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button, a, input, select, textarea, summary, details, video, [role='dialog']")) return;
        onOpen();
      }}
    >
      <span className="item-row-lead">
        {/* Dispatching is a batch action, so the pick has to happen in the list.
            The click guard on the row above already exempts inputs, which is what
            keeps ticking a box from opening the detail pane. */}
        {selectionVisible && (
          <input
            type="checkbox"
            className="item-select"
            checked={checked}
            disabled={!selectable}
            aria-label={t("selectForDispatch", { key: item.key })}
            title={selectable ? undefined : t("onlyReadyDispatchable")}
            onChange={onToggleChecked}
          />
        )}
        <button className="item-row-main" onClick={onOpen} aria-label={t("openItem", { key: item.key })}>
          <span className={`type-icon type-${item.type}`} role="img" aria-label={typeLabel(item.type)}><TypeIcon size={15} /></span>
          <span className="item-copy">
            <span className="item-title-line">
              <code>{item.key}</code>
              {/* Before the title so the current dispatch result is never the
                  part cut off. Active attempts guard against a second session;
                  failed ones call out that the item needs attention. */}
              {latestDispatch && (
                <small
                  className={`item-dispatch-badge ${latestDispatch.status === "failed" ? "failed" : ""}`}
                  title={t(latestDispatch.status === "failed" ? "failedDispatchBadgeTitle" : "activeDispatchBadgeTitle", {
                    node: latestDispatch.nodeName,
                    status: pendingDispatchStatusKey ? t(pendingDispatchStatusKey) : latestDispatch.status,
                    time: formatTime(latestDispatch.createdAt),
                    at: new Date(latestDispatch.createdAt).toLocaleString(locale, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                >
                  {t(latestDispatch.status === "failed" ? "failedDispatchBadge" : "activeDispatchBadge", { node: latestDispatch.nodeName })}
                </small>
              )}
              {item.derivedFrom && <small className="item-derived-badge" title={item.derivedFrom.title}>{t("derivedFromBadge", { key: item.derivedFrom.key })}</small>}
              {item.verificationReturn && <VerificationReturnBadge />}
              <span className="item-title">{item.title}</span>
              <span className="item-evidence-summary">
                {item.type === "bug" && item.report?.reproductionSteps && <small className="evidence-strong">{t("hasReproduction")}</small>}
                {logCount > 0 && <small>{t("logCount", { count: logCount })}</small>}
                {logFileCount > 0 && <small className="evidence-strong">{t("logFileCount", { count: logFileCount })}</small>}
                {(item.diagnosticSummary?.contextEntryCount ?? 0) > 0 && <small>{t("contextCount", { count: item.diagnosticSummary.contextEntryCount })}</small>}
              </span>
            </span>
            {item.verificationReturn
              ? <VerificationReturnSummary info={item.verificationReturn} />
              : <span className={`item-description ${overview ? "" : "muted"}`}>{overview || t("noDescription")}</span>}
          </span>
        </button>
      </span>
      <ItemMediaStrip itemKey={item.key} attachments={item.attachments} preserveColumn={showAttachmentColumn} />
      <span className="item-context">
        <strong>{contextPrimary}</strong>
        {/* No placeholder when there is nothing to say: on a phone this row is
            one line shared with the platform, and "no version or device
            details" was taking enough of it to truncate "Android" to "Andr...".
            A line that only reports an absence is not worth that. See AND-32. */}
        {contextDetails && <small>{contextDetails}</small>}
        {/* Only drawn in the compact layouts, which hide the creator column. */}
        {creator && <small className="item-context-creator">{creator}</small>}
      </span>
      <span className="item-state">
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <small><i className={`priority-dot priority-${item.priority}`} /> {priorityLabel(item.priority)}</small>
      </span>
      <span className="item-updated">
        {creator && <span className="item-creator" title={creator}>{creator}</span>}
        <span>{formatTime(item.updatedAt)}</span>
      </span>
      <span className="item-row-actions">
        <ItemRowActions item={item} onEdit={onEdit} onNotice={onNotice} onStartWork={onStartWork} />
      </span>
    </article>
  );
}
/**
 * Products are told apart at a glance. An uploaded icon wins; otherwise the item
 * prefix -- the same AND / HG that labels every key in the list -- sits on a
 * colour derived from the product id, so a product is distinguishable the moment
 * it exists, with nothing to configure.
 */
function ProductBadge({ product, size = 22 }: { product: Product; size?: number }) {
  if (product.hasIcon) {
    return (
      <img
        className="product-badge"
        src={productIconUrl(product)}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="product-badge generated"
      aria-hidden="true"
      style={{ width: size, height: size, background: productBadgeColor(product.id), fontSize: Math.round(size * 0.38) }}
    >
      {product.keyPrefix.slice(0, 3)}
    </span>
  );
}

/**
 * A native <select> cannot carry an icon in its options, so this is the listbox
 * pattern instead: a button that owns the value, and a list that behaves the way
 * a select does under the keyboard.
 */
function ProductSwitcher({
  products,
  selectedProductId,
  attentionCounts,
  attentionCountsLoaded,
  onSelect,
}: {
  products: readonly Product[];
  selectedProductId: string;
  attentionCounts: ReadonlyMap<string, number> | undefined;
  attentionCountsLoaded: boolean;
  onSelect: (productId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = Math.max(0, products.findIndex((product) => product.id === selectedProductId));
  const selected = products[selectedIndex];

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    listRef.current?.focus();
  }, [open, selectedIndex]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const choose = (index: number) => {
    const product = products[index];
    if (product) onSelect(product.id);
    close();
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const moves: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves) {
      event.preventDefault();
      setActiveIndex((current) => Math.min(products.length - 1, Math.max(0, current + moves[event.key]!)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(products.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  };

  if (!selected) return null;
  return (
    <div className="product-switcher-wrap" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="product-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("selectedProduct")}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ProductBadge product={selected} />
        <span className="product-switcher-name">{selected.name}</span>
        {attentionCounts && (
          <small
            className="agent-attention-badge"
            aria-label={t("agentConsoleAttentionCount", {
              count: attentionCountsLoaded ? attentionCounts.get(selected.id) ?? 0 : "–",
            })}
            title={t("agentConsoleNeedsAttention")}
          >{attentionCountsLoaded ? attentionCounts.get(selected.id) ?? 0 : "–"}</small>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          className="product-switcher-list"
          role="listbox"
          tabIndex={-1}
          aria-label={t("selectedProduct")}
          aria-activedescendant={`product-option-${products[activeIndex]?.id ?? ""}`}
          onKeyDown={onListKeyDown}
        >
          {products.map((product, index) => (
            <li
              key={product.id}
              id={`product-option-${product.id}`}
              role="option"
              aria-selected={product.id === selectedProductId}
              className={`${index === activeIndex ? "active" : ""} ${product.id === selectedProductId ? "selected" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <ProductBadge product={product} />
              {/* Named, because a bare `li > span` rule also caught the badge and
                  stretched it to fill the row. */}
              <span className="product-switcher-option"><strong>{product.name}</strong><small>{product.keyPrefix}</small></span>
              {attentionCounts && (
                <span
                  className="agent-attention-badge"
                  aria-label={t("agentConsoleAttentionCount", {
                    count: attentionCountsLoaded ? attentionCounts.get(product.id) ?? 0 : "–",
                  })}
                  title={t("agentConsoleNeedsAttention")}
                >{attentionCountsLoaded ? attentionCounts.get(product.id) ?? 0 : "–"}</span>
              )}
              {product.id === selectedProductId && <Check size={15} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
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
  // Three thumbnails, then a count on the last rather than shrinking every
  // tile. This used to be two on a wide viewport and three on a phone, but the
  // card row is now chosen by the pane's width, which no JS media query can
  // see -- so render three and let the strip clip what will not fit.
  const visible = mediaAttachments.slice(0, 3);
  if (visible.length === 0) return preserveColumn ? <div className="item-media-strip empty-slot" aria-hidden="true" /> : null;
  return (
    <div className="item-media-strip" aria-label={t("mediaCount", { count: mediaAttachments.length })}>
      {visible.map((attachment, index) => (
        <ItemMediaThumbnail
          key={attachment.id}
          itemKey={itemKey}
          attachment={attachment}
          overflowCount={index === visible.length - 1 ? mediaAttachments.length - visible.length : 0}
        />
      ))}
    </div>
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
}: {
  itemKey: string;
  attachment: WorkItemAttachment & { readonly kind: "image" | "video" };
  overflowCount: number;
}) {
  const { t } = useI18n();
  const referenceLabel = mediaNumberLabel(attachment.kind, attachment.displayNumber, t);
  const [thumbnailRef, isNearViewport] = useNearViewport<HTMLButtonElement>("80px");
  const [previewRequested, setPreviewRequested] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  // Two separate fetches on purpose. The tile needs a few kilobytes and is
  // fetched as soon as the row nears the viewport; the original is worth
  // megabytes and is only worth fetching once someone actually opens it.
  const thumbnailQuery = useQuery({
    queryKey: ["attachment-thumbnail", itemKey, attachment.id, attachment.revision, LIST_THUMBNAIL_EDGE],
    queryFn: () => api.downloadAttachmentThumbnail(itemKey, attachment.id, LIST_THUMBNAIL_EDGE, attachment.revision),
    enabled: attachment.kind === "image" && isNearViewport,
    staleTime: Infinity,
  });
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id],
    queryFn: () => api.downloadAttachment(itemKey, attachment.id),
    enabled: previewRequested,
    staleTime: Infinity,
  });
  const thumbnailUrl = useObjectUrl(thumbnailQuery.data);
  const objectUrl = useObjectUrl(contentQuery.data);

  const Icon = attachment.kind === "video" ? Video : ImageIcon;
  return (
    <div className="item-media-thumb-wrap">
      <button
        ref={thumbnailRef}
        className={`item-media-thumb media-${attachment.kind}`}
        onClick={(event) => {
          event.stopPropagation();
          setPreviewRequested(true);
          setViewerOpen(true);
        }}
        title={attachment.filename}
        aria-label={t("previewAttachment", { filename: attachment.filename })}
      >
        {attachment.kind === "image" && thumbnailUrl && <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />}
        {!thumbnailUrl && <span className="media-file-tile">{thumbnailQuery.isLoading ? <LoaderCircle className="spin" size={18} /> : <Icon size={18} />}<small>{attachment.filename.split(".").pop()?.toUpperCase()}</small></span>}
        {overflowCount > 0 && <span className="media-overflow">+{overflowCount}</span>}
      </button>
      {viewerOpen && (
        <MediaLightbox title={`${referenceLabel} · ${attachment.filename}`} onClose={() => setViewerOpen(false)}>
          {contentQuery.isLoading && <div className="media-viewer-loading"><LoaderCircle className="spin" size={22} /> {t("attachmentLoading")}</div>}
          {contentQuery.isError && <div className="media-viewer-loading attachment-error">{t("attachmentFailed")}</div>}
          {attachment.kind === "image" && objectUrl && <img src={objectUrl} alt={attachment.filename} />}
          {attachment.kind === "video" && objectUrl && <video src={objectUrl} controls autoPlay playsInline preload="metadata" />}
        </MediaLightbox>
      )}
    </div>
  );
}

function ItemRowActions({ item, onEdit, onNotice, onStartWork }: {
  item: WorkItem;
  onEdit: () => void;
  onNotice: (message: string) => void;
  onStartWork: (item: WorkItem) => void;
}) {
  const queryClient = useQueryClient();
  const { statusLabel, t, transitionLabel } = useI18n();
  const actions = TRANSITIONS[item.status];
  const primaryAction = actions[0];
  // Destructive last, whatever order the table lists them in.
  const secondaryActions = actions.slice(1).filter((action) => action.tone !== "danger");
  const destructiveActions = actions.slice(1).filter((action) => action.tone === "danger");
  const manualTargets = manualMoves(item.status);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);
  const [noteAction, setNoteAction] = useState<TransitionAction | null>(null);
  const mutation = useMutation({
    mutationFn: ({ action, note }: { action: TransitionAction; note?: string }) =>
      api.transitionItem(item.key, action, note),
    onSuccess: async (updated) => {
      setNoteAction(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["items"] }),
        queryClient.invalidateQueries({ queryKey: ["item", item.key] }),
        queryClient.invalidateQueries({ queryKey: ["timeline", item.key] }),
      ]);
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

  return (
    <>
    <details className="detail-more-menu row-more-menu" ref={moreActionsRef}>
      <summary className="secondary-button" aria-label={t("moreActionsFor", { key: item.key })} title={t("moreActions")}>
        {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <MoreHorizontal size={18} />}
      </summary>
      <div className="detail-more-menu-popover">
        {primaryAction && (
          <button
            type="button"
            className={`menu-primary ${primaryAction.tone === "positive" ? "positive" : ""}`}
            disabled={mutation.isPending}
            onClick={() => {
              moreActionsRef.current?.removeAttribute("open");
              startTransition(primaryAction);
            }}
          >
            {quickActionLabel(item.status, t)}
          </button>
        )}
        {secondaryActions.map((action) => (
          <button
            key={`${action.to}-${action.reason}`}
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              moreActionsRef.current?.removeAttribute("open");
              startTransition(action);
            }}
          >
            {transitionLabel(action.label)}
          </button>
        ))}
        {manualTargets.length > 0 && (
          <>
            <p className="menu-section-label">{t("moveDirectlyTo")}</p>
            {manualTargets.map((action) => (
              <button
                key={action.to}
                type="button"
                disabled={mutation.isPending}
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  startTransition(action);
                }}
              >
                {statusLabel(action.to)}
              </button>
            ))}
          </>
        )}
        <button
          type="button"
          className="menu-plain"
          onClick={() => {
            moreActionsRef.current?.removeAttribute("open");
            onEdit();
          }}
        >
          {t("edit")}
        </button>
        {destructiveActions.map((action) => (
          <button
            key={`${action.to}-${action.reason}`}
            type="button"
            className="danger"
            disabled={mutation.isPending}
            onClick={() => {
              moreActionsRef.current?.removeAttribute("open");
              startTransition(action);
            }}
          >
            {transitionLabel(action.label)}
          </button>
        ))}
      </div>
    </details>
    {/* Outside the menu on purpose: a closed <details> hides everything but its
        <summary>, and a <dialog> under a hidden ancestor never paints. */}
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
    in_progress: "quickVerify",
    on_hold: "quickResume",
    pending_verification: "quickComplete",
    done: "quickReopen",
    cancelled: "quickRestore",
  } as const;
  return t(keys[status]);
}

function DetailPane({
  itemKey,
  products,
  openInEdit,
  onClose,
  onItemLoaded,
  onNotice,
  onOpenItem,
  onStartWork,
}: {
  itemKey: string | null;
  products: readonly Product[];
  openInEdit: boolean;
  onClose: () => void;
  onItemLoaded: (item: WorkItem) => void;
  onNotice: (message: string) => void;
  onOpenItem: (itemKey: string) => void;
  onStartWork: (item: WorkItem) => void;
}) {
  const queryClient = useQueryClient();
  const { actorLabel, eventLabel, formatTime, priorityLabel, statusLabel, t, transitionLabel, typeLabel } = useI18n();
  const itemQuery = useQuery({ queryKey: ["item", itemKey], queryFn: () => api.getItem(itemKey!), enabled: Boolean(itemKey) });
  const timelineQuery = useQuery({ queryKey: ["timeline", itemKey], queryFn: () => api.getTimeline(itemKey!), enabled: Boolean(itemKey) });
  const item = itemQuery.data;
  const componentsQuery = useQuery({
    queryKey: ["components", item?.productId, "with-archived"],
    queryFn: () => api.listComponents(item!.productId, { includeArchived: true }),
    enabled: Boolean(item?.productId),
  });
  const [editing, setEditing] = useState(false);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!item) return;
    onItemLoaded(item);
  }, [item, onItemLoaded]);

  useEffect(() => {
    setEditing(openInEdit);
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

  const [commentDraft, setCommentDraft] = useState("");

  const [noteAction, setNoteAction] = useState<TransitionAction | null>(null);
  const transitionMutation = useMutation({
    mutationFn: ({ action, note }: { action: TransitionAction; note?: string }) =>
      api.transitionItem(itemKey!, action, note),
    onSuccess: async (updated) => {
      setNoteAction(null);
      await refreshItem();
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
    onError: (error) => onNotice(errorMessage(error, t("somethingWentWrong"))),
  });

  const commentMutation = useMutation({
    mutationFn: (text: string) => api.createComment(itemKey!, { text }),
    onSuccess: async () => {
      setCommentDraft("");
      await queryClient.invalidateQueries({ queryKey: ["timeline", itemKey] });
      onNotice(t("commentPosted"));
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
        <button className="secondary-button" onClick={onClose}><ArrowLeft size={17} /> {t("backToList")}</button>
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
  const actions = TRANSITIONS[item.status];
  const primaryAction = actions[0];
  const secondaryActions = actions.slice(1);
  const manualTargets = manualMoves(item.status);
  const sourceComponent = componentsQuery.data?.find((component) => component.id === item.sourceComponentId);
  const affectedComponents = (componentsQuery.data ?? []).filter((component) => item.affectedComponentIds.includes(component.id));
  const environment = environmentFields(item.environment, t);
  const detailCreator = creatorLabel(item.createdBy, { human: actorLabel("human"), sdk: t("creatorSdk"), agent: actorLabel("agent") });
  const createdEvent = timelineQuery.data?.events.find((event) => event.eventType === "item_created");
  const sdkDiagnostics = diagnosticsFromEvent(createdEvent);
  const logAttachments = item.attachments.filter((attachment) => attachment.kind === "log");
  const documentAttachments = item.attachments.filter((attachment) => attachment.kind === "document");
  const mediaAttachments = item.attachments.filter(isMediaAttachment);
  return (
    <section className="detail-pane">
      <div className="detail-toolbar">
        <button className="secondary-button detail-back-button" onClick={onClose} aria-label={t("backToList")}><ArrowLeft size={17} /> {t("backToList")}</button>
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
          <button className="secondary-button" onClick={() => setEditing(true)}>{t("edit")}</button>
          <details className="detail-more-menu" ref={moreActionsRef}>
            <summary className="secondary-button" aria-label={t("moreActions")} title={t("moreActions")}><MoreHorizontal size={19} /></summary>
            <div className="detail-more-menu-popover">
              {secondaryActions.length === 0 && manualTargets.length === 0 && <span>{t("noMoreActions")}</span>}
              {secondaryActions.filter((action) => action.tone !== "danger").map((action) => (
                <button
                  key={`${action.to}-${action.reason}`}
                  type="button"
                  disabled={transitionMutation.isPending}
                  onClick={() => {
                    moreActionsRef.current?.removeAttribute("open");
                    startTransition(action);
                  }}
                >
                  {transitionLabel(action.label)}
                </button>
              ))}
              {manualTargets.length > 0 && (
                <>
                  <p className="menu-section-label">{t("moveDirectlyTo")}</p>
                  {manualTargets.map((action) => (
                    <button
                      key={action.to}
                      type="button"
                      disabled={transitionMutation.isPending}
                      onClick={() => {
                        moreActionsRef.current?.removeAttribute("open");
                        startTransition(action);
                      }}
                    >
                      {statusLabel(action.to)}
                    </button>
                  ))}
                </>
              )}
              {secondaryActions.filter((action) => action.tone === "danger").map((action) => (
                <button
                  key={`${action.to}-${action.reason}`}
                  type="button"
                  className="danger"
                  disabled={transitionMutation.isPending}
                  onClick={() => {
                    moreActionsRef.current?.removeAttribute("open");
                    startTransition(action);
                  }}
                >
                  {transitionLabel(action.label)}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
      <div className="detail-scroll">
        <>
            <div className="detail-title-block">
              <span className={`type-icon large type-${item.type}`}><PrimaryIcon size={20} /></span>
              <div>
                <p className="eyebrow">
                  {typeLabel(item.type)} · {priorityLabel(item.priority)}
                  {detailCreator && <> · {t("createdBy", { name: detailCreator })}</>}
                </p>
                <h2>{item.title}</h2>
              </div>
            </div>
            <ItemRelations item={item} onOpenItem={onOpenItem} />
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
            <DispatchHistory
              itemKey={item.key}
              canReply={productAllowsAi(products.find((product) => product.id === item.productId))}
            />
            <section className="timeline-block">
              <header className="timeline-head">
                <h3>{t("timeline")}</h3>
                <small>{t("newestFirst")}</small>
              </header>
              {timelineQuery.isLoading && <LoaderCircle className="spin" size={18} />}
              <form
                className="comment-form"
                onSubmit={(formEvent) => {
                  formEvent.preventDefault();
                  const text = commentDraft.trim();
                  if (text) commentMutation.mutate(text);
                }}
              >
                <label className="sr-only" htmlFor="comment-draft">{t("addComment")}</label>
                <textarea
                  id="comment-draft"
                  value={commentDraft}
                  onChange={(changeEvent) => setCommentDraft(changeEvent.target.value)}
                  placeholder={t("commentPlaceholder")}
                  rows={2}
                />
                <button type="submit" className="secondary-button" disabled={!commentDraft.trim() || commentMutation.isPending}>
                  {t("postComment")}
                </button>
              </form>
              <div className="timeline">
                {groupTimeline(timelineQuery.data?.events ?? []).map(({ id, event, count, filenames }) => (
                  <div
                    className={event.actorKind === "agent" ? "timeline-event timeline-event--agent" : "timeline-event"}
                    key={id}
                  >
                    <span className="timeline-dot" />
                    <div>
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
                      {/* Why it moved. Going back to Ready has to say so, which is
                          the case this is here for; a handover carries the agent's
                          summary in the same field and is worth reading too. */}
                      {event.eventType === "status_changed" && <StatusNoteLine payload={event.payload} />}
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
                          onWithdraw={() => {
                            if (window.confirm(t("withdrawCommentConfirm"))) withdrawMutation.mutate(event.id);
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
      {editing && (
        <Modal title={t("editItem", { key: item.key })} subtitle={t("editItemHelp")} onClose={() => setEditing(false)}>
          <EditItemForm
            item={item}
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

/**
 * Every dispatch this item has been part of.
 *
 * Its own section rather than timeline lines alone, because a dispatch has a
 * life after the event: the machine picks it up, the session starts or fails to,
 * and the link to that session is the thing worth clicking later.
 */
function DispatchHistory({ itemKey, canReply }: { itemKey: string; canReply: boolean }) {
  const { t } = useI18n();
  const dispatchesQuery = useQuery({
    queryKey: ["dispatches", itemKey],
    queryFn: () => api.listItemDispatches(itemKey),
  });
  const dispatches = dispatchesQuery.data?.dispatches ?? [];

  return (
    <section className="dispatch-block">
      <h3>{t("dispatchHistory")}</h3>
      {/* Said here as well as in the dialog: this is where somebody wonders why
          the item is still "ready" after it was sent somewhere. */}
      <p className="component-management-help">{t("dispatchDoesNotClaim")}</p>
      {dispatchesQuery.isLoading && <LoaderCircle className="spin" size={18} />}
      {dispatchesQuery.isError && <InlineError message={errorMessage(dispatchesQuery.error, t("somethingWentWrong"))} />}
      {!dispatchesQuery.isLoading && dispatches.length === 0 && <p className="section-empty">{t("noDispatches")}</p>}
      {dispatches.map((dispatch) => (
        <DispatchRow key={dispatch.id} dispatch={dispatch} itemKey={itemKey} canReply={canReply} />
      ))}
    </section>
  );
}

function DispatchRow({ dispatch, itemKey, canReply }: { dispatch: Dispatch; itemKey: string; canReply: boolean }) {
  const { formatTime, t } = useI18n();
  const agentKey = agentLabelKey(dispatch.agentKind);
  const modeKey = dispatchModeLabelKey(dispatch.mode);
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
      {dispatch.agentSessionId && <AgentSessionPanel sessionId={dispatch.agentSessionId} canReply={canReply} />}
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
  const modeKey = dispatchModeLabelKey(summary.mode);
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

function CommentBody({
  payload,
  onWithdraw,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly onWithdraw: () => void;
}) {
  const { t } = useI18n();
  const body = (payload.body ?? {}) as Readonly<Record<string, unknown>>;
  const withdrawn = typeof payload.withdrawnAt === "string";
  const rendered = payload.bodyKind === "structured"
    ? <AnalysisDetails payload={body} />
    : typeof body.text === "string" && body.text
      ? <MarkdownText className="comment-text">{body.text}</MarkdownText>
      : null;
  if (!rendered) return null;

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

  const withdrawButton = (
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

function EditItemForm({ item, onSaved }: { item: WorkItem; onSaved: (failedUploads: number) => void }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
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
  const [fileError, setFileError] = useState<string | null>(null);
  // Unlike the capture form, an edit in progress is mirrored nowhere: closing the tab
  // loses it. Captured once, from the first render, so it stays the value to compare against.
  const [savedDraft] = useState(draft);
  useUnsavedChangesGuard(JSON.stringify(draft) !== JSON.stringify(savedDraft) || files.length > 0);

  // Annotating replaces an attachment's bytes, filename and size, and adds a
  // timeline entry, so it refreshes exactly what deleting one does.
  const refreshAfterAttachmentChange = async () => {
    setFileError(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["item", item.key] }),
      queryClient.invalidateQueries({ queryKey: ["items"] }),
      queryClient.invalidateQueries({ queryKey: ["timeline", item.key] }),
    ]);
  };

  const deleteAttachmentMutation = useMutation({
    mutationFn: (attachmentId: string) => api.deleteAttachment(item.key, attachmentId),
    onSuccess: refreshAfterAttachmentChange,
    onError: (error) => setFileError(errorMessage(error, t("somethingWentWrong"))),
  });

  const addIncomingFiles = (incoming: readonly File[]) => {
    const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
    const result = validateIncomingFiles(files, incoming, t, Math.max(0, 10 - item.attachments.length - diagnosticSlots));
    setFiles(result.files);
    setFileError(result.error ?? null);
  };
  const remainingDropSlots = Math.max(0, 10 - item.attachments.length - (draft.diagnosticLog.trim() ? 1 : 0) - files.length);
  const { isDraggingFiles, dropHandlers } = useFileDropZone(addIncomingFiles, { canAccept: remainingDropSlots > 0 });

  const mutation = useMutation({
    mutationFn: async () => {
      const attachmentLimit = Math.max(0, 10 - item.attachments.length);
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
      return uploadAttachmentsSequentially(item.key, filesWithDiagnosticLog(files, draft.diagnosticLog));
    },
    onSuccess: onSaved,
  });

  return (
    <form
      className="capture-form quick-capture-form"
      onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}
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
        attachmentLimit={Math.max(0, 10 - item.attachments.length)}
        existingItemKey={item.key}
        existingAttachments={item.attachments}
        onDeleteExistingAttachment={(attachmentId) => deleteAttachmentMutation.mutate(attachmentId)}
        onExistingAttachmentReplaced={refreshAfterAttachmentChange}
        deletingExistingAttachmentId={deleteAttachmentMutation.isPending ? deleteAttachmentMutation.variables : undefined}
      />
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <div className="form-footer">
        <button className="primary-button" disabled={mutation.isPending || !draft.title.trim() || !draft.description.trim() || !draft.environment.platform || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > Math.max(0, 10 - item.attachments.length)}>
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
}) {
  const { priorityLabel, t, typeLabel } = useI18n();
  const componentsQuery = useQuery({ queryKey: ["components", productId], queryFn: () => api.listComponents(productId) });
  const logBytes = diagnosticLogBytes(draft.diagnosticLog);
  const diagnosticSlots = draft.diagnosticLog.trim() ? 1 : 0;
  const remainingAttachments = Math.max(0, attachmentLimit - files.length - diagnosticSlots);
  const attachmentOverflow = files.length + diagnosticSlots > attachmentLimit;
  const existingLogAttachments = existingAttachments.filter((attachment) => attachment.kind === "log");
  const existingDocumentAttachments = existingAttachments.filter((attachment) => attachment.kind === "document");
  const existingMediaAttachments = existingAttachments.filter(isMediaAttachment);
  const selectedLogFiles = files.filter(isDiagnosticFile);
  const selectedDocumentFiles = files.filter(isDocumentFile);
  const selectedMediaFiles = files.filter((file) => !isDiagnosticFile(file) && !isDocumentFile(file));
  const withMediaFiles = (next: readonly File[]) => [...selectedLogFiles, ...selectedDocumentFiles, ...next];
  const withDocumentFiles = (next: readonly File[]) => [...selectedLogFiles, ...next, ...selectedMediaFiles];
  const withLogFiles = (next: readonly File[]) => [...next, ...selectedDocumentFiles, ...selectedMediaFiles];
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
    mutationFn: () => api.generateTitle(productId, draft.description),
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
          <select
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
          </select>
        </label>
        <label><FieldLabel>{t("sourceComponent")}</FieldLabel>
          <select
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
          </select>
        </label>
        <label><FieldLabel>{t("priority")}</FieldLabel><select value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
      </div>
      <div className="ai-title-field">
        <label><FieldLabel required>{t("whatNeedsAttention")}</FieldLabel><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus data-initial-focus /></label>
        <button type="button" className="secondary-button" disabled={titleMutation.isPending || !draft.description.trim()}
          title={!draft.description.trim() ? t("aiTitleNeedsContent") : undefined}
          onClick={() => titleMutation.mutate()}>
          {titleMutation.isPending ? t("aiTitleGenerating") : t("aiTitleButton")}
        </button>
      </div>
      <small className="ai-title-privacy">{t("aiTitlePrivacy")}</small>
      {titleMutation.isError && <InlineError message={errorMessage(titleMutation.error, t("somethingWentWrong"))} />}
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
            accept=".md,.txt,.csv,.json,.pdf,text/markdown,text/plain,text/csv,application/json,application/pdf"
            allowedExtensions={["md", "txt", "csv", "json", "pdf"]}
            buttonLabel={t("add")}
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
      {attachmentOverflow && <InlineError message={t("tooManyFiles", { count: attachmentLimit })} />}
      {fileError && <InlineError message={fileError} />}
      <section className="report-input-block">
        <header><strong>{t(reportCopy.title)}</strong><small>{t(reportCopy.help)}</small></header>
        <label><FieldLabel required>{t(reportCopy.overview)}</FieldLabel><AutoGrowTextarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t(reportCopy.placeholder)} rows={4} maxLength={20_000} required /></label>
        {showsBugFields && (
          <div className="report-field-grid">
            <label><FieldLabel>{t("reproductionSteps")}</FieldLabel><AutoGrowTextarea value={draft.reproductionSteps} onChange={(event) => updateDraft("reproductionSteps", event.target.value)} placeholder={t("reproductionStepsPlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("expectedOutcome")}</FieldLabel><AutoGrowTextarea value={draft.expectedOutcome} onChange={(event) => updateDraft("expectedOutcome", event.target.value)} placeholder={t("expectedOutcomePlaceholder")} rows={5} maxLength={20_000} /></label>
            <label><FieldLabel>{t("impact")}</FieldLabel><AutoGrowTextarea value={draft.impact} onChange={(event) => updateDraft("impact", event.target.value)} placeholder={t("impactPlaceholder")} rows={3} maxLength={10_000} /></label>
            <label><FieldLabel>{t("occurrenceFrequency")}</FieldLabel>
              <select value={draft.occurrenceFrequency} onChange={(event) => updateDraft("occurrenceFrequency", event.target.value as WorkItemOccurrenceFrequency)}>
                <option value="unknown">{t("frequencyUnknown")}</option>
                <option value="once">{t("frequencyOnce")}</option>
                <option value="intermittent">{t("frequencyIntermittent")}</option>
                <option value="frequent">{t("frequencyFrequent")}</option>
                <option value="always">{t("frequencyAlways")}</option>
              </select>
            </label>
          </div>
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
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
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
          disabled={mutation.isPending || !draft.title.trim() || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > 10}
          onClick={() => mutation.mutate("inbox")}
        >
          {mutation.isPending && mutation.variables === "inbox" ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />} {t("saveDraft")}
        </button>
        <button className="primary-button" disabled={mutation.isPending || !draft.title.trim() || !draft.description.trim() || !draft.environment.platform || diagnosticLogBytes(draft.diagnosticLog) > MAX_DIAGNOSTIC_LOG_BYTES || files.length + (draft.diagnosticLog.trim() ? 1 : 0) > 10}>
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

// Covers the whole form while files are dragged over it. Where a file lands
// does not matter: WorkItemFields sorts each one into its section by extension.
function FileDropOverlay({ remaining }: { remaining: number }) {
  const { t } = useI18n();
  return (
    <div className={`file-drop-overlay ${remaining < 1 ? "full" : ""}`} aria-hidden>
      <div className="file-drop-overlay-message">
        <Paperclip size={22} />
        <strong>{remaining > 0 ? t("dropFilesToAttach") : t("dropFilesLimitReached", { count: 10 })}</strong>
        {remaining > 0 && <small>{t("dropFilesToAttachHelp")}</small>}
      </div>
    </div>
  );
}

function FilePicker({
  files = [],
  onFiles,
  remaining,
  disabled = false,
  showSelectedFiles = true,
  showCamera = true,
  accept = "image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.md,.txt,.csv,.json,.pdf",
  allowedExtensions,
  buttonLabel,
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
          {disabled ? <LoaderCircle className="spin" size={16} /> : <Paperclip size={16} />}
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
  return (
    <section className="attachment-block">
      <header>
        {/* No helper line: this is the detail view, where the files are already
            here. What can be attached is the form's to explain (AND-65). */}
        <div><h3>{title ?? t("attachments")}</h3></div>
      </header>
      {attachments.length === 0 ? <p className="section-empty">{emptyMessage ?? t("noAttachments")}</p> : (
        <div className="attachment-grid">
          {attachments.map((attachment) => <AttachmentCard key={attachment.id} itemKey={itemKey} attachment={attachment} />)}
        </div>
      )}
    </section>
  );
}

function AttachmentCard({
  itemKey,
  attachment,
  onDelete,
  onReplaced,
  deleting = false,
}: {
  itemKey: string;
  attachment: WorkItemAttachment;
  onDelete?: ((attachmentId: string) => void) | undefined;
  onReplaced?: (() => void | Promise<void>) | undefined;
  deleting?: boolean;
}) {
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
  const thumbnailUrl = useObjectUrl(thumbnailQuery.data);
  // A log and a text document are both read as text, and only their head is
  // worth fetching for a preview. A PDF is neither: it can only be downloaded.
  const readsAsText = attachment.kind === "log"
    || (attachment.kind === "document" && attachment.contentType !== "application/pdf");
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id, attachment.revision],
    queryFn: () => api.downloadAttachment(
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
    const blob = readsAsText
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
    () => contentQuery.data ? new File([contentQuery.data], attachment.filename, { type: attachment.contentType }) : null,
    [attachment.contentType, attachment.filename, contentQuery.data],
  );

  const openImage = () => {
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

  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "video" ? Video : FileText;
  return (
    <article ref={cardRef} className={`attachment-card attachment-${attachment.kind}`}>
      <div className="attachment-preview">
        {referenceLabel && <small className="media-number-badge">{referenceLabel}</small>}
        {!shouldLoad && attachment.kind !== "image" && (
          <button type="button" className="attachment-load-button" onClick={() => setPreviewRequested(true)}>
            <Icon size={22} /> {t("loadPreview")}
          </button>
        )}
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
            <video src={objectUrl} controls preload="metadata" />
            <button type="button" onClick={() => setViewerOpen(true)} aria-label={t("previewAttachment", { filename: attachment.filename })} title={t("preview")}><Maximize2 size={16} /></button>
          </div>
        )}
        {readsAsText && logText && <pre>{logText}</pre>}
      </div>
      <footer>
        <Icon size={15} />
        <span><strong>{referenceLabel ? `${referenceLabel} · ` : ""}{attachment.filename}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span>
        <span className="attachment-actions">
          <button type="button" onClick={() => void download()} aria-label={`${t("download")} ${attachment.filename}`} title={t("download")}><Download size={15} /></button>
          {onReplaced && attachment.kind === "image" && isAnnotatableImage({ name: attachment.filename, type: attachment.contentType }) && (
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
            onClick={() => { if (window.confirm(t("confirmDeleteAttachment", { filename: attachment.filename }))) onDelete(attachment.id); }}
            aria-label={t("deleteAttachment", { filename: attachment.filename })}
            title={t("delete")}
          >{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>}
        </span>
      </footer>
      {replaceError && <InlineError message={replaceError} />}
      {annotating && annotationSource && (
        <ImageAnnotator
          file={annotationSource}
          onCancel={() => setAnnotating(false)}
          onSave={saveAnnotation}
        />
      )}
      {viewerOpen && (objectUrl || isImage) && attachment.kind !== "log" && (
        <MediaLightbox title={`${referenceLabel} · ${attachment.filename}`} onClose={() => setViewerOpen(false)}>
          {isImage && contentQuery.isLoading && <div className="media-viewer-loading"><LoaderCircle className="spin" size={22} /> {t("attachmentLoading")}</div>}
          {isImage && contentQuery.isError && <div className="media-viewer-loading attachment-error">{t("attachmentFailed")}</div>}
          {isImage && objectUrl && <img src={objectUrl} alt={attachment.filename} />}
          {attachment.kind === "video" && objectUrl && <video src={objectUrl} controls autoPlay playsInline preload="metadata" />}
        </MediaLightbox>
      )}
    </article>
  );
}

function ProductManager({
  products,
  user,
  selectedProductId,
  onSelectProduct,
}: {
  products: readonly Product[];
  /** Absent only while the shell is drawn from cache and the session is still loading. */
  user?: AuthenticatedUser;
  selectedProductId: string;
  onSelectProduct: (product: Product) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [activeProductId, setActiveProductId] = useState(selectedProductId || products[0]?.id || "");
  const [adding, setAdding] = useState(false);
  const activeProduct = products.find((product) => product.id === activeProductId);
  // A phone has room for one thing at a time. Stacking both panes put a
  // scrolling list, a tab strip and a form inside one scrolling dialog, and
  // nothing said which product the tabs belonged to.
  const stacked = useSinglePaneLayout();
  const [openOnPhone, setOpenOnPhone] = useState(false);
  const showingSettings = !stacked || openOnPhone;

  return (
    <div className={`product-manager ${stacked ? "stacked" : ""}`}>
      {(!stacked || !openOnPhone) && (
        <aside className="product-manager-list">
          <p className="sidebar-label">{t("existingProducts")}</p>
          {products.map((product) => (
            <button
              key={product.id}
              className={!stacked && activeProductId === product.id && !adding ? "active" : ""}
              onClick={() => { setActiveProductId(product.id); setAdding(false); setOpenOnPhone(true); }}
            >
              <ProductBadge product={product} size={26} />
              <span><strong>{product.name}</strong><small>{product.keyPrefix}</small></span>
              <ChevronRight size={16} />
            </button>
          ))}
          <button className={`product-manager-add ${!stacked && adding ? "active" : ""}`} onClick={() => { setAdding(true); setOpenOnPhone(true); }}><Plus size={15} /> {t("addProduct")}</button>
        </aside>
      )}
      {showingSettings && (
      <section className="product-manager-content">
        {stacked && (
          <button type="button" className="product-manager-back" onClick={() => setOpenOnPhone(false)}>
            <ArrowLeft size={16} />
            {adding || !activeProduct ? t("addProduct") : <><ProductBadge product={activeProduct} size={22} /><span>{activeProduct.name}</span></>}
          </button>
        )}
        {adding || !activeProduct ? (
          <div className="product-create-panel">
            <p className="eyebrow">{t("newProduct")}</p>
            <h3>{t("createProductWorkspace")}</h3>
            <ProductForm
              onCreated={async (product) => {
                await queryClient.invalidateQueries({ queryKey: ["products"] });
                setActiveProductId(product.id);
                setAdding(false);
                onSelectProduct(product);
              }}
            />
          </div>
        ) : (
          <ProductSettings
            key={activeProduct.id}
            product={activeProduct}
            {...(user ? { user } : {})}
            onSelected={() => onSelectProduct(activeProduct)}
          />
        )}
      </section>
      )}
    </div>
  );
}

/** An uploaded icon replaces the generated badge; removing it brings the badge back. */
function ProductIconField({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (file: File | null) => file ? api.setProductIcon(product.id, file) : api.removeProductIcon(product.id),
    onSuccess: async () => {
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
          <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => inputRef.current?.click()}>
            {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <ImageIcon size={15} />} {product.hasIcon ? t("replaceIcon") : t("uploadIcon")}
          </button>
          {product.hasIcon && (
            <button type="button" className="text-button" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>
              {t("useGeneratedIcon")}
            </button>
          )}
        </div>
        {error && <InlineError message={error} />}
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) mutation.mutate(file);
        }}
      />
    </div>
  );
}

function ProductSettings({
  product,
  user,
  onSelected,
}: {
  product: Product;
  user?: AuthenticatedUser;
  onSelected: () => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [activeSettingsTab, setActiveSettingsTab] = useState<"product" | "components" | "tokens" | "access">("product");
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
  useEffect(() => setActiveSettingsTab("product"), [product.id]);

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

  return (
    <div className="product-settings">
      <div className="product-settings-tabs" role="tablist" aria-label={t("productSettings")}>
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "product"}
          className={activeSettingsTab === "product" ? "active" : ""}
          onClick={() => setActiveSettingsTab("product")}
        >
          {t("productInformation")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "components"}
          className={activeSettingsTab === "components" ? "active" : ""}
          onClick={() => setActiveSettingsTab("components")}
        >
          {t("moduleManagement")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "tokens"}
          className={activeSettingsTab === "tokens" ? "active" : ""}
          onClick={() => setActiveSettingsTab("tokens")}
        >
          {t("sdkTokens")}
        </button>
        {/* Who else reaches this product is the creator's call or an
            administrator's (AND-58). A member looking at a product shared with
            them has no say in it, and the endpoint answers them 403. */}
        {mayAdminister && (
          <button
            type="button"
            role="tab"
            aria-selected={activeSettingsTab === "access"}
            className={activeSettingsTab === "access" ? "active" : ""}
            onClick={() => setActiveSettingsTab("access")}
          >
            {t("productAccess")}
          </button>
        )}
      </div>
      {activeSettingsTab === "access" ? (
        <section className="product-settings-section" role="tabpanel">
          <header><div><p className="eyebrow">{product.keyPrefix}</p><h3>{t("productAccess")}</h3></div></header>
          <ProductAccessSettings productId={product.id} user={user} />
        </section>
      ) : activeSettingsTab === "tokens" ? (
        <SdkTokenSettings product={product} />
      ) : activeSettingsTab === "product" ? (
        <section className="product-settings-section" role="tabpanel">
          <header><div><p className="eyebrow">{product.keyPrefix}</p><h3>{t("productInformation")}</h3></div></header>
          <div className="product-settings-grid">
            <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{t("itemPrefix")}<input value={product.keyPrefix} readOnly /><small>{t("prefixLockedHelp")}</small></label>
          </div>
          <ProductIconField product={product} />
          {productMutation.isError && <InlineError message={errorMessage(productMutation.error, t("somethingWentWrong"))} />}
          {archiveMutation.isError && <InlineError message={errorMessage(archiveMutation.error, t("somethingWentWrong"))} />}
          <button className="primary-button settings-save" disabled={!name.trim() || name.trim() === product.name || productMutation.isPending} onClick={() => productMutation.mutate()}>
            {productMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {t("saveProduct")}
          </button>
          <div className="archive-row">
            <p>{mayArchive ? t("archiveProductHelp") : t("archiveNotOwner")}</p>
            <button
              type="button"
              className="secondary-button archive-button"
              disabled={archiveMutation.isPending || !mayArchive}
              onClick={() => {
                if (product.archivedAt) archiveMutation.mutate(false);
                else if (window.confirm(t("confirmArchiveProduct", { name: product.name }))) archiveMutation.mutate(true);
              }}
            >
              {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
              {product.archivedAt ? t("restore") : t("archive")}
            </button>
          </div>
        </section>
      ) : (
        <section className="product-settings-section component-management" role="tabpanel">
          <header>
            <div><p className="eyebrow">{t("productComponents")}</p><h3>{t("moduleManagement")}</h3></div>
            <div className="component-header-actions">
              <span>{componentsQuery.data?.length ?? 0}</span>
              {(componentsQuery.data?.length ?? 0) > 0 && (
                <button className="primary-button component-add-trigger" onClick={() => setAddingComponent((value) => !value)}><Plus size={15} /> {t("newComponent")}</button>
              )}
            </div>
          </header>
          <p className="component-management-help">{t("componentManagementHelp")}</p>
          <div className="component-manager-list">
            {components.length > 0 && (
              <div className="component-list-head">
                <span>{t("componentName")}</span><span>{t("componentKind")}</span><span>{t("save")}</span>
              </div>
            )}
            {components.map((component) => (
              <div key={component.id}>
                <ComponentSettingsRow component={component} />
              </div>
            ))}
            {!componentsQuery.isLoading && (componentsQuery.data?.length ?? 0) === 0 && !addingComponent && (
              <div className="component-empty-state">
                <button className="primary-button" onClick={() => setAddingComponent(true)}><Plus size={17} /> {t("newComponent")}</button>
              </div>
            )}
          </div>
          {addingComponent && (
            <div className="component-add-panel">
              <header>
                <h4>{t("newComponent")}</h4>
                <button className="secondary-button component-add-cancel" disabled={componentMutation.isPending} onClick={closeComponentForm}><X size={15} /> {t("cancel")}</button>
              </header>
              <div className="component-add-row">
                <label>{t("componentName")}<input value={newComponentName} onChange={(event) => setNewComponentName(event.target.value)} placeholder={t("componentNamePlaceholder")} autoFocus /></label>
                <label>{t("componentKind")}<select value={newComponentKind} onChange={(event) => setNewComponentKind(event.target.value as ComponentKind)}>{COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</select></label>
                <button className="primary-button" disabled={!newComponentName.trim() || componentMutation.isPending} onClick={() => componentMutation.mutate()}>
                  {componentMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createComponent")}
                </button>
              </div>
            </div>
          )}
          {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
        </section>
      )}
    </div>
  );
}

function SdkTokenSettings({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const { formatTime, t } = useI18n();
  const [name, setName] = useState("");
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

  const copyToken = async () => {
    if (!createdToken) return;
    await navigator.clipboard.writeText(createdToken.token);
    setCopied(true);
  };

  return (
    <section className="product-settings-section" role="tabpanel">
      <header>
        <div><p className="eyebrow">{product.keyPrefix}</p><h3>{t("sdkTokens")}</h3></div>
        <div className="component-header-actions"><span>{tokens.filter((token) => !token.revokedAt).length}</span></div>
      </header>
      <p className="component-management-help">{t("sdkTokensHelp")}</p>

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

      <div className="component-add-panel">
        <div className="component-add-row">
          <label>{t("sdkTokenName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("sdkTokenNamePlaceholder")} maxLength={100} /></label>
          <label>{t("sdkTokenScope")}
            <select value={sourceComponentId} onChange={(event) => setSourceComponentId(event.target.value)}>
              <option value="">{t("sdkTokenAnyModule")}</option>
              {androidComponents.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
            </select>
          </label>
          <button className="primary-button" disabled={!name.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createSdkToken")}
          </button>
        </div>
        {androidComponents.length === 0 && <p className="section-empty">{t("sdkTokenNeedsAndroidModule")}</p>}
      </div>
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
                onClick={() => {
                  if (window.confirm(t("confirmRevokeToken", { name: token.name }))) revokeMutation.mutate(token.id);
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
  return (
    <div className={`component-settings-row ${archived ? "archived" : ""}`}>
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("componentName")} disabled={archived} />
      <select value={kind} onChange={(event) => setKind(event.target.value as ComponentKind)} aria-label={t("componentKind")} disabled={archived}>
        {COMPONENT_KINDS.map((value) => <option key={value} value={value}>{t(value)}</option>)}
      </select>
      {archived ? (
        <button className="secondary-button" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate(false)}>
          {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />} {t("restore")}
        </button>
      ) : changed ? (
        <button className="secondary-button" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
        </button>
      ) : (
        <button
          className="secondary-button archive-button"
          disabled={archiveMutation.isPending}
          onClick={() => {
            if (window.confirm(t("confirmArchiveComponent", { name: component.name }))) archiveMutation.mutate(true);
          }}
        >
          {archiveMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />} {t("archive")}
        </button>
      )}
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
  return (
    <form className="product-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate({ name, keyPrefix }); }}>
      <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Hermes Go" required autoFocus /></label>
      <label>{t("itemPrefix")}<input value={keyPrefix} onChange={(event) => setKeyPrefix(event.target.value.toUpperCase())} placeholder="HG" minLength={2} maxLength={10} required /><small>{t("prefixHelp")}</small></label>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <button className="primary-button wide" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {t("createWorkspace")}</button>
    </form>
  );
}

function LoginForm({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => api.login({ username: username.trim(), password }),
    onSuccess: onAuthenticated,
  });
  const loginError = mutation.error instanceof ApiError
    ? mutation.error.code === "invalid_credentials"
      ? t("invalidCredentials")
      : mutation.error.code === "login_rate_limited"
        ? t("loginRateLimited")
        : mutation.error.code === "authentication_unavailable"
          ? t("accountUnavailable")
          : mutation.error.message
    : mutation.isError
      ? t("somethingWentWrong")
      : null;
  return (
    <form className="login-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <label>{t("username")}<input type="email" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("usernamePlaceholder")} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
      <label>{t("password")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("passwordPlaceholder")} autoComplete="current-password" required /></label>
      {loginError && <InlineError message={loginError} />}
      <p className="privacy-note"><KeyRound size={14} /> {t("noRegistration")}</p>
      <button className="primary-button wide" disabled={mutation.isPending || !username.trim() || !password}>
        {mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {t("signIn")}
      </button>
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
        <button type="button" className="secondary-button" onClick={onClose}>{t("cancel")}</button>
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

function Modal({ title, subtitle, onClose, children, wide = false, scrolls = false }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Wide modals leave scrolling to their content; set when the content has no scroller of its own. */
  scrolls?: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    // showModal() runs the dialog focusing steps synchronously, after React has
    // already honoured autoFocus, so it lands on the dialog itself and the
    // caret never reaches the field. Claim it back in the same tick: deferring
    // to a frame would leave the modal unfocused in a background tab.
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="modal-layer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={`modal ${wide ? "wide" : ""} ${scrolls ? "scrolls" : ""}`}>
        <header><div><p className="eyebrow">{subtitle}</p><h2 id={titleId}>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
        {children}
      </section>
    </dialog>
  );
}

function MediaLightbox({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
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
    >
      <section>
        <header>
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label={t("closePreview")}><X size={20} /></button>
        </header>
        {children}
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
