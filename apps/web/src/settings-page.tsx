import { BackButton } from "./back-button";
import { DingTalkSettingsPage, DingTalkProjectSettings } from "./dingtalk-settings";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { ProductSettingsList } from "./product-settings-list";
import type { AuthenticatedUser } from "./api";
import type { Product } from "./types";
import { AccountSettings, AccountManagement, AiConnectionsSettings, DeepSeekSettings, ProductAccessSettings } from "./account-settings";
import { DisplaySettings } from "./display-settings";
import { ProjectAdministratorsSettings, ProjectBuilderSettings } from "./project-administrators-settings";
import { DispatchDefaultsSettings } from "./dispatch-defaults-settings";
import { NodeSettings } from "./node-settings";
import { useI18n, type MessageKey } from "./i18n";
import { mayAdministerProduct } from "./product-permissions";
import { SettingsDraftProvider, type SettingsLeaveGuard } from "./settings-drafts";
import { PRODUCT_SETTINGS, type SettingsRoute, type SettingsSection, type ProductSettingsSection } from "./settings-state";

const LABELS: Record<SettingsSection, MessageKey> = {
  dingtalk:"settingsDingTalk",notifications:"settingsNotifications",
  "project-admins": "settingsProjectAdministrators", builders: "settingsBuilderAllocation",
  agent: "settingsAgent", products: "settingsProducts", overview: "settingsProductOverview",
  index: "settingsEntry", profile: "settingsProfile", display: "displaySettings", connections: "settingsConnections",
  devices: "settingsDevices", dispatch: "dispatchDefaultsTitle", product: "settingsBasicDetails", components: "moduleManagement",
  artifacts: "settingsReleaseConfig", tokens: "settingsSdk", access: "settingsAccountsPermissions", accounts: "settingsAccountsPermissions", ai: "settingsModels", "new-product": "addProduct",
};
/** Keep the focused field above the action bar, including a keyboard-shrunken visual viewport. */
function revealSettingsField(field: HTMLElement, scroller: HTMLElement) {
  if (!field.matches("input, textarea, select") || !field.closest(".settings-page-body")) return;
  const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
  const area = scroller.getBoundingClientRect();
  let bottom = Math.min(area.bottom, viewportBottom);
  for (const footer of scroller.querySelectorAll<HTMLElement>(".settings-form-footer, .form-footer, .account-form-actions, .account-permissions-footer")) {
    const box = footer.getBoundingClientRect();
    if (box.height > 0 && box.top < bottom && box.bottom > area.top) bottom = box.top;
  }
  const box = field.getBoundingClientRect();
  if (box.bottom > bottom - 10) scroller.scrollBy({ top: box.bottom - bottom + 10 });
}

