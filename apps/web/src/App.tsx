import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CirclePause,
  ClipboardCheck,
  Download,
  FileText,
  ImageIcon,
  Inbox,
  KeyRound,
  Languages,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Menu,
  Paperclip,
  Plus,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  Video,
  X,
} from "lucide-react";

import { api, ApiError, getAdminToken, setAdminToken } from "./api";
import {
  captureDraftStorageKey,
  hasCaptureDraftContent,
  parseCaptureDraft,
  type CaptureDraft,
  type EnvironmentDraft,
} from "./capture-draft";
import {
  COMPONENT_KINDS,
  ITEM_PRIORITIES,
  ITEM_STATUSES,
  ITEM_TYPES,
  type Product,
  type Component,
  type ComponentKind,
  type TransitionAction,
  type WorkItem,
  type WorkItemAttachment,
  type WorkItemEnvironment,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkItemType,
} from "./types";
import { useI18n } from "./i18n";
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

const TRANSITIONS: Record<WorkItemStatus, readonly TransitionAction[]> = {
  inbox: [{ label: "Move to ready", to: "ready", reason: "triaged", tone: "primary" }],
  ready: [
    { label: "Start work", to: "in_progress", reason: "claim", tone: "primary" },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    { label: "Move to inbox", to: "inbox", reason: "reopened" },
  ],
  in_progress: [
    {
      label: "Submit for verification",
      to: "pending_verification",
      reason: "resolution_submitted",
      tone: "primary",
    },
    { label: "Put on hold", to: "on_hold", reason: "request_human_input" },
    { label: "Release", to: "ready", reason: "released" },
  ],
  on_hold: [
    { label: "Resume work", to: "in_progress", reason: "resume", tone: "primary" },
    { label: "Return to ready", to: "ready", reason: "reopened" },
  ],
  pending_verification: [
    { label: "Verify & close", to: "done", reason: "verification_passed", tone: "positive" },
    { label: "Needs more work", to: "ready", reason: "verification_failed" },
  ],
  done: [{ label: "Reopen", to: "ready", reason: "reopened", tone: "primary" }],
  cancelled: [{ label: "Restore", to: "inbox", reason: "restored", tone: "primary" }],
};

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

