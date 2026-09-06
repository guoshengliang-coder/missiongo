import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
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
  LogOut,
  Maximize2,
  Menu,
  MoreHorizontal,
  Paperclip,
  Plus,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  Video,
  WifiOff,
  X,
} from "lucide-react";

import { api, ApiError, type AuthSession, type AuthenticatedUser } from "./api";
import {
  captureDraftStorageKey,
  hasCaptureDraftContent,
  parseCaptureDraft,
  workItemReportPayload,
  type CaptureDraft,
  type EnvironmentDraft,
} from "./capture-draft";
import { clearDraftFiles, loadDraftFiles, saveDraftFiles } from "./draft-files";
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
  type TransitionAction,
  type WorkItem,
  type WorkItemAttachment,
  type WorkItemEnvironment,
  type WorkItemEvent,
  type WorkItemOccurrenceFrequency,
  type WorkItemPriority,
  type WorkItemReport,
  type WorkItemStatus,
  type WorkItemType,
} from "./types";
import { useI18n } from "./i18n";
import { groupTimeline } from "./timeline";
import { TRANSITIONS } from "./work-item-transitions";
import { ImageAnnotator } from "./ImageAnnotator";
import { isAnnotatableImage } from "./image-annotation";
import {
  ITEM_HISTORY_MARKER,
  activeFilterCount,
  filtersFromUrl,
  filtersToUrl,
  itemDetailUrl,
  itemKeyFromUrl,
  itemListUrl,
} from "./navigation";
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

const ANDROID_APK_DOWNLOAD_PATH = "/downloads/missiongo-android-latest.apk";

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

const FILE_LIMITS_MIB: Readonly<Record<string, number>> = {
  png: 20,
  jpg: 20,
  jpeg: 20,
  webp: 20,
  gif: 20,
  heic: 20,
  mp4: 100,
  mov: 100,
  webm: 100,
  log: 10,
  txt: 10,
  json: 10,
};

const DIAGNOSTIC_FILE_EXTENSIONS = new Set(["log", "txt", "json"]);
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "mov", "webm"]);

