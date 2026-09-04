import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  CirclePause,
  ClipboardCheck,
  FileText,
  Inbox,
  KeyRound,
  Languages,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Plus,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";

import { api, ApiError, getAdminToken, setAdminToken } from "./api";
import {
  ITEM_PRIORITIES,
  ITEM_STATUSES,
  ITEM_TYPES,
  type Product,
  type TransitionAction,
  type WorkItem,
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
            onCreated={(item) => {
              setCaptureOpen(false);
              setSelectedItemKey(item.key);
              setNotice(t("capturedInInbox", { key: item.key }));
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
        <span className="item-meta"><code>{item.key}</code><span>·</span>{typeLabel(item.type)}<span>·</span>{formatTime(item.updatedAt)}</span>
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
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<WorkItemType>("idea");
  const [priority, setPriority] = useState<WorkItemPriority>("normal");

  useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setDescription(item.description);
    setType(item.type);
    setPriority(item.priority);
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
    mutationFn: () => api.updateItem(itemKey!, { title, description, type, priority }),
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

  if (!itemKey) {
    return <aside className="detail-pane detail-placeholder"><div className="round-icon"><ArrowLeft size={20} /></div><h2>{t("selectItem")}</h2><p>{t("selectItemHelp")}</p></aside>;
  }
  if (itemQuery.isLoading || !item) {
    return <aside className="detail-pane detail-loading"><LoaderCircle className="spin" size={24} /></aside>;
  }

  const PrimaryIcon = TYPE_ICONS[item.type];
  const actions = TRANSITIONS[item.status];
  return (
    <aside className="detail-pane">
      <div className="detail-toolbar">
        <button className="icon-button mobile-only" onClick={onClose} aria-label={t("backToList")}><ArrowLeft size={19} /></button>
        <code>{item.key}</code>
        <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
        <span className="toolbar-spacer" />
        <button className="icon-button" aria-label={t("moreActions")}><MoreHorizontal size={19} /></button>
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
            {item.environment && (
              <section className="environment-block">
                <h3>{t("capturedContext")}</h3>
                <div className="context-grid">
                  <span><small>{t("platform")}</small>{item.environment.platform}</span>
                  {item.environment.appVersion && <span><small>{t("version")}</small>{item.environment.appVersion}</span>}
                  {item.environment.osVersion && <span><small>{t("operatingSystem")}</small>{item.environment.osVersion}</span>}
                  {item.environment.deviceModel && <span><small>{t("device")}</small>{item.environment.deviceModel}</span>}
                </div>
              </section>
            )}
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

function CaptureForm({ product, onCreated }: { product: Product; onCreated: (item: WorkItem) => void }) {
  const { priorityLabel, t, typeLabel } = useI18n();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<WorkItemType>("idea");
  const [priority, setPriority] = useState<WorkItemPriority>("normal");
  const mutation = useMutation({ mutationFn: api.createItem, onSuccess: onCreated });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({ productId: product.id, title, description, type, priority });
  };

  return (
    <form className="capture-form" onSubmit={submit}>
      <label>{t("whatNeedsAttention")}<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("clearSpecificTitle")} required autoFocus /></label>
      <label>{t("context")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("contextPlaceholder")} rows={6} /></label>
      <div className="field-row">
        <label>{t("type")}<select value={type} onChange={(event) => setType(event.target.value as WorkItemType)}>{ITEM_TYPES.map((value) => <option key={value} value={value}>{typeLabel(value)}</option>)}</select></label>
        <label>{t("priority")}<select value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority)}>{ITEM_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
      </div>
      {mutation.isError && <InlineError message={errorMessage(mutation.error, t("somethingWentWrong"))} />}
      <div className="form-footer"><span>{t("landsInInbox")}</span><button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {t("captureItem")}</button></div>
    </form>
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
    <dialog ref={dialogRef} className="modal-layer" onCancel={onClose} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