function environmentPayload(draft: EnvironmentDraft): WorkItemEnvironment | undefined {
  const appVersion = draft.appVersion.trim();
  const buildNumber = draft.buildNumber.trim();
  const sourceRevision = draft.sourceRevision.trim();
  const osVersion = draft.osVersion.trim();
  const deviceModel = draft.deviceModel.trim();
  if (!draft.platform) return undefined;
  return {
    platform: draft.platform,
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
  };
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

export function App() {
  const queryClient = useQueryClient();
  const { statusLabel, t, typeLabel } = useI18n();
  const [selectedProductId, setSelectedProductId] = useState(() => localStorage.getItem("missiongo.product") ?? "");
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<WorkItemType | "all">("all");
  const [search, setSearch] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const listScrollTopRef = useRef(0);

  const openItemPage = (itemKey: string) => {
    const workspace = workspaceRef.current;
    listScrollTopRef.current = workspace && workspace.scrollHeight > workspace.clientHeight
      ? workspace.scrollTop
      : window.scrollY;
    setSelectedItemKey(itemKey);
    requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: 0 });
      window.scrollTo({ top: 0 });
    });
  };

  const closeItemPage = () => {
    setSelectedItemKey(null);
    requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: listScrollTopRef.current });
      window.scrollTo({ top: listScrollTopRef.current });
    });
  };

  const productsQuery = useQuery({ queryKey: ["products"], queryFn: api.listProducts });
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

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const itemsQuery = useQuery({
    queryKey: ["items", selectedProductId],
    queryFn: () => api.listItems(selectedProductId),
    enabled: Boolean(selectedProductId),
  });
  const items = itemsQuery.data?.items ?? [];
  const componentsQuery = useQuery({
    queryKey: ["components", selectedProductId],
    queryFn: () => api.listComponents(selectedProductId),
    enabled: Boolean(selectedProductId),
  });
  const componentsById = useMemo(
    () => new Map((componentsQuery.data ?? []).map((component) => [component.id, component])),
    [componentsQuery.data],
  );
  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        (statusFilter === "all" || item.status === statusFilter) &&
        (typeFilter === "all" || item.type === typeFilter) &&
        (!query || `${item.key} ${item.title} ${item.description}`.toLowerCase().includes(query)),
    );
  }, [items, search, statusFilter, typeFilter]);

  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const openCount = items.filter((item) => !["done", "cancelled"].includes(item.status)).length;
  const verifyCount = items.filter((item) => item.status === "pending_verification").length;
  const needsConnection = productsQuery.error instanceof ApiError && productsQuery.error.status === 401;

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

  const refresh = async () => {
    await queryClient.invalidateQueries();
  };

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

  if (needsConnection) {
    return (
      <main className="connection-page">
        <div className="page-language"><LanguageSwitch /></div>
        <Brand />
        <section className="connection-card">
          <div className="round-icon"><KeyRound size={24} /></div>
          <p className="eyebrow">{t("privateWorkspace")}</p>
          <h1>{t("connectTitle")}</h1>
          <p>{t("connectBody")}</p>
          <TokenForm onSaved={refresh} />
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
    <div className="app-shell">
      <header className="topbar">
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
              setSelectedItemKey(null);
            }}
            aria-label={t("selectedProduct")}
          >
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
        <div className="header-search">
          <Search size={17} />
          <input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchItems")} />
          <kbd>⌘ K</kbd>
        </div>
        <LanguageSwitch />
        <button className="icon-button" onClick={() => setConnectionOpen(true)} aria-label={t("connectionSettings")}>
          <Settings2 size={19} />
        </button>
        <button className="primary-button capture-button" onClick={() => setCaptureOpen(true)}>
          <Plus size={18} /> <span>{t("capture")}</span>
        </button>
      </header>

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-mobile-head mobile-only">
          <Brand compact />
          <button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label={t("closeNavigation")}><X size={20} /></button>
        </div>
        <nav aria-label={t("workspace")}>
          <p className="sidebar-label">{t("workspace")}</p>
          <StatusNavItem label={t("allItems")} count={items.length} active={statusFilter === "all"} onClick={() => selectStatus("all")}>
            <ListTodo size={17} />
          </StatusNavItem>
          {ITEM_STATUSES.filter((status) => status !== "cancelled").map((status) => {
            const Icon = STATUS_ICONS[status];
            return (
              <StatusNavItem
                key={status}
                label={statusLabel(status)}
                count={items.filter((item) => item.status === status).length}
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
        <button className="text-button add-product" onClick={() => setProductOpen(true)}><Settings2 size={15} /> {t("manageProductsEntry")}</button>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim mobile-only" onClick={() => setSidebarOpen(false)} aria-label={t("closeNavigation")} />}

      <main className={`workspace ${selectedItemKey ? "detail-open" : ""}`} ref={workspaceRef}>
        <section className="list-page" hidden={Boolean(selectedItemKey)}>
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
            <button className={typeFilter === "all" ? "active" : ""} onClick={() => setTypeFilter("all")}>{t("allTypes")}</button>
            {ITEM_TYPES.map((type) => (
              <button key={type} className={typeFilter === type ? "active" : ""} onClick={() => setTypeFilter(type)}>
                {typeLabel(type)}
              </button>
            ))}
          </div>

          <section className="list-surface" aria-label={t("workItems")}>
            <div className="list-columns" aria-hidden="true">
              <span>{t("itemInformation")}</span>
              <span>{t("capturedContext")}</span>
              <span>{t("attachments")}</span>
              <span>{t("status")}</span>
              <span>{t("quickAction")}</span>
            </div>
            <div className="item-list">
              {itemsQuery.isLoading && <ListSkeleton />}
              {itemsQuery.isError && <InlineError message={errorMessage(itemsQuery.error, t("somethingWentWrong"))} />}
              {!itemsQuery.isLoading && visibleItems.length === 0 && (
                <div className="empty-list">
                  <div className="round-icon"><Lightbulb size={22} /></div>
                  <h2>{items.length === 0 ? t("captureFirstSpark") : t("noMatchingItems")}</h2>
                  <p>{items.length === 0 ? t("firstSparkHelp") : t("noMatchHelp")}</p>
                  {items.length === 0 && <button className="primary-button" onClick={() => setCaptureOpen(true)}><Plus size={17} /> {t("captureItem")}</button>}
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  sourceComponent={item.sourceComponentId ? componentsById.get(item.sourceComponentId) : undefined}
                  onOpen={() => openItemPage(item.key)}
                  onNotice={setNotice}
                />
              ))}
            </div>
          </section>
        </section>

        {selectedItemKey && (
          <div className="detail-page-shell">
            <DetailPane itemKey={selectedItemKey} onClose={closeItemPage} onNotice={setNotice} />
          </div>
        )}
      </main>

      <button className="mobile-fab mobile-only" onClick={() => setCaptureOpen(true)} aria-label={t("captureNewItem")}><Plus size={24} /></button>

      {captureOpen && selectedProduct && (
        <Modal title={t("captureWork")} subtitle={t("addToProduct", { product: selectedProduct.name })} onClose={() => setCaptureOpen(false)}>
          <CaptureForm
            product={selectedProduct}
            onCreated={(item, failedUploads) => {
              setCaptureOpen(false);
              openItemPage(item.key);
              setNotice(
                failedUploads > 0
                  ? t("uploadPartial", { key: item.key, count: failedUploads })
                  : t("capturedInInbox", { key: item.key }),
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
              setSelectedItemKey(null);
            }}
          />
        </Modal>
      )}
      {connectionOpen && (
        <Modal title={t("connection")} subtitle={t("administratorAccess")} onClose={() => setConnectionOpen(false)}>
          <TokenForm
            onSaved={async () => {
              setConnectionOpen(false);
              await refresh();
              setNotice(t("connectionUpdated"));
            }}
          />
        </Modal>
      )}
      {notice && <div className="toast" role="status"><Check size={16} /> {notice}<button onClick={() => setNotice(null)} aria-label={t("dismiss")}><X size={14} /></button></div>}
    </div>
  );
}

function LanguageSwitch() {
  const { locale, t, toggleLocale } = useI18n();
  return (
    <button className="language-button" onClick={toggleLocale} aria-label={t("switchLanguage")} title={t("switchLanguage")}>
      <Languages size={17} /><span>{locale === "zh-CN" ? "EN" : "中"}</span>
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
  onOpen,
  onNotice,
}: {
  item: WorkItem;
  sourceComponent: Component | undefined;
  onOpen: () => void;
  onNotice: (message: string) => void;
}) {
  const { formatTime, priorityLabel, statusLabel, t, typeLabel } = useI18n();
  const TypeIcon = TYPE_ICONS[item.type];
  const environment = item.environment;
  const contextPrimary = sourceComponent?.name ?? (environment ? platformName(environment.platform, t) : t("notSpecified"));
  const contextDetails = [
    sourceComponent && environment ? platformName(environment.platform, t) : undefined,
    environment?.appVersion ? `v${environment.appVersion}` : undefined,
    environment?.deviceModel,
    environment?.osVersion,
  ].filter(Boolean).join(" · ");
  return (
    <article className="item-row">
      <button className="item-row-main" onClick={onOpen} aria-label={t("openItem", { key: item.key })}>
        <span className={`type-icon type-${item.type}`}><TypeIcon size={17} /></span>
        <span className="item-copy">
          <span className="item-title-line"><code>{item.key}</code><span>{typeLabel(item.type)}</span></span>
          <span className="item-title">{item.title}</span>
          <span className={`item-description ${item.description ? "" : "muted"}`}>{item.description || t("noDescription")}</span>
        </span>
      </button>
      <span className="item-context">
        <strong>{contextPrimary}</strong>
        <small>{contextDetails || t("noEnvironmentShort")}</small>
      </span>
      <ItemMediaStrip itemKey={item.key} attachments={item.attachments} onOpen={onOpen} />
      <span className="item-state">
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <small><i className={`priority-dot priority-${item.priority}`} /> {priorityLabel(item.priority)}</small>
        <small>{t("updated")} {formatTime(item.updatedAt)}</small>
      </span>
      <span className="item-row-actions">
        <QuickTransitionButton item={item} onNotice={onNotice} />
        <button className="icon-button open-detail-button" onClick={onOpen} aria-label={t("openItem", { key: item.key })}>
          <ArrowRight size={17} />
        </button>
      </span>
    </article>
  );
}

function ItemMediaStrip({ itemKey, attachments, onOpen }: { itemKey: string; attachments: readonly WorkItemAttachment[]; onOpen: () => void }) {
  const { t } = useI18n();
  const visible = attachments.slice(0, 3);
  if (visible.length === 0) return <span className="item-media-strip empty"><Paperclip size={15} /> {t("noAttachmentsShort")}</span>;
  return (
    <span className="item-media-strip" aria-label={t("attachmentCount", { count: attachments.length })}>
      {visible.map((attachment, index) => (
        <ItemMediaThumbnail key={attachment.id} itemKey={itemKey} attachment={attachment} onOpen={onOpen} overflowCount={index === 2 ? attachments.length - visible.length : 0} />
      ))}
    </span>
  );
}

function ItemMediaThumbnail({
  itemKey,
  attachment,
  onOpen,
  overflowCount,
}: {
  itemKey: string;
  attachment: WorkItemAttachment;
  onOpen: () => void;
  overflowCount: number;
}) {
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id],
    queryFn: () => api.downloadAttachment(itemKey, attachment.id),
    enabled: attachment.kind === "image",
    staleTime: Infinity,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!contentQuery.data) return undefined;
    const url = URL.createObjectURL(contentQuery.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [contentQuery.data]);

  const Icon = attachment.kind === "video" ? Video : attachment.kind === "log" ? FileText : ImageIcon;
  return (
    <button className={`item-media-thumb media-${attachment.kind}`} onClick={onOpen} title={attachment.filename}>
      {attachment.kind === "image" && objectUrl && <img src={objectUrl} alt="" />}
      {!objectUrl && <span className="media-file-tile"><Icon size={18} /><small>{attachment.filename.split(".").pop()?.toUpperCase()}</small></span>}
      {overflowCount > 0 && <span className="media-overflow">+{overflowCount}</span>}
    </button>
  );
}