function isDiagnosticFile(file: File): boolean {
  return DIAGNOSTIC_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? "");
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
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const limit = FILE_LIMITS_MIB[extension];
    if (!limit) {
      error ??= t("unsupportedFile", { filename: file.name });
      continue;
    }
    if (file.size > limit * 1024 * 1024) {
      error ??= t("fileTooLarge", { filename: file.name, size: limit });
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [notice, setNotice] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const listScrollTopRef = useRef(0);

  const restoreListScroll = useCallback(() => {
    requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: listScrollTopRef.current });
      window.scrollTo({ top: listScrollTopRef.current });
    });
  }, []);

  const openItemPage = useCallback((itemKey: string, edit = false) => {
    if (selectedItemKey === itemKey) return;
    const workspace = workspaceRef.current;
    listScrollTopRef.current = workspace && workspace.scrollHeight > workspace.clientHeight
      ? workspace.scrollTop
      : window.scrollY;
    const state = typeof history.state === "object" && history.state ? history.state as Record<string, unknown> : {};
    history.pushState({ ...state, [ITEM_HISTORY_MARKER]: true }, "", itemDetailUrl(itemKey));
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
    setSelectedItemKey(null);
    restoreListScroll();
  };

  const clearItemPage = () => {
    history.replaceState(history.state, "", itemListUrl());
    setDetailOpenInEdit(false);
    setSelectedItemKey(null);
  };

  useEffect(() => {
    const handlePopState = () => {
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
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [restoreListScroll]);

  const authQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: api.getSession,
    retry: false,
    staleTime: Infinity,
  });
  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: api.listProducts,
    enabled: authQuery.isSuccess,
  });
  const products = productsQuery.data ?? [];

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
      limit: 30,
      ...(pageParam ? { beforeSequence: pageParam } : {}),
    }),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextBeforeSequence ?? null,
    enabled: authQuery.isSuccess && Boolean(selectedProductId),
  });
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const itemSummary = itemsQuery.data?.pages[0]?.summary;
  const componentsQuery = useQuery({
    queryKey: ["components", selectedProductId],
    queryFn: () => api.listComponents(selectedProductId),
    enabled: authQuery.isSuccess && Boolean(selectedProductId),
  });
  const componentsById = useMemo(
    () => new Map((componentsQuery.data ?? []).map((component) => [component.id, component])),
    [componentsQuery.data],
  );
  const visibleItems = items;
  const showAttachmentColumn = visibleItems.some((item) => item.attachments.some((attachment) => attachment.kind !== "log"));

  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const selectItemProduct = useCallback((item: WorkItem) => {
    if (item.productId !== selectedProductId) setSelectedProductId(item.productId);
  }, [selectedProductId]);
  const openCount = itemSummary
    ? itemSummary.total - itemSummary.byStatus.done - itemSummary.byStatus.cancelled
    : items.filter((item) => !["done", "cancelled"].includes(item.status)).length;
  const verifyCount = itemSummary?.byStatus.pending_verification ?? items.filter((item) => item.status === "pending_verification").length;
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
    setSidebarOpen(false);
  };

  const filterCount = activeFilterCount({ productId: selectedProductId, status: statusFilter, type: typeFilter, search });
  const clearFilters = () => {
    setStatusFilter("all");
    setTypeFilter("all");
    setSearch("");
    setMobileSearchOpen(false);
  };

  if (authQuery.isPending) {
    return (
      <main className="centered-state">
        <div className="page-language"><LanguageSwitch /></div>
        <Brand />
        <LoaderCircle className="spin" size={26} />
        <p>{t("checkingSession")}</p>
      </main>
    );
  }

  if (authQuery.isError || !authQuery.data) {
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
              void queryClient.invalidateQueries({ queryKey: ["products"] });
            }}
          />
        </section>
      </main>
    );
  }

  if (productsQuery.isLoading) {
    return (
      <main className="centered-state">
        <div className="page-language"><LanguageSwitch /></div>
        <Brand />
        <LoaderCircle className="spin" size={26} />
        <p>{t("openingWorkspace")}</p>
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
    <div className="app-shell">
      <header className={`topbar ${mobileSearchOpen ? "searching" : ""}`}>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label={t("openNavigation")}>
          <Menu size={20} />
        </button>
        <Brand compact />
        <div className="topbar-divider" />
        <div className="product-switcher-wrap">
          <select
            className="product-switcher"
            value={selectedProductId}
            onChange={(event) => {
              setSelectedProductId(event.target.value);
              clearItemPage();
            }}
            aria-label={t("selectedProduct")}
          >
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
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
        <button className="primary-button capture-button" onClick={() => setCaptureOpen(true)}>
          <Plus size={18} /> <span>{t("capture")}</span>
        </button>
      </header>
      {!isOnline && <div className="offline-banner" role="status"><WifiOff size={15} /> {t("offlineMode")}</div>}

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-mobile-head mobile-only">
          <Brand compact />
          <button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label={t("closeNavigation")}><X size={20} /></button>
        </div>
        <nav aria-label={t("workspace")}>
          <p className="sidebar-label">{t("workspace")}</p>
          <StatusNavItem label={t("allItems")} count={itemSummary?.total ?? items.length} active={statusFilter === "all"} onClick={() => selectStatus("all")}>
            <ListTodo size={17} />
          </StatusNavItem>
          {ITEM_STATUSES.map((status) => {
            const Icon = STATUS_ICONS[status];
            return (
              <StatusNavItem
                key={status}
                label={statusLabel(status)}
                count={itemSummary?.byStatus[status] ?? items.filter((item) => item.status === status).length}
                active={statusFilter === status}
                onClick={() => selectStatus(status)}
              >
                <Icon size={17} />
              </StatusNavItem>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="mission-card">
          <span className="mission-orbit"><Sparkles size={16} /></span>
          <p>{t("aiDispatchNext")}</p>
          <span>{t("aiDispatchDescription")}</span>
        </div>
        <a
          className="text-button add-product"
          href={ANDROID_APK_DOWNLOAD_PATH}
          download
          onClick={() => setSidebarOpen(false)}
        ><Download size={15} /> {t("downloadAndroid")}</a>
        <button className="text-button add-product" onClick={() => setProductOpen(true)}><Settings2 size={15} /> {t("manageProductsEntry")}</button>
        <div className="sidebar-utilities">
          <LanguageSwitch sidebar />
          <button
            className="text-button sidebar-utility-button"
            onClick={() => {
              setSidebarOpen(false);
              setConnectionOpen(true);
            }}
          ><Settings2 size={15} /> {t("connectionSettings")}</button>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim mobile-only" onClick={() => setSidebarOpen(false)} aria-label={t("closeNavigation")} />}

      <main className={`workspace ${selectedItemKey ? "detail-open" : ""}`} ref={workspaceRef}>
        <section className="list-page" hidden={Boolean(selectedItemKey)}>
          <nav className="mobile-status-nav mobile-only" aria-label={t("workspace")}>
            <button className={statusFilter === "all" ? "active" : ""} aria-pressed={statusFilter === "all"} onClick={() => selectStatus("all")}>
              <ListTodo size={16} />
              <span>{t("allItems")}</span>
              <small>{itemSummary?.total ?? items.length}</small>
            </button>
            {ITEM_STATUSES.map((status) => {
              const Icon = STATUS_ICONS[status];
              return (
                <button key={status} className={statusFilter === status ? "active" : ""} aria-pressed={statusFilter === status} onClick={() => selectStatus(status)}>
                  <Icon size={16} />
                  <span>{statusLabel(status)}</span>
                  <small>{itemSummary?.byStatus[status] ?? items.filter((item) => item.status === status).length}</small>
                </button>
              );
            })}
          </nav>
          <section className="workspace-head">
            <div>
              <p className="eyebrow">{t("productWorkspace", { prefix: selectedProduct?.keyPrefix ?? "" })}</p>
              <h1>{statusFilter === "all" ? t("allWork") : statusLabel(statusFilter)}</h1>
            </div>
            <div className="workspace-stats" aria-label={t("workspaceSummary")}>
              <span><strong>{openCount}</strong> {t("open")}</span>
              <span><strong>{verifyCount}</strong> {t("toVerify")}</span>
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

          {filterCount > 0 && (
            <div className="active-filters" role="status">
              <Filter size={14} aria-hidden="true" />
              <span className="active-filters-label">{t("filtersActive")}</span>
              {statusFilter !== "all" && (
                <button type="button" className="filter-chip" onClick={() => setStatusFilter("all")}>
                  {statusLabel(statusFilter)}<X size={12} aria-hidden="true" />
                </button>
              )}
              {typeFilter !== "all" && (
                <button type="button" className="filter-chip" onClick={() => setTypeFilter("all")}>
                  {typeLabel(typeFilter)}<X size={12} aria-hidden="true" />
                </button>
              )}
              {search.trim() && (
                <button type="button" className="filter-chip" onClick={() => setSearch("")}>
                  {t("searchChip", { query: search.trim() })}<X size={12} aria-hidden="true" />
                </button>
              )}
              <span className="active-filters-count">
                {t("filterMatchCount", { matched: itemSummary?.total ?? items.length, total: itemSummary?.productTotal ?? items.length })}
              </span>
              <button type="button" className="text-button active-filters-clear" onClick={clearFilters}>{t("clearFilters")}</button>
            </div>
          )}

          <section className={`list-surface ${showAttachmentColumn ? "with-media" : "without-media"}`} aria-label={t("workItems")}>
            <div className="list-columns" aria-hidden="true">
              <span>{t("itemInformation")}</span>
              {showAttachmentColumn && <span>{t("attachments")}</span>}
              <span>{t("capturedContext")}</span>
              <span>{t("status")}</span>
              <span>{t("updated")}</span>
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
                  {(itemSummary?.total ?? 0) === 0 && <button className="primary-button" onClick={() => setCaptureOpen(true)}><Plus size={17} /> {t("captureItem")}</button>}
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  sourceComponent={item.sourceComponentId ? componentsById.get(item.sourceComponentId) : undefined}
                  showAttachmentColumn={showAttachmentColumn}
                  onOpen={() => openItemPage(item.key)}
                  onEdit={() => openItemPage(item.key, true)}
                  onNotice={setNotice}
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
          <div className="detail-page-shell">
            <DetailPane itemKey={selectedItemKey} openInEdit={detailOpenInEdit} onClose={closeItemPage} onItemLoaded={selectItemProduct} onNotice={setNotice} />
          </div>
        )}
      </main>

      {!selectedItemKey && <button className="mobile-fab mobile-only" onClick={() => setCaptureOpen(true)} aria-label={t("captureNewItem")}><Plus size={24} /></button>}

      {captureOpen && selectedProduct && (
        <Modal title={t("captureWork")} subtitle={t("addToProduct", { product: selectedProduct.name })} onClose={() => setCaptureOpen(false)}>
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
      {productOpen && (
        <Modal title={t("manageProducts")} subtitle={t("productManagementHelp")} onClose={() => setProductOpen(false)} wide>
          <ProductManager
            products={products}
            selectedProductId={selectedProductId}
            onSelectProduct={(product) => {
              setSelectedProductId(product.id);
              clearItemPage();
            }}
          />
        </Modal>
      )}
      {connectionOpen && (
        <Modal title={t("accountSettings")} subtitle={t("accountSettingsHelp")} onClose={() => setConnectionOpen(false)}>
          <AccountPanel
            user={authQuery.data.user}
            onLoggedOut={() => window.location.reload()}
          />
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

function StatusNavItem({ children, label, count, active, onClick }: { children: ReactNode; label: string; count: number; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{children}<span>{label}</span><small>{count}</small></button>;
}

function ItemRow({
  item,
  sourceComponent,
  showAttachmentColumn,
  onOpen,
  onEdit,
  onNotice,
}: {
  item: WorkItem;
  sourceComponent: Component | undefined;
  showAttachmentColumn: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onNotice: (message: string) => void;
}) {
  const { formatTime, priorityLabel, statusLabel, t, typeLabel } = useI18n();
  const TypeIcon = TYPE_ICONS[item.type];
  const environment = item.environment;
  const overview = item.report?.overview ?? item.description;
  const logAttachmentCount = item.attachments.filter((attachment) => attachment.kind === "log").length;
  const logCount = Math.max(logAttachmentCount, item.diagnosticSummary?.logCount ?? 0);
  const contextPrimary = sourceComponent?.name ?? (environment ? platformName(environment.platform, t) : t("notSpecified"));
  const contextDetails = [
    sourceComponent && environment ? platformName(environment.platform, t) : undefined,
    environment?.appVersion ? `v${environment.appVersion}` : undefined,
    environment?.deviceModel,
    environment?.osVersion,
  ].filter(Boolean).join(" · ");
  return (
    <article
      className="item-row"
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button, a, input, select, textarea, summary, details, video, [role='dialog']")) return;
        onOpen();
      }}
    >
      <button className="item-row-main" onClick={onOpen} aria-label={t("openItem", { key: item.key })}>
        <span className={`type-icon type-${item.type}`} role="img" aria-label={typeLabel(item.type)}><TypeIcon size={15} /></span>
        <span className="item-copy">
          <span className="item-title-line">
            <code>{item.key}</code>
            <span className="item-title">{item.title}</span>
            <span className="item-evidence-summary">
              {item.type === "bug" && item.report?.reproductionSteps && <small className="evidence-strong">{t("hasReproduction")}</small>}
              {logCount > 0 && <small>{t("logCount", { count: logCount })}</small>}
              {(item.diagnosticSummary?.contextEntryCount ?? 0) > 0 && <small>{t("contextCount", { count: item.diagnosticSummary.contextEntryCount })}</small>}
            </span>
          </span>
          <span className={`item-description ${overview ? "" : "muted"}`}>{overview || t("noDescription")}</span>
        </span>
      </button>
      <ItemMediaStrip itemKey={item.key} attachments={item.attachments} preserveColumn={showAttachmentColumn} />
      <span className="item-context">
        <strong>{contextPrimary}</strong>
        <small>{contextDetails || t("noEnvironmentShort")}</small>
      </span>
      <span className="item-state">
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <small><i className={`priority-dot priority-${item.priority}`} /> {priorityLabel(item.priority)}</small>
      </span>
      <span className="item-updated">{formatTime(item.updatedAt)}</span>
      <span className="item-row-actions">
        <ItemRowActions item={item} onEdit={onEdit} onNotice={onNotice} />
      </span>
    </article>
  );
}
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 520px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 520px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
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
  const narrow = useNarrowViewport();
  const mediaAttachments = attachments.filter(
    (attachment): attachment is WorkItemAttachment & { readonly kind: "image" | "video" } => attachment.kind !== "log",
  );
  // Two thumbnails cover the common "before and after" pair; the rest are
  // counted on the last one rather than shrinking every tile. A phone only has
  // room for one before the title starts truncating mid-word.
  const visible = mediaAttachments.slice(0, narrow ? 1 : 2);
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
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id],
    queryFn: () => api.downloadAttachment(itemKey, attachment.id),
    enabled: (attachment.kind === "image" && isNearViewport) || previewRequested,
    staleTime: Infinity,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!contentQuery.data) return undefined;
    const url = URL.createObjectURL(contentQuery.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [contentQuery.data]);

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
        {attachment.kind === "image" && objectUrl && <img src={objectUrl} alt="" loading="lazy" decoding="async" />}
        {!objectUrl && <span className="media-file-tile">{contentQuery.isLoading ? <LoaderCircle className="spin" size={18} /> : <Icon size={18} />}<small>{attachment.filename.split(".").pop()?.toUpperCase()}</small></span>}
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

function ItemRowActions({ item, onEdit, onNotice }: { item: WorkItem; onEdit: () => void; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const { statusLabel, t, transitionLabel } = useI18n();
  const actions = TRANSITIONS[item.status];
  const primaryAction = actions[0];
  // Destructive last, whatever order the table lists them in.
  const secondaryActions = actions.slice(1).filter((action) => action.tone !== "danger");
  const destructiveActions = actions.slice(1).filter((action) => action.tone === "danger");
  const moreActionsRef = useRef<HTMLDetailsElement>(null);
  const mutation = useMutation({
    mutationFn: (action: TransitionAction) => api.transitionItem(item.key, action),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["items"] }),
        queryClient.invalidateQueries({ queryKey: ["item", item.key] }),
        queryClient.invalidateQueries({ queryKey: ["timeline", item.key] }),
      ]);
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
    onError: (error) => onNotice(errorMessage(error, t("somethingWentWrong"))),
  });

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
              mutation.mutate(primaryAction);
            }}
          >
            <Check size={14} /> {quickActionLabel(item.status, t)}
          </button>
        )}
        {secondaryActions.map((action) => (
          <button
            key={`${action.to}-${action.reason}`}
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              moreActionsRef.current?.removeAttribute("open");
              mutation.mutate(action);
            }}
          >
            {transitionLabel(action.label)}
          </button>
        ))}
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
              mutation.mutate(action);
            }}
          >
            {transitionLabel(action.label)}
          </button>
        ))}
      </div>
    </details>
  );
}
function platformName(platform: WorkItemEnvironment["platform"], t: ReturnType<typeof useI18n>["t"]): string {
  if (platform === "android") return t("android");
  if (platform === "macos") return t("macos");
  if (platform === "web") return t("web");
  if (platform === "server") return t("server");
  if (platform === "shared") return t("shared");
  return t("other");
}

