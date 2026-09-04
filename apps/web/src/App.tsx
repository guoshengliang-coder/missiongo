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
  EMPTY_ENVIRONMENT,
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
  if (!draft.platform && !appVersion && !buildNumber && !sourceRevision && !osVersion && !deviceModel) return undefined;
  return {
    platform: draft.platform || "other",
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
  };
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
): { files: readonly File[]; error?: string } {
  const remaining = 10 - current.length;
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
        const item = await api.createItem({ productId: selectedProduct.id, ...input });
        setSelectedItemKey(item.key);
        setNotice(t("capturedInInbox", { key: item.key }));
        await queryClient.invalidateQueries({ queryKey: ["items", selectedProduct.id] });
        return item;
      },
      openItem: (itemKey) => {
        const item = items.find((candidate) => candidate.key === itemKey);
        if (!item) throw new Error(t("itemNotLoaded", { key: itemKey }));
        setSelectedItemKey(item.key);
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
        <button className="text-button add-product" onClick={() => setProductOpen(true)}><Plus size={15} /> {t("addProduct")}</button>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim mobile-only" onClick={() => setSidebarOpen(false)} aria-label={t("closeNavigation")} />}

      <main className="workspace">
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

        <div className="work-grid">
          <section className="item-list" aria-label={t("workItems")}>
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
              <ItemRow key={item.id} item={item} selected={selectedItemKey === item.key} onClick={() => setSelectedItemKey(item.key)} />
            ))}
          </section>
          <DetailPane itemKey={selectedItemKey} onClose={() => setSelectedItemKey(null)} onNotice={setNotice} />
        </div>
      </main>

      <button className="mobile-fab mobile-only" onClick={() => setCaptureOpen(true)} aria-label={t("captureNewItem")}><Plus size={24} /></button>

      {captureOpen && selectedProduct && (
        <Modal title={t("captureWork")} subtitle={t("addToProduct", { product: selectedProduct.name })} onClose={() => setCaptureOpen(false)}>
          <CaptureForm
            product={selectedProduct}
            onCreated={(item, failedUploads) => {
              setCaptureOpen(false);
              setSelectedItemKey(item.key);
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
        <Modal title={t("addProduct")} subtitle={t("createProductWorkspace")} onClose={() => setProductOpen(false)}>
          <ProductForm
            onCreated={(product) => {
              setProductOpen(false);
              setSelectedProductId(product.id);
              setSelectedItemKey(null);
              void queryClient.invalidateQueries({ queryKey: ["products"] });
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

function ItemRow({ item, selected, onClick }: { item: WorkItem; selected: boolean; onClick: () => void }) {
  const { formatTime, priorityLabel, statusLabel, typeLabel } = useI18n();
  const TypeIcon = TYPE_ICONS[item.type];
  return (
    <button className={`item-row ${selected ? "selected" : ""}`} onClick={onClick}>
      <span className={`type-icon type-${item.type}`}><TypeIcon size={17} /></span>
      <span className="item-copy">
        <span className="item-title">{item.title}</span>
        <span className="item-meta">
          <code>{item.key}</code><span>·</span>{typeLabel(item.type)}<span>·</span>{formatTime(item.updatedAt)}
          {(item.attachments?.length ?? 0) > 0 && <><span>·</span><Paperclip size={10} /> {item.attachments.length}</>}
        </span>
      </span>
      <span className={`priority-dot priority-${item.priority}`} title={priorityLabel(item.priority)} />
      <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
      <ArrowRight className="row-arrow" size={17} />
    </button>
  );
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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<WorkItemType>("idea");
  const [priority, setPriority] = useState<WorkItemPriority>("normal");
  const [environment, setEnvironment] = useState<EnvironmentDraft>(EMPTY_ENVIRONMENT);

  useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setDescription(item.description);
    setType(item.type);
    setPriority(item.priority);
    setEnvironment(environmentDraft(item.environment));
    setEditing(false);
  }, [item]);

  const refreshItem = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["item", itemKey] }),
      queryClient.invalidateQueries({ queryKey: ["timeline", itemKey] }),
      queryClient.invalidateQueries({ queryKey: ["items"] }),
    ]);
  };

  const updateMutation = useMutation({
    mutationFn: () => api.updateItem(itemKey!, {
      title,
      description,
      type,
      priority,
      environment: environmentPayload(environment) ?? null,
    }),
    onSuccess: async () => {
      setEditing(false);
      await refreshItem();
      onNotice(t("itemUpdated", { key: itemKey ?? "" }));
    },
  });
  const transitionMutation = useMutation({
    mutationFn: (action: TransitionAction) => api.transitionItem(itemKey!, action),
    onSuccess: async (updated) => {
      await refreshItem();
      onNotice(t("itemMoved", { key: updated.key, status: statusLabel(updated.status) }));
    },
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
    return <aside className="detail-pane detail-placeholder"><div className="round-icon"><ArrowLeft size={20} /></div><h2>{t("selectItem")}</h2><p>{t("selectItemHelp")}</p></aside>;
  }
  if (itemQuery.isLoading || !item) {
    return <aside className="detail-pane detail-loading"><LoaderCircle className="spin" size={24} /></aside>;
  }

  const PrimaryIcon = TYPE_ICONS[item.type];
  const actions = TRANSITIONS[item.status];
  const sourceComponent = componentsQuery.data?.find((component) => component.id === item.sourceComponentId);
  const affectedComponents = (componentsQuery.data ?? []).filter((component) => item.affectedComponentIds.includes(component.id));
  return (
    <aside className="detail-pane">
      <div className="detail-toolbar">
        <button className="icon-button mobile-only" onClick={onClose} aria-label={t("backToList")}><ArrowLeft size={19} /></button>
        <code>{item.key}</code>
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <span className="toolbar-spacer" />
        {item.status === "inbox" && (
          <button
            className="secondary-button toolbar-ready-button"
            disabled={transitionMutation.isPending}
            onClick={() => transitionMutation.mutate(TRANSITIONS.inbox[0]!)}
          >
            {transitionMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {t("markReady")}
          </button>
        )}
        <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? t("cancel") : t("edit")}</button>
      </div>
      <div className="detail-scroll">
        {editing ? (
          <form className="edit-form" onSubmit={(event) => { event.preventDefault(); updateMutation.mutate(); }}>
            <label>{t("title")}<input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label>
            <div className="field-row">
              <label>{t("type")}<select value={type} onChange={(event) => setType(event.target.value as WorkItemType)}>{ITEM_TYPES.map((value) => <option key={value} value={value}>{typeLabel(value)}</option>)}</select></label>
              <label>{t("priority")}<select value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
            </div>
            <label>{t("description")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={8} /></label>
            <EnvironmentFields value={environment} onChange={setEnvironment} />
            {updateMutation.isError && <InlineError message={errorMessage(updateMutation.error, t("somethingWentWrong"))} />}
            <button className="primary-button" disabled={updateMutation.isPending}>{updateMutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} {t("saveChanges")}</button>
          </form>
        ) : (
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
            <section className="next-action-block">
              <div><p className="eyebrow">{t("nextAction")}</p><h3>{t("moveForward")}</h3></div>
              <div className="action-row">
                {actions.map((action) => (
                  <button
                    key={`${action.to}-${action.reason}`}
                    className={action.tone === "primary" || action.tone === "positive" ? `primary-button ${action.tone === "positive" ? "positive" : ""}` : "secondary-button"}
                    disabled={transitionMutation.isPending}
                    onClick={() => transitionMutation.mutate(action)}
                  >
                    {transitionMutation.isPending ? <LoaderCircle className="spin" size={16} /> : null}{transitionLabel(action.label)}
                  </button>
                ))}
              </div>
              {transitionMutation.isError && <InlineError message={errorMessage(transitionMutation.error, t("somethingWentWrong"))} />}
            </section>
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
        )}
      </div>
    </aside>
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

function CaptureForm({ product, onCreated }: { product: Product; onCreated: (item: WorkItem, failedUploads: number) => void }) {
  const queryClient = useQueryClient();
  const { priorityLabel, t, typeLabel } = useI18n();
  const storageKey = captureDraftStorageKey(product.id);
  const [draft, setDraft] = useState<CaptureDraft>(() => parseCaptureDraft(localStorage.getItem(storageKey)));
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [componentFormOpen, setComponentFormOpen] = useState(false);
  const [componentName, setComponentName] = useState("");
  const [componentKind, setComponentKind] = useState<ComponentKind>("android");
  const componentsQuery = useQuery({
    queryKey: ["components", product.id],
    queryFn: () => api.listComponents(product.id),
  });

  useEffect(() => {
    if (hasCaptureDraftContent(draft)) localStorage.setItem(storageKey, JSON.stringify(draft));
    else localStorage.removeItem(storageKey);
  }, [draft, storageKey]);

  useEffect(() => {
    if (!draft.sourceComponentId || !componentsQuery.data) return;
    if (!componentsQuery.data.some((component) => component.id === draft.sourceComponentId)) {
      setDraft((value) => ({ ...value, sourceComponentId: "" }));
    }
  }, [componentsQuery.data, draft.sourceComponentId]);

  const updateDraft = <Key extends keyof CaptureDraft>(key: Key, value: CaptureDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const addIncomingFiles = (incoming: readonly File[]) => {
    const result = validateIncomingFiles(files, incoming, t);
    setFiles(result.files);
    setFileError(result.error ?? null);
  };

  const componentMutation = useMutation({
    mutationFn: () => api.createComponent(product.id, { name: componentName, kind: componentKind }),
    onSuccess: async (component) => {
      await queryClient.invalidateQueries({ queryKey: ["components", product.id] });
      setDraft((current) => ({
        ...current,
        sourceComponentId: component.id,
        environment: !current.environment.platform && ["android", "macos", "web"].includes(component.kind)
          ? { ...current.environment, platform: component.kind as WorkItemEnvironment["platform"] }
          : current.environment,
      }));
      setComponentName("");
      setComponentFormOpen(false);
    },
  });

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
        ...(environmentPayload(draft.environment) ? { environment: environmentPayload(draft.environment)! } : {}),
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
      <div className="capture-type-grid" aria-label={t("type")}>
        {ITEM_TYPES.map((value) => {
          const Icon = TYPE_ICONS[value];
          return (
            <button
              key={value}
              type="button"
              className={`capture-type ${draft.type === value ? "active" : ""} type-${value}`}
              onClick={() => updateDraft("type", value)}
            >
              <Icon size={16} /> {typeLabel(value)}
            </button>
          );
        })}
      </div>
      <label>{t("whatNeedsAttention")}<input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus /></label>
      <label>{t("context")}<textarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t("contextPlaceholder")} rows={4} /></label>
      <div className="attachment-picker-block capture-attachment-block">
        <div><strong>{t("attachments")}</strong><p>{t("pasteDropHelp")}</p></div>
        <FilePicker files={files} onFiles={setFiles} remaining={10 - files.length} showSelectedFiles={false} />
      </div>
      {files.length > 0 && <SelectedFilePreviews files={files} onFiles={setFiles} />}
      {fileError && <InlineError message={fileError} />}
      <details className="capture-optional" open={Boolean(draft.sourceComponentId || draft.priority !== "normal" || environmentPayload(draft.environment))}>
        <summary><ChevronRight size={16} /> <span><strong>{t("optionalDetails")}</strong><small>{t("optionalDetailsHelp")}</small></span></summary>
        <div className="capture-optional-body">
          <div className="field-row">
            <label>{t("sourceComponent")}
              <select
                value={draft.sourceComponentId}
                onChange={(event) => {
                  const sourceComponentId = event.target.value;
                  const kind = componentsQuery.data?.find((component) => component.id === sourceComponentId)?.kind;
                  setDraft((current) => ({
                    ...current,
                    sourceComponentId,
                    environment: !current.environment.platform && kind && ["android", "macos", "web"].includes(kind)
                      ? { ...current.environment, platform: kind as WorkItemEnvironment["platform"] }
                      : current.environment,
                  }));
                }}
                disabled={componentsQuery.isLoading}
              >
                <option value="">{t("notSpecified")}</option>
                {(componentsQuery.data ?? []).map((component) => (
                  <option key={component.id} value={component.id}>{component.name}</option>
                ))}
              </select>
            </label>
            <label>{t("priority")}<select value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
          </div>
          <button type="button" className="text-button inline-add-component" onClick={() => setComponentFormOpen((value) => !value)}>
            <Plus size={14} /> {t("addComponent")}
          </button>
          {componentFormOpen && (
            <div className="component-quick-form">
              <label>{t("componentName")}<input value={componentName} onChange={(event) => setComponentName(event.target.value)} placeholder={t("componentNamePlaceholder")} /></label>
              <label>{t("componentKind")}
                <select value={componentKind} onChange={(event) => setComponentKind(event.target.value as ComponentKind)}>
                  {COMPONENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={!componentName.trim() || componentMutation.isPending}
                onClick={() => componentMutation.mutate()}
              >
                {componentMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("createComponent")}
              </button>
            </div>
          )}
          {componentMutation.isError && <InlineError message={errorMessage(componentMutation.error, t("somethingWentWrong"))} />}
          <EnvironmentFields value={draft.environment} onChange={(value) => updateDraft("environment", value)} />
        </div>
      </details>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <div className="draft-status">
        <span>{hasCaptureDraftContent(draft) ? t("draftSaved") : t("landsInInbox")}</span>
        <small>{t("captureShortcut")}</small>
      </div>
      <div className="form-footer"><span>{t("landsInInbox")}</span><button className="primary-button" disabled={mutation.isPending || !draft.title.trim()}>{mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {t("captureItem")}</button></div>
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
        <label>{t("platform")}
          <select value={value.platform} onChange={(event) => update("platform", event.target.value)}>
            <option value="">{t("notSpecified")}</option>
            <option value="android">{t("android")}</option>
            <option value="macos">{t("macos")}</option>
            <option value="web">{t("web")}</option>
            <option value="other">{t("other")}</option>
          </select>
        </label>
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
}: {
  itemKey: string;
  attachments: readonly WorkItemAttachment[];
  uploading: boolean;
  onUpload: (files: readonly File[]) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="attachment-block">
      <header>
        <div><h3>{t("attachments")}</h3><p>{t("attachmentHelp")}</p></div>
        <FilePicker onFiles={onUpload} remaining={Math.max(0, 10 - attachments.length)} disabled={uploading} />
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

function ProductForm({ onCreated }: { onCreated: (product: Product) => void }) {
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

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
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
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
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