function QuickTransitionButton({ item, onNotice }: { item: WorkItem; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const { statusLabel, t, transitionLabel } = useI18n();
  const action = TRANSITIONS[item.status][0];
  const mutation = useMutation({
    mutationFn: () => api.transitionItem(item.key, action!),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["items"] }),
        queryClient.invalidateQueries({ queryKey: ["item", item.key] }),
        queryClient.invalidateQueries({ queryKey: ["timeline", item.key] }),
      ]);
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
  });
  if (!action) return null;
  return (
    <button
      className={`quick-action-button ${action.tone === "positive" ? "positive" : ""}`}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title={transitionLabel(action.label)}
    >
      {mutation.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
      {quickActionLabel(item.status, t)}
    </button>
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

function DetailPane({ itemKey, onClose, onNotice }: { itemKey: string | null; onClose: () => void; onNotice: (message: string) => void }) {
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

  useEffect(() => {
    if (!item) return;
    setEditing(false);
  }, [item]);

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
  const attachmentMutation = useMutation({
    mutationFn: async (files: readonly File[]) => Promise.allSettled(files.map((file) => api.uploadAttachment(itemKey!, file))),
    onSuccess: async (results) => {
      await refreshItem();
      const failed = results.filter((result) => result.status === "rejected").length;
      onNotice(failed > 0 ? t("uploadFailed", { count: failed }) : t("itemUpdated", { key: itemKey ?? "" }));
    },
  });

  if (!itemKey) {
    return null;
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
  return (
    <section className="detail-pane">
      <div className="detail-toolbar">
        <button className="secondary-button detail-back-button" onClick={onClose} aria-label={t("backToList")}><ArrowLeft size={17} /> {t("backToList")}</button>
        <code>{item.key}</code>
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <span className="toolbar-spacer" />
        {primaryAction && (
          <button
            className={`secondary-button toolbar-primary-action ${primaryAction.tone === "positive" ? "positive" : ""}`}
            disabled={transitionMutation.isPending}
            onClick={() => transitionMutation.mutate(primaryAction)}
            title={transitionLabel(primaryAction.label)}
          >
            {transitionMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {quickActionLabel(item.status, t)}
          </button>
        )}
        <button className="secondary-button" onClick={() => setEditing(true)}>{t("edit")}</button>
      </div>
      <div className="detail-scroll">
        <>
            <div className="detail-title-block">
              <span className={`type-icon large type-${item.type}`}><PrimaryIcon size={20} /></span>
              <div><p className="eyebrow">{typeLabel(item.type)} · {priorityLabel(item.priority)}</p><h2>{item.title}</h2></div>
            </div>
            <section className="description-block">
              <h3>{t("description")}</h3>
              <p className={!item.description ? "muted" : ""}>{item.description || t("noDescription")}</p>
            </section>
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
              attachments={item.attachments ?? []}
              uploading={attachmentMutation.isPending}
              onUpload={(files) => attachmentMutation.mutate(files)}
            />
            {secondaryActions.length > 0 && (
              <section className="next-action-block secondary-actions-block">
                <div><h3>{t("moreActions")}</h3></div>
                <div className="action-row">
                  {secondaryActions.map((action) => (
                  <button
                    key={`${action.to}-${action.reason}`}
                    className="secondary-button"
                    disabled={transitionMutation.isPending}
                    onClick={() => transitionMutation.mutate(action)}
                  >
                    {transitionMutation.isPending ? <LoaderCircle className="spin" size={16} /> : null}{transitionLabel(action.label)}
                  </button>
                  ))}
                </div>
              </section>
            )}
            <section className="timeline-block">
              <h3>{t("timeline")}</h3>
              {timelineQuery.isLoading && <LoaderCircle className="spin" size={18} />}
              <div className="timeline">
                {(timelineQuery.data?.events ?? []).map((event) => (
                  <div className="timeline-event" key={event.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{event.eventType === "status_changed" ? `${event.fromStatus ? statusLabel(event.fromStatus) : t("status")} → ${event.toStatus ? statusLabel(event.toStatus) : t("updated")}` : eventLabel(event.eventType)}</strong>
                      <p>{actorLabel(event.actorKind)} · {formatTime(event.createdAt)}</p>
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

function EditItemForm({ item, onSaved }: { item: WorkItem; onSaved: (failedUploads: number) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CaptureDraft>(() => ({
    title: item.title,
    description: item.description,
    type: item.type,
    priority: item.priority,
    sourceComponentId: item.sourceComponentId ?? "",
    environment: environmentDraft(item.environment),
  }));
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  const addIncomingFiles = (incoming: readonly File[]) => {
    const result = validateIncomingFiles(files, incoming, t, Math.max(0, 10 - item.attachments.length));
    setFiles(result.files);
    setFileError(result.error ?? null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      await api.updateItem(item.key, {
        title: draft.title,
        description: draft.description,
        type: draft.type,
        priority: draft.priority,
        sourceComponentId: draft.sourceComponentId || null,
        affectedComponentIds: draft.sourceComponentId
          ? [...new Set([draft.sourceComponentId, ...item.affectedComponentIds])]
          : item.affectedComponentIds,
        environment: environmentPayload(draft.environment) ?? null,
      });
      const uploads = await Promise.allSettled(files.map((file) => api.uploadAttachment(item.key, file)));
      return uploads.filter((result) => result.status === "rejected").length;
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
      />
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <div className="form-footer">
        <button className="primary-button" disabled={mutation.isPending || !draft.title.trim() || !draft.environment.platform}>
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
}) {
  const queryClient = useQueryClient();
  const { priorityLabel, t, typeLabel } = useI18n();
  const [componentFormOpen, setComponentFormOpen] = useState(false);
  const [componentName, setComponentName] = useState("");
  const [componentKind, setComponentKind] = useState<ComponentKind>("android");
  const componentsQuery = useQuery({ queryKey: ["components", productId], queryFn: () => api.listComponents(productId) });

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

  const componentMutation = useMutation({
    mutationFn: () => api.createComponent(productId, { name: componentName, kind: componentKind }),
    onSuccess: async (component) => {
      await queryClient.invalidateQueries({ queryKey: ["components", productId] });
      onDraft({
        ...draft,
        sourceComponentId: component.id,
        environment: { ...draft.environment, platform: component.kind },
      });
      setComponentName("");
      setComponentFormOpen(false);
    },
  });

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
        <label><span className="field-label">{t("platform")}<em>*</em></span>
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
            required
          >
            <option value="">{t("selectPlatform")}</option>
            {COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}
          </select>
        </label>
        <label>{t("sourceComponent")}
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
            {componentTreeEntries((componentsQuery.data ?? []).filter((component) => component.kind === draft.environment.platform)).map(({ component, depth }) => <option key={component.id} value={component.id}>{`${"— ".repeat(depth)}${component.name}`}</option>)}
          </select>
        </label>
        <label>{t("priority")}<select value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
      </div>
      <button type="button" className="text-button inline-add-component" onClick={() => setComponentFormOpen((value) => !value)}><Plus size={14} /> {t("addComponent")}</button>
      {componentFormOpen && (
        <div className="component-quick-form">
          <label>{t("componentName")}<input value={componentName} onChange={(event) => setComponentName(event.target.value)} placeholder={t("componentNamePlaceholder")} /></label>
          <label>{t("componentKind")}<select value={componentKind} onChange={(event) => setComponentKind(event.target.value as ComponentKind)}>{COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</select></label>
          <button type="button" className="secondary-button" disabled={!componentName.trim() || componentMutation.isPending} onClick={() => componentMutation.mutate()}>
            {componentMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createComponent")}
          </button>
        </div>
      )}
      {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
      <label>{t("whatNeedsAttention")}<input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus /></label>
      <label>{t("context")}<textarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t("contextPlaceholder")} rows={4} /></label>
      <div className="attachment-picker-block capture-attachment-block">
        <div><strong>{t("attachments")}</strong><p>{t("pasteDropHelp")}</p></div>
        <FilePicker files={files} onFiles={onFiles} remaining={attachmentLimit - files.length} showSelectedFiles={false} />
      </div>
      {files.length > 0 && <SelectedFilePreviews files={files} onFiles={onFiles} />}
      {fileError && <InlineError message={fileError} />}
      {existingItemKey && existingAttachments.length > 0 && (
        <AttachmentSection itemKey={existingItemKey} attachments={existingAttachments} uploading={false} allowUpload={false} onUpload={() => undefined} />
      )}
      <details className="capture-optional" open={hasOptionalEnvironmentDetails(draft.environment)}>
        <summary><ChevronRight size={16} /> <span><strong>{t("optionalDetails")}</strong><small>{t("optionalDetailsHelp")}</small></span></summary>
        <div className="capture-optional-body">
          <EnvironmentFields value={draft.environment} onChange={(value) => updateDraft("environment", value)} />
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
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (hasCaptureDraftContent(draft)) localStorage.setItem(storageKey, JSON.stringify(draft));
    else localStorage.removeItem(storageKey);
  }, [draft, storageKey]);

  const addIncomingFiles = (incoming: readonly File[]) => {
    const result = validateIncomingFiles(files, incoming, t);
    setFiles(result.files);
    setFileError(result.error ?? null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const item = await api.createItem({
        productId: product.id,
        title: draft.title,
        description: draft.description,
        type: draft.type,
        priority: draft.priority,
        ...(draft.sourceComponentId
          ? { sourceComponentId: draft.sourceComponentId, affectedComponentIds: [draft.sourceComponentId] }
          : {}),
        environment: environmentPayload(draft.environment)!,
      });
      const uploads = await Promise.allSettled(files.map((file) => api.uploadAttachment(item.key, file)));
      return { item, failedUploads: uploads.filter((result) => result.status === "rejected").length };
    },
    onSuccess: ({ item, failedUploads }) => {
      localStorage.removeItem(storageKey);
      onCreated(item, failedUploads);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
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
      <div className="form-footer"><button className="primary-button" disabled={mutation.isPending || !draft.title.trim() || !draft.environment.platform}>{mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {t("captureItem")}</button></div>
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
        <label>{t("appVersion")}<input value={value.appVersion} onChange={(event) => update("appVersion", event.target.value)} placeholder="1.4.0" maxLength={500} /></label>
        <label>{t("buildNumber")}<input value={value.buildNumber} onChange={(event) => update("buildNumber", event.target.value)} placeholder="10400" maxLength={500} /></label>
        <label>{t("osVersion")}<input value={value.osVersion} onChange={(event) => update("osVersion", event.target.value)} placeholder="Android 16 / macOS 16" maxLength={500} /></label>
        <label>{t("deviceModel")}<input value={value.deviceModel} onChange={(event) => update("deviceModel", event.target.value)} placeholder="Pixel 9 / Mac mini" maxLength={500} /></label>
        <label>{t("sourceRevision")}<input value={value.sourceRevision} onChange={(event) => update("sourceRevision", event.target.value)} placeholder="abc123" maxLength={500} /></label>
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
}: {
  files?: readonly File[];
  onFiles: (files: readonly File[]) => void;
  remaining: number;
  disabled?: boolean;
  showSelectedFiles?: boolean;
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
      if (!limit) {
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
      <label className={`secondary-button file-picker-button ${disabled || remaining < 1 ? "disabled" : ""}`}>
        {disabled ? <LoaderCircle className="spin" size={16} /> : <Paperclip size={16} />}
        {t("addAttachments")}
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,.log,.txt,.json"
          disabled={disabled || remaining < 1}
          onChange={(event) => {
            addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
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

function SelectedFilePreviews({ files, onFiles }: { files: readonly File[]; onFiles: (files: readonly File[]) => void }) {
  const { t } = useI18n();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

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
        {previews.map(({ file, url }, index) => {
          const isImage = file.type.startsWith("image/");
          const isVideo = file.type.startsWith("video/");
          return (
            <article className="selected-preview-card" key={`${file.name}-${file.size}-${file.lastModified}`}>
              <button type="button" className="selected-preview-media" onClick={() => setPreviewIndex(index)} aria-label={t("previewAttachment", { filename: file.name })}>
                {isImage && <img src={url} alt="" />}
                {isVideo && <video src={url} muted playsInline preload="metadata" />}
                {!isImage && !isVideo && <span><FileText size={25} /><small>{file.name.split(".").pop()?.toUpperCase()}</small></span>}
                <em>{t("preview")}</em>
              </button>
              <footer>
                <span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                <button type="button" onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={t("removeFile", { filename: file.name })}><X size={14} /></button>
              </footer>
            </article>
          );
        })}
      </div>
      {activePreview && (
        <div className="selected-media-lightbox" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewIndex(null); }}>
          <section role="dialog" aria-modal="true" aria-label={activePreview.file.name}>
            <header><strong>{activePreview.file.name}</strong><button type="button" onClick={() => setPreviewIndex(null)} aria-label={t("closePreview")}><X size={20} /></button></header>
            {activePreview.file.type.startsWith("image/") && <img src={activePreview.url} alt={activePreview.file.name} />}
            {activePreview.file.type.startsWith("video/") && <video src={activePreview.url} controls playsInline preload="metadata" />}
            {!activePreview.file.type.startsWith("image/") && !activePreview.file.type.startsWith("video/") && (
              <div className="selected-log-preview"><FileText size={34} /><p>{activePreview.file.name}</p><small>{formatBytes(activePreview.file.size)}</small></div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function AttachmentSection({
  itemKey,
  attachments,
  uploading,
  onUpload,
  allowUpload = true,
}: {
  itemKey: string;
  attachments: readonly WorkItemAttachment[];
  uploading: boolean;
  onUpload: (files: readonly File[]) => void;
  allowUpload?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="attachment-block">
      <header>
        <div><h3>{t("attachments")}</h3><p>{t("attachmentHelp")}</p></div>
        {allowUpload && <FilePicker onFiles={onUpload} remaining={Math.max(0, 10 - attachments.length)} disabled={uploading} />}
      </header>
      {attachments.length === 0 ? <p className="section-empty">{t("noAttachments")}</p> : (
        <div className="attachment-grid">
          {attachments.map((attachment) => <AttachmentCard key={attachment.id} itemKey={itemKey} attachment={attachment} />)}
        </div>
      )}
    </section>
  );
}

function AttachmentCard({ itemKey, attachment }: { itemKey: string; attachment: WorkItemAttachment }) {
  const { t } = useI18n();
  const contentQuery = useQuery({
    queryKey: ["attachment-content", itemKey, attachment.id],
    queryFn: () => api.downloadAttachment(itemKey, attachment.id),
    staleTime: Infinity,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [logText, setLogText] = useState("");

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
    const blob = contentQuery.data ?? await api.downloadAttachment(itemKey, attachment.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "video" ? Video : FileText;
  return (
    <article className={`attachment-card attachment-${attachment.kind}`}>
      <div className="attachment-preview">
        {contentQuery.isLoading && <span><LoaderCircle className="spin" size={18} /> {t("attachmentLoading")}</span>}
        {contentQuery.isError && <span className="attachment-error">{t("attachmentFailed")}</span>}
        {attachment.kind === "image" && objectUrl && <img src={objectUrl} alt={attachment.filename} />}
        {attachment.kind === "video" && objectUrl && <video src={objectUrl} controls preload="metadata" />}
        {attachment.kind === "log" && logText && <pre>{logText}</pre>}
      </div>
      <footer>
        <Icon size={15} />
        <span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span>
        <button type="button" onClick={() => void download()} aria-label={`${t("download")} ${attachment.filename}`} title={t("download")}><Download size={15} /></button>
      </footer>
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
  const [name, setName] = useState(product.name);
  const [newComponentName, setNewComponentName] = useState("");
  const [newComponentKind, setNewComponentKind] = useState<ComponentKind>("android");
  const [newComponentParentId, setNewComponentParentId] = useState("");
  const [addingComponent, setAddingComponent] = useState(false);
  const componentsQuery = useQuery({ queryKey: ["components", product.id], queryFn: () => api.listComponents(product.id) });
  const componentEntries = useMemo(() => componentTreeEntries(componentsQuery.data ?? []), [componentsQuery.data]);

  useEffect(() => setName(product.name), [product.id, product.name]);

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
      ...(newComponentParentId ? { parentComponentId: newComponentParentId } : {}),
    }),
    onSuccess: async () => {
      setNewComponentName("");
      setNewComponentParentId("");
      setAddingComponent(false);
      await queryClient.invalidateQueries({ queryKey: ["components", product.id] });
    },
  });

  return (
    <div className="product-settings">
      <section className="product-settings-section">
        <header><div><p className="eyebrow">{product.keyPrefix}</p><h3>{t("productSettings")}</h3></div></header>
        <div className="product-settings-grid">
          <label>{t("productName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t("itemPrefix")}<input value={product.keyPrefix} readOnly /><small>{t("prefixLockedHelp")}</small></label>
        </div>
        {productMutation.isError && <InlineError message={errorMessage(productMutation.error, t("somethingWentWrong"))} />}
        <button className="primary-button settings-save" disabled={!name.trim() || name.trim() === product.name || productMutation.isPending} onClick={() => productMutation.mutate()}>
          {productMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {t("saveProduct")}
        </button>
      </section>
      <section className="product-settings-section component-management">
        <header>
          <div><p className="eyebrow">{t("productComponents")}</p><h3>{t("manageComponents")}</h3></div>
          <div className="component-header-actions">
            <span>{componentsQuery.data?.length ?? 0}</span>
            {(componentsQuery.data?.length ?? 0) > 0 && (
              <button className="primary-button component-add-trigger" onClick={() => setAddingComponent((value) => !value)}><Plus size={15} /> {t("newComponent")}</button>
            )}
          </div>
        </header>
        <p className="component-management-help">{t("componentManagementHelp")}</p>
        <div className="component-manager-list">
          {componentEntries.length > 0 && (
            <div className="component-list-head">
              <span>{t("componentName")}</span><span>{t("componentKind")}</span><span>{t("parentComponent")}</span><span>{t("save")}</span>
            </div>
          )}
          {componentEntries.map(({ component, depth }) => (
            <div className="component-tree-entry" style={{ paddingLeft: depth * 18 }} key={component.id}>
              <ComponentSettingsRow component={component} components={componentsQuery.data ?? []} />
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
            <h4>{t("newComponent")}</h4>
            <div className="component-add-row">
              <label>{t("componentName")}<input value={newComponentName} onChange={(event) => setNewComponentName(event.target.value)} placeholder={t("componentNamePlaceholder")} autoFocus /></label>
              <label>{t("componentKind")}<select value={newComponentKind} onChange={(event) => setNewComponentKind(event.target.value as ComponentKind)}>{COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</select></label>
              <label>{t("parentComponent")}<select value={newComponentParentId} onChange={(event) => setNewComponentParentId(event.target.value)}><option value="">{t("topLevelComponent")}</option>{componentEntries.map(({ component, depth }) => <option key={component.id} value={component.id}>{`${"— ".repeat(depth)}${component.name}`}</option>)}</select></label>
              <button className="primary-button" disabled={!newComponentName.trim() || componentMutation.isPending} onClick={() => componentMutation.mutate()}>
                {componentMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createComponent")}
              </button>
            </div>
          </div>
        )}
        {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
      </section>
    </div>
  );
}

function ComponentSettingsRow({ component, components }: { component: Component; components: readonly Component[] }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [name, setName] = useState(component.name);
  const [kind, setKind] = useState<ComponentKind>(component.kind);
  const [parentComponentId, setParentComponentId] = useState(component.parentComponentId ?? "");
  useEffect(() => {
    setName(component.name);
    setKind(component.kind);
    setParentComponentId(component.parentComponentId ?? "");
  }, [component.kind, component.name, component.parentComponentId]);
  const unavailableParentIds = componentDescendantIds(component.id, components);
  unavailableParentIds.add(component.id);
  const parentOptions = componentTreeEntries(components).filter(({ component: option }) => !unavailableParentIds.has(option.id));
  const mutation = useMutation({
    mutationFn: () => api.updateComponent(component.productId, component.id, { name, kind, parentComponentId: parentComponentId || null }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["components", component.productId] }),
  });
  const changed = name.trim() !== component.name || kind !== component.kind || parentComponentId !== (component.parentComponentId ?? "");
  return (
    <div className="component-settings-row">
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("componentName")} />
      <select value={kind} onChange={(event) => setKind(event.target.value as ComponentKind)} aria-label={t("componentKind")}>
        {COMPONENT_KINDS.map((value) => <option key={value} value={value}>{t(value)}</option>)}
      </select>
      <select value={parentComponentId} onChange={(event) => setParentComponentId(event.target.value)} aria-label={t("parentComponent")}>
        <option value="">{t("topLevelComponent")}</option>
        {parentOptions.map(({ component: option, depth }) => <option key={option.id} value={option.id}>{`${"— ".repeat(depth)}${option.name}`}</option>)}
      </select>
      <button className="secondary-button" disabled={!changed || !name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}
      </button>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
    </div>
  );
}

function componentTreeEntries(components: readonly Component[]): readonly { component: Component; depth: number }[] {
  const componentIds = new Set(components.map((component) => component.id));
  const children = new Map<string | null, Component[]>();
  for (const component of components) {
    const parentId = component.parentComponentId && componentIds.has(component.parentComponentId) ? component.parentComponentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), component]);
  }
  for (const entries of children.values()) entries.sort((left, right) => left.name.localeCompare(right.name));
  const result: Array<{ component: Component; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (component: Component, depth: number) => {
    if (visited.has(component.id)) return;
    visited.add(component.id);
    result.push({ component, depth });
    for (const child of children.get(component.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  for (const component of components) visit(component, 0);
  return result;
}

function componentDescendantIds(componentId: string, components: readonly Component[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const component of components) {
    if (!component.parentComponentId) continue;
    children.set(component.parentComponentId, [...(children.get(component.parentComponentId) ?? []), component.id]);
  }
  const descendants = new Set<string>();
  const visit = (id: string) => {
    for (const childId of children.get(id) ?? []) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      visit(childId);
    }
  };
  visit(componentId);
  return descendants;
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

function TokenForm({ onSaved }: { onSaved: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [token, setToken] = useState(getAdminToken());
  return (
    <form className="token-form" onSubmit={(event) => { event.preventDefault(); setAdminToken(token); void onSaved(); }}>
      <label>{t("administratorToken")}<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t("pasteToken")} autoComplete="off" /></label>
      <p className="privacy-note"><KeyRound size={14} /> {t("tokenPrivacy")}</p>
      <button className="primary-button wide"><Check size={17} /> {t("saveAndConnect")}</button>
    </form>
  );
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="modal-layer"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label={t("close")}><X size={20} /></button></header>
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