function mediaNumberLabel(kind: "image" | "video", displayNumber: number, t: ReturnType<typeof useI18n>["t"]): string {
  return t(kind === "image" ? "imageNumber" : "videoNumber", { number: displayNumber });
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
  openInEdit,
  onClose,
  onItemLoaded,
  onNotice,
}: {
  itemKey: string | null;
  openInEdit: boolean;
  onClose: () => void;
  onItemLoaded: (item: WorkItem) => void;
  onNotice: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { actorLabel, eventLabel, formatTime, priorityLabel, statusLabel, t, transitionLabel, typeLabel } = useI18n();
  const itemQuery = useQuery({ queryKey: ["item", itemKey], queryFn: () => api.getItem(itemKey!), enabled: Boolean(itemKey) });
  const timelineQuery = useQuery({ queryKey: ["timeline", itemKey], queryFn: () => api.getTimeline(itemKey!), enabled: Boolean(itemKey) });
  const item = itemQuery.data;
  const componentsQuery = useQuery({
    queryKey: ["components", item?.productId],
    queryFn: () => api.listComponents(item!.productId),
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

  const transitionMutation = useMutation({
    mutationFn: (action: TransitionAction) => api.transitionItem(itemKey!, action),
    onSuccess: async (updated) => {
      await refreshItem();
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
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
  const actions = TRANSITIONS[item.status];
  const primaryAction = actions[0];
  const secondaryActions = actions.slice(1);
  const sourceComponent = componentsQuery.data?.find((component) => component.id === item.sourceComponentId);
  const affectedComponents = (componentsQuery.data ?? []).filter((component) => item.affectedComponentIds.includes(component.id));
  const createdEvent = timelineQuery.data?.events.find((event) => event.eventType === "item_created");
  const sdkDiagnostics = diagnosticsFromEvent(createdEvent);
  const logAttachments = item.attachments.filter((attachment) => attachment.kind === "log");
  const mediaAttachments = item.attachments.filter((attachment) => attachment.kind !== "log");
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
              onClick={() => transitionMutation.mutate(primaryAction)}
              title={transitionLabel(primaryAction.label)}
            >
              {transitionMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {quickActionLabel(item.status, t)}
            </button>
          )}
          <button className="secondary-button" onClick={() => setEditing(true)}>{t("edit")}</button>
          <details className="detail-more-menu" ref={moreActionsRef}>
            <summary className="secondary-button" aria-label={t("moreActions")} title={t("moreActions")}><MoreHorizontal size={19} /></summary>
            <div className="detail-more-menu-popover">
              {secondaryActions.length === 0 && <span>{t("noMoreActions")}</span>}
              {secondaryActions.map((action) => (
                <button
                  key={`${action.to}-${action.reason}`}
                  type="button"
                  className={action.tone === "danger" ? "danger" : undefined}
                  disabled={transitionMutation.isPending}
                  onClick={() => {
                    moreActionsRef.current?.removeAttribute("open");
                    transitionMutation.mutate(action);
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
              <div><p className="eyebrow">{typeLabel(item.type)} · {priorityLabel(item.priority)}</p><h2>{item.title}</h2></div>
            </div>
            {/* Read the item before looking at the evidence: the report comes first,
                then the captured context, and the attachments back both of them up. */}
            <ReportDetails type={item.type} report={item.report} fallbackDescription={item.description} />
            <section className="environment-block">
              <h3>{t("capturedContext")}</h3>
              {item.environment || sourceComponent || affectedComponents.length > 0 ? (
                <div className="context-grid">
                  {sourceComponent && <span><small>{t("sourceComponent")}</small>{sourceComponent.name}</span>}
                  {affectedComponents.length > 0 && <span><small>{t("affectedComponents")}</small>{affectedComponents.map((component) => component.name).join("、")}</span>}
                  {item.environment && <span><small>{t("platform")}</small>{t(item.environment.platform)}</span>}
                  {item.environment?.appVersion && <span><small>{t("version")}</small>{item.environment.appVersion}</span>}
                  {item.environment?.buildNumber && <span><small>{t("buildNumber")}</small>{item.environment.buildNumber}</span>}
                  {item.environment?.osVersion && <span><small>{t("operatingSystem")}</small>{item.environment.osVersion}</span>}
                  {item.environment?.deviceModel && <span><small>{t("device")}</small>{item.environment.deviceModel}</span>}
                  {item.environment?.sourceRevision && <span><small>{t("sourceRevision")}</small><code>{item.environment.sourceRevision}</code></span>}
                  {Object.entries(item.environment?.metadata ?? {}).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}
                </div>
              ) : <p className="section-empty">{t("noEnvironment")}</p>}
            </section>
            <AttachmentSection
              itemKey={item.key}
              attachments={mediaAttachments}
              title={t("mediaAttachments")}
              help={t("mediaAttachmentsHelp")}
              emptyMessage={t("noMediaAttachments")}
            />
            <DiagnosticDetails
              itemKey={item.key}
              logs={sdkDiagnostics.logs}
              context={sdkDiagnostics.context}
              attachments={logAttachments}
            />
            <section className="timeline-block">
              <header className="timeline-head">
                <h3>{t("timeline")}</h3>
                <small>{t("newestFirst")}</small>
              </header>
              {timelineQuery.isLoading && <LoaderCircle className="spin" size={18} />}
              <div className="timeline">
                {groupTimeline(timelineQuery.data?.events ?? []).map(({ id, event, count, filenames }) => (
                  <div className="timeline-event" key={id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {event.eventType === "status_changed"
                          ? `${event.fromStatus ? statusLabel(event.fromStatus) : t("status")} → ${event.toStatus ? statusLabel(event.toStatus) : t("updated")}`
                          : count > 1
                            ? t("eventRepeated", { event: eventLabel(event.eventType), count })
                            : eventLabel(event.eventType)}
                      </strong>
                      <p>{actorLabel(event.actorKind)} · {formatTime(event.createdAt)}</p>
                      {filenames.length > 0 && <p className="timeline-files">{filenames.join("、")}</p>}
                      {event.eventType === "analysis_appended" && <AnalysisDetails payload={event.payload} />}
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
    </section>
  );
}

function AnalysisDetails({ payload }: { payload: Readonly<Record<string, unknown>> }) {
  const { t } = useI18n();
  const conclusion = typeof payload.conclusion === "string" ? payload.conclusion : "";
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.filter((entry): entry is string => typeof entry === "string") : [];
  const risks = Array.isArray(payload.risks) ? payload.risks.filter((entry): entry is string => typeof entry === "string") : [];
  if (!conclusion && evidence.length === 0 && risks.length === 0) return null;
  return (
    <div className="analysis-details">
      {conclusion && <div><span>{t("analysisConclusion")}</span><p>{conclusion}</p></div>}
      {evidence.length > 0 && <div><span>{t("analysisEvidence")}</span><ul>{evidence.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul></div>}
      {risks.length > 0 && <div><span>{t("analysisRisks")}</span><ul>{risks.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul></div>}
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
          {overview && <article className="wide"><small>{t(copy.overview)}</small><p>{overview}</p></article>}
          {hasBugDetails && report?.reproductionSteps && <article><small>{t("reproductionSteps")}</small><p>{report.reproductionSteps}</p></article>}
          {hasBugDetails && report?.expectedOutcome && <article><small>{t("expectedOutcome")}</small><p>{report.expectedOutcome}</p></article>}
          {hasBugDetails && report?.impact && <article><small>{t("impact")}</small><p>{report.impact}</p></article>}
          {hasBugDetails && report?.occurrenceFrequency && <article><small>{t("occurrenceFrequency")}</small><p>{frequencyLabels[report.occurrenceFrequency]}</p></article>}
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
  const hasDiagnostics = logs.length > 0 || attachments.length > 0 || Object.keys(context).length > 0;
  return (
    <section className="attachment-block diagnostic-detail-block">
      <header>
        <div><h3>{t("diagnostics")}</h3><p>{t("diagnosticDetailHelp")}</p></div>
      </header>
      {!hasDiagnostics ? <p className="section-empty">{t("noDiagnostics")}</p> : (
        <div className="diagnostic-detail-content">
          {Object.keys(context).length > 0 && (
            <details className="diagnostic-context-details">
              <summary>{t("runtimeContext")}<small>{t("entryCount", { count: Object.keys(context).length })}</small></summary>
              <div className="diagnostic-context-grid">{Object.entries(context).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>
            </details>
          )}
          {logs.length > 0 && (
            <details className="structured-log-details" open>
              <summary>{t("sdkLogs")}<small>{t("logCount", { count: logs.length })}</small></summary>
              <div className="structured-log-list">
                {logs.map((log, index) => (
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
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addIncomingFiles(Array.from(event.dataTransfer.files));
      }}
    >
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
  onDraft: (draft: CaptureDraft) => void;
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
  const existingMediaAttachments = existingAttachments.filter((attachment) => attachment.kind !== "log");
  const selectedLogFiles = files.filter(isDiagnosticFile);
  const selectedMediaFiles = files.filter((file) => !isDiagnosticFile(file));
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
      <label><FieldLabel required>{t("whatNeedsAttention")}</FieldLabel><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus data-initial-focus /></label>
      <section className="attachment-picker-block capture-attachment-block">
        <div className="capture-attachment-heading">
          <div className="capture-attachment-copy"><strong><FieldLabel>{t("mediaAttachments")}</FieldLabel></strong><p>{t("mediaAttachmentsHelp")}</p></div>
          <FilePicker
            files={selectedMediaFiles}
            onFiles={(nextMediaFiles) => onFiles([...selectedLogFiles, ...nextMediaFiles])}
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
            onFiles={(nextMediaFiles) => onFiles([...selectedLogFiles, ...nextMediaFiles])}
            startingNumbers={{
              image: Math.max(0, ...existingMediaAttachments.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.displayNumber)),
              video: Math.max(0, ...existingMediaAttachments.filter((attachment) => attachment.kind === "video").map((attachment) => attachment.displayNumber)),
            }}
          />
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
            onFiles={(nextLogFiles) => onFiles([...nextLogFiles, ...selectedMediaFiles])}
            remaining={remainingAttachments}
            showCamera={false}
            accept=".log,.txt,.json,text/plain,application/json"
            allowedExtensions={["log", "txt", "json"]}
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
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addIncomingFiles(Array.from(event.dataTransfer.files));
      }}
    >
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
      <div className="form-footer">
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

function FilePicker({
  files = [],
  onFiles,
  remaining,
  disabled = false,
  showSelectedFiles = true,
  showCamera = true,
  accept = "image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.txt,.json",
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
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const limit = FILE_LIMITS_MIB[extension];
      if (!limit || (allowedExtensions && !allowedExtensions.includes(extension))) {
        nextError ??= t("unsupportedFile", { filename: file.name });
        continue;
      }
      if (file.size > limit * 1024 * 1024) {
        nextError ??= t("fileTooLarge", { filename: file.name, size: limit });
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

function AttachmentSection({
  itemKey,
  attachments,
  title,
  help,
  emptyMessage,
}: {
  itemKey: string;
  attachments: readonly WorkItemAttachment[];
  title?: string;
  help?: string;
  emptyMessage?: string;
}) {
  const { t } = useI18n();
  return (
    <section className="attachment-block">
      <header>
        <div><h3>{title ?? t("attachments")}</h3><p>{help ?? t("attachmentHelp")}</p></div>
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
  const shouldLoad = attachment.kind === "image" ? isNearViewport : previewRequested;
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id],
    queryFn: () => api.downloadAttachment(
      itemKey,
      attachment.id,
      attachment.kind === "log" ? { start: 0, end: 65_535 } : undefined,
    ),
    enabled: shouldLoad,
    staleTime: Infinity,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [logText, setLogText] = useState("");
  const referenceLabel = attachment.kind === "log"
    ? null
    : mediaNumberLabel(attachment.kind, attachment.displayNumber, t);

  useEffect(() => {
    if (!contentQuery.data) return undefined;
    if (attachment.kind === "log") {
      let active = true;
      void contentQuery.data.text().then((value) => {
        if (active) setLogText(value.slice(0, 4_000));
      });
      return () => { active = false; };
    }
    const url = URL.createObjectURL(contentQuery.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.kind, contentQuery.data]);

  const download = async () => {
    const blob = attachment.kind === "log"
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

  const saveAnnotation = async (annotated: File) => {
    setReplacing(true);
    setReplaceError("");
    try {
      await api.replaceAttachment(itemKey, attachment.id, annotated);
      // The cached blob is keyed by attachment id and never goes stale on its
      // own, so drop it or the card keeps showing the image before the marks.
      queryClient.removeQueries({ queryKey: ["attachment-content", itemKey, attachment.id] });
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
        {!shouldLoad && attachment.kind === "image" && <span><ImageIcon size={22} /></span>}
        {contentQuery.isLoading && <span><LoaderCircle className="spin" size={18} /> {t("attachmentLoading")}</span>}
        {contentQuery.isError && <button type="button" className="attachment-load-button attachment-error" onClick={() => void contentQuery.refetch()}>{t("retryAttachment")}</button>}
        {attachment.kind === "image" && objectUrl && (
          <button type="button" className="attachment-media-open" onClick={() => setViewerOpen(true)} aria-label={t("previewAttachment", { filename: attachment.filename })}>
            <img src={objectUrl} alt={attachment.filename} />
            <span><Maximize2 size={15} /> {t("preview")}</span>
          </button>
        )}
        {attachment.kind === "video" && objectUrl && (
          <div className="attachment-video-preview">
            <video src={objectUrl} controls preload="metadata" />
            <button type="button" onClick={() => setViewerOpen(true)} aria-label={t("previewAttachment", { filename: attachment.filename })} title={t("preview")}><Maximize2 size={16} /></button>
          </div>
        )}
        {attachment.kind === "log" && logText && <pre>{logText}</pre>}
      </div>
      <footer>
        <Icon size={15} />
        <span><strong>{referenceLabel ? `${referenceLabel} · ` : ""}{attachment.filename}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span>
        <span className="attachment-actions">
          <button type="button" onClick={() => void download()} aria-label={`${t("download")} ${attachment.filename}`} title={t("download")}><Download size={15} /></button>
          {onReplaced && attachment.kind === "image" && isAnnotatableImage({ name: attachment.filename, type: attachment.contentType }) && (
            <button
              type="button"
              disabled={!contentQuery.data || replacing}
              onClick={() => setAnnotating(true)}
              aria-label={t("annotateTitle")}
              title={t("annotate")}
            >{replacing ? <LoaderCircle className="spin" size={15} /> : <Highlighter size={15} />}</button>
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
      {viewerOpen && objectUrl && attachment.kind !== "log" && (
        <MediaLightbox title={`${referenceLabel} · ${attachment.filename}`} onClose={() => setViewerOpen(false)}>
          {attachment.kind === "image" && <img src={objectUrl} alt={attachment.filename} />}
          {attachment.kind === "video" && <video src={objectUrl} controls autoPlay playsInline preload="metadata" />}
        </MediaLightbox>
      )}
    </article>
  );
}

function ProductManager({
  products,
  selectedProductId,
  onSelectProduct,
}: {
  products: readonly Product[];
  selectedProductId: string;
  onSelectProduct: (product: Product) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [activeProductId, setActiveProductId] = useState(selectedProductId || products[0]?.id || "");
  const [adding, setAdding] = useState(false);
  const activeProduct = products.find((product) => product.id === activeProductId);

  return (
    <div className="product-manager">
      <aside className="product-manager-list">
        <p className="sidebar-label">{t("existingProducts")}</p>
        {products.map((product) => (
          <button
            key={product.id}
            className={activeProductId === product.id && !adding ? "active" : ""}
            onClick={() => { setActiveProductId(product.id); setAdding(false); }}
          >
            <span><strong>{product.name}</strong><small>{product.keyPrefix}</small></span>
            <ChevronRight size={16} />
          </button>
        ))}
        <button className={`product-manager-add ${adding ? "active" : ""}`} onClick={() => setAdding(true)}><Plus size={15} /> {t("addProduct")}</button>
      </aside>
      <section className="product-manager-content">
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
          <ProductSettings key={activeProduct.id} product={activeProduct} onSelected={() => onSelectProduct(activeProduct)} />
        )}
      </section>
    </div>
  );
}

function ProductSettings({ product, onSelected }: { product: Product; onSelected: () => void }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [activeSettingsTab, setActiveSettingsTab] = useState<"product" | "components" | "tokens">("product");
  const [name, setName] = useState(product.name);
  const [newComponentName, setNewComponentName] = useState("");
  const [newComponentKind, setNewComponentKind] = useState<ComponentKind>("android");
  const [addingComponent, setAddingComponent] = useState(false);
  const componentsQuery = useQuery({
    queryKey: ["components", product.id],
    queryFn: () => api.listComponents(product.id),
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
      </div>
      {activeSettingsTab === "tokens" ? (
        <SdkTokenSettings product={product} />
      ) : activeSettingsTab === "product" ? (
        <section className="product-settings-section" role="tabpanel">
          <header><div><p className="eyebrow">{product.keyPrefix}</p><h3>{t("productInformation")}</h3></div></header>
          <div className="product-settings-grid">
            <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{t("itemPrefix")}<input value={product.keyPrefix} readOnly /><small>{t("prefixLockedHelp")}</small></label>
          </div>
          {productMutation.isError && <InlineError message={errorMessage(productMutation.error, t("somethingWentWrong"))} />}
          <button className="primary-button settings-save" disabled={!name.trim() || name.trim() === product.name || productMutation.isPending} onClick={() => productMutation.mutate()}>
            {productMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {t("saveProduct")}
          </button>
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
  useEffect(() => {
    setName(component.name);
    setKind(component.kind);
  }, [component.kind, component.name]);
  const mutation = useMutation({
    mutationFn: () => api.updateComponent(component.productId, component.id, { name, kind }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["components", component.productId] }),
  });
  const changed = name.trim() !== component.name || kind !== component.kind;
  return (
    <div className="component-settings-row">
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("componentName")} />
      <select value={kind} onChange={(event) => setKind(event.target.value as ComponentKind)} aria-label={t("componentKind")}>
        {COMPONENT_KINDS.map((value) => <option key={value} value={value}>{t(value)}</option>)}
      </select>
      <button className="secondary-button" disabled={!changed || !name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
      </button>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
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
      <label>{t("username")}<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("usernamePlaceholder")} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
      <label>{t("password")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("passwordPlaceholder")} autoComplete="current-password" required /></label>
      {loginError && <InlineError message={loginError} />}
      <p className="privacy-note"><KeyRound size={14} /> {t("noRegistration")}</p>
      <button className="primary-button wide" disabled={mutation.isPending || !username.trim() || !password}>
        {mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {t("signIn")}
      </button>
    </form>
  );
}

function AccountPanel({ user, onLoggedOut }: { user: AuthenticatedUser; onLoggedOut: () => void }) {
  const { t } = useI18n();
  const mutation = useMutation({ mutationFn: api.logout, onSuccess: onLoggedOut });
  return (
    <div className="account-panel">
      <div className="account-identity">
        <span><UserRound size={21} /></span>
        <div><small>{t("signedInAs")}</small><strong>{user.username}</strong><em>{t("administratorRole")}</em></div>
      </div>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <button className="secondary-button wide" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />} {t("signOut")}
      </button>
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
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
      <section className={`modal ${wide ? "wide" : ""}`}>
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