export function SettingsPage({ route, user, products, canUseAi, navigate, guard, onLoggedOut, renderProduct, renderNewProduct }: {
  route: SettingsRoute; user: AuthenticatedUser; products: readonly Product[]; canUseAi: boolean;
  navigate: (route: SettingsRoute | null) => void; guard: RefObject<SettingsLeaveGuard>; onLoggedOut: () => void;
  renderProduct: (product: Product, section: ProductSettingsSection) => ReactNode; renderNewProduct: () => ReactNode;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const height = viewport?.height ?? window.innerHeight;
      shell.current?.style.setProperty("--settings-viewport-height", `${Math.round(height)}px`);
      if (shell.current) shell.current.dataset.compactHeight = String(height <= 500);
      requestAnimationFrame(() => {
        if (content.current && document.activeElement instanceof HTMLElement) revealSettingsField(document.activeElement, content.current);
      });
    };
    resize(); viewport?.addEventListener("resize", resize); window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  // Settings retain archived products without adding them to the workspace switcher.
  const catalogQuery = useQuery({ queryKey: ["products", "settings"], queryFn: () => api.listProducts({ includeArchived: true }) });
  const catalog = catalogQuery.data ?? products;
  const product = catalog.find(value => value.id === route.productId);
  const inProduct = PRODUCT_SETTINGS.includes(route.section as ProductSettingsSection) || ["products", "overview", "new-product"].includes(route.section);
  const inAgent = ["agent", "connections", "devices", "dispatch"].includes(route.section);
  const isAdmin = user.role === "admin";
  const administrators = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts, enabled: isAdmin && route.section === "project-admins" && !route.productId });
  const owned = catalog.filter(value => mayAdministerProduct(user, value));
  const canManage = isAdmin || owned.length > 0;
  const active = inProduct ? "products" : inAgent ? "agent" : route.section === "access" ? "accounts" : route.section;
  const groups = [
    { label: "settingsPersonal" as const, sections: ["profile", "display", "agent"] as SettingsSection[] },
    { label: "settingsProduct" as const, sections: ["products"] as SettingsSection[] },
    ...(canManage ? [{ label: "settingsSystem" as const, sections: ["accounts", ...(isAdmin ? ["project-admins", "ai", "dingtalk"] as const : [])] as SettingsSection[] }] : []),
  ];
  const allowed = route.section === "access" ? Boolean(product && mayAdministerProduct(user, product))
    : route.section === "accounts" ? isAdmin || !route.accountId && owned.length > 0
    : route.section === "ai" || route.section === "project-admins" || route.section === "dingtalk" ? isAdmin && (!route.productId || Boolean(product))
    : route.section === "devices" || route.section === "dispatch" ? canUseAi
    : !inProduct || ["products", "new-product"].includes(route.section) || Boolean(product);
  const go = (section: SettingsSection) => navigate({ section });
  useEffect(() => { content.current?.scrollTo({ top: 0 }); content.current?.focus({ preventScroll: true }); }, [route.section, route.productId, route.nodeId, route.componentId, route.accountId]);
  const scope = route.section === "accounts" && isAdmin || route.section === "ai" ? t("settingsSystemScope") : "";
  const parent: SettingsRoute | undefined = route.nodeId ? { section: "devices" }
    : route.componentId ? { section: "components", productId: route.productId }
    : route.accountId ? { section: "accounts", filterProductId: route.filterProductId }
    : route.section === "project-admins" && route.productId ? { section: "project-admins" }
    : route.section === "access" ? { section: "overview", productId: route.productId }
    : inAgent && route.section !== "agent" ? { section: "agent" }
    : route.section === "overview" || route.section === "new-product" ? { section: "products" }
    : inProduct && route.section !== "products" ? { section: "overview", productId: route.productId }
    : undefined;
  /**
   * One level up, and only one (AND-316). The header holds the single Back the
   * screen offers: to the section this page came from, to the settings directory
   * when it has no parent, and to the workspace from the directory itself.
   * A second "back to workspace" beside it read as two stacked arrows and made
   * Back skip a level, so the parent's name is the label instead.
   */
  const up: SettingsRoute | null = parent ?? (route.section === "index" ? null : { section: "index" });
  const upLabel = parent ? t(LABELS[parent.section]) : route.section === "index" ? t("settingsBackToWorkspace") : t("settingsDirectory");
  const title = route.nodeId ? t("settingsDeviceDetail") : route.componentId ? t("settingsComponentDetail")
    : route.accountId ? t("settingsAccountDetail") : route.section === "ai" ? t("settingsModelsTitle") : t(LABELS[route.section]);
  const entry = (section: SettingsSection, description: MessageKey, next: SettingsRoute = { section }) => <button type="button" className="settings-hub-row" onClick={() => navigate(next)}>
    <span><strong>{t(LABELS[section])}</strong><small>{t(description)}</small></span><ChevronRight size={18} />
  </button>;
  const productHub = <>
    {product ? <>

      <div className="settings-hub-list">
        {entry("product", "settingsBasicHelp", { section: "product", productId: product.id })}
        {entry("components", "settingsComponentsHelp", { section: "components", productId: product.id })}
        {isAdmin && entry("project-admins", "settingsProductAdministratorsDetailHelp", { section: "project-admins", productId: product.id })}
        {(isAdmin || product.access?.isProjectAdmin || mayAdministerProduct(user,product)) && entry("builders", "settingsBuilderAllocationHelp", {section:"builders",productId:product.id})}
        {entry("artifacts", "settingsArtifactsHelp", { section: "artifacts", productId: product.id })}
        {entry("notifications", "settingsNotificationsHelp", {section:"notifications",productId:product.id})}
        {entry("tokens", "settingsSdkHelp", { section: "tokens", productId: product.id })}
      </div>
      {mayAdministerProduct(user, product) && <button type="button" className="text-button settings-access-shortcut" onClick={() => navigate(isAdmin ? { section: "accounts", filterProductId: product.id } : { section: "access", productId: product.id })}>{t("settingsManageProductAccess")}<ChevronRight size={16} /></button>}
    </> : <p role="alert">{t("settingsUnavailable")}</p>}
  </>;
  const productList = (values: readonly Product[], onOpen: (value: Product) => void, description?: (value: Product) => ReactNode) =>
    catalogQuery.isPending ? <p role="status">{t("settingsLoading")}</p>
      : catalogQuery.isError ? <div role="alert"><p>{t("settingsProductsLoadFailed")}</p><button type="button" className="secondary-button" onClick={() => void catalogQuery.refetch()}>{t("retry")}</button></div>
      : <ProductSettingsList products={values} onOpen={onOpen} description={description} actions={route.section === "products" ? <button type="button" className="primary-button" onClick={() => navigate({ section: "new-product" })}><Plus size={16} />{t("addProduct")}</button> : undefined} />;
  const administratorSummary = (value: Product) => {
    if (administrators.isPending) return t("settingsLoading");
    if (administrators.isError) return t("somethingWentWrong");
    const names = administrators.data.accounts.filter(account => account.projectAdministratorProductIds?.includes(value.id)).map(account => `${account.nickname || account.email}${account.disabledAt ? ` · ${t("suspendedAccount")}` : ""}`);
    return names.join("、") || t("settingsNoProductAdministrators");
  };
  return (
    <SettingsDraftProvider guard={guard}>
      <div ref={shell} className={`settings-page ${route.section === "index" ? "settings-directory" : "settings-detail"}`}>
        <header className="settings-page-header">
          <BackButton label={upLabel} onClick={() => navigate(up)} />
          <strong>{t("settingsEntry")}</strong>
        </header>
        <div className="settings-page-layout">
          <nav className="settings-page-nav" aria-label={t("settingsEntry")}>
            {groups.map(group => <section key={group.label}>
              <h2>{t(group.label)}</h2>
              <div className="settings-nav-group">{group.sections.map(section => <button type="button" key={section} aria-current={active === section ? "page" : undefined} onClick={() => go(section)}>
                <span>{t(LABELS[section])}</span><ChevronRight size={16} />
              </button>)}</div>
            </section>)}
          </nav>
          {route.section !== "index" && <main className="settings-page-main" ref={content} tabIndex={-1} onFocusCapture={event => {
            const field = event.target;
            requestAnimationFrame(() => { if (content.current) revealSettingsField(field, content.current); });
          }}>
            <header className="settings-page-title">
              <div>{scope && <p>{scope}</p>}<h1>{product && route.productId ? `${product.name} · ${title}` : title}</h1></div>

            </header>
            <div className="settings-page-body" key={`${route.section}:${product?.id ?? ""}:${route.nodeId ?? ""}:${route.componentId ?? ""}:${route.accountId ?? ""}`}>
              {catalogQuery.isPending && (route.productId && !product || route.section === "accounts" && !isAdmin) ? <p role="status">{t("settingsLoading")}</p>
                : !allowed ? <p role="alert">{t("settingsUnavailable")}</p>
                : route.section === "profile" ? <AccountSettings user={user} products={products} onLoggedOut={onLoggedOut} />
                : route.section === "display" ? <DisplaySettings user={user} />
                : route.section === "dingtalk" ? <DingTalkSettingsPage />
                : route.section === "notifications" && product ? <DingTalkProjectSettings productId={product.id} />
                : route.section === "project-admins" ? route.productId && product ? <ProjectAdministratorsSettings productId={product.id} />
                  : <>{administrators.isError && <div role="alert"><p>{t("somethingWentWrong")}</p><button type="button" className="secondary-button" onClick={() => void administrators.refetch()}>{t("retry")}</button></div>}{productList(catalog, value => navigate({ section: "project-admins", productId: value.id }), administratorSummary)}</>
                : route.section === "builders" && product ? <ProjectBuilderSettings productId={product.id} />
                : route.section === "agent" ? <><div className="settings-hub-list">
                  {entry("connections", "settingsConnectionsHelp")}
                  {canUseAi && <>{entry("devices", "settingsDevicesHelp")}{entry("dispatch", "settingsDispatchHelp")}</>}
                </div></>
                : route.section === "products" ? catalogQuery.isSuccess && !catalog.length
                  ? <div className="settings-empty"><h2>{t("settingsFirstProduct")}</h2><button type="button" className="primary-button" onClick={() => navigate({ section: "new-product" })}>{t("addProduct")}</button></div>
                  : productList(catalog, value => navigate({ section: "overview", productId: value.id }))
                : route.section === "overview" ? productHub
                : route.section === "accounts" && !isAdmin ? productList(owned, value => navigate({ section: "access", productId: value.id }))
                : route.section === "access" && product && !isAdmin ? <ProductAccessSettings productId={product.id} user={user} />
                : route.section === "connections" ? <AiConnectionsSettings />
                : route.section === "devices" ? <NodeSettings products={products} nodeId={route.nodeId} onOpenNode={nodeId => navigate({ section: "devices", nodeId })} />
                : route.section === "dispatch" ? <DispatchDefaultsSettings onOpenDevices={() => navigate({ section: "devices" })} />
                : route.section === "accounts" || route.section === "access" && isAdmin ? <AccountManagement user={user} products={catalog} accountId={route.accountId} filterProductId={route.section === "access" ? product?.id : route.filterProductId} onNavigate={(accountId, filterProductId) => navigate({ section: "accounts", accountId, filterProductId })} />
                : route.section === "ai" ? <><p className="settings-hub-intro">{t("settingsModelsHelp")}</p><DeepSeekSettings /></>
                : route.section === "new-product" ? renderNewProduct()
                : product ? renderProduct(product, route.section as ProductSettingsSection) : null}
            </div>
          </main>}
          {route.section === "index" && <main className="settings-directory-intro"><h1>{t("settingsEntry")}</h1><p>{t("settingsDirectoryHelp")}</p></main>}
        </div>
      </div>
    </SettingsDraftProvider>
  );
}
