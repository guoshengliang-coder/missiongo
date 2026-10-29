import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
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

export function SettingsPage({ route, user, products, canUseAi, selectedProductId, navigate, guard, onLoggedOut, renderProduct, renderNewProduct }: {
  route: SettingsRoute; user: AuthenticatedUser; products: readonly Product[]; canUseAi: boolean; selectedProductId: string;
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
  const [lastProductId, setLastProductId] = useState(route.productId || selectedProductId);
  useEffect(() => { if (route.productId) setLastProductId(route.productId); }, [route.productId]);
  const product = products.find(value => value.id === (route.productId || lastProductId)) ?? (!route.productId ? products[0] : undefined);
  const inProduct = PRODUCT_SETTINGS.includes(route.section as ProductSettingsSection) || ["products", "overview", "new-product"].includes(route.section);
  const inAgent = ["agent", "connections", "devices", "dispatch"].includes(route.section);
  const isAdmin = user.role === "admin";
  const owned = products.filter(value => mayAdministerProduct(user, value));
  const canManage = isAdmin || owned.length > 0;
  const active = inProduct ? "products" : inAgent ? "agent" : route.section === "access" ? "accounts" : route.section;
  const groups = [
    { label: "settingsPersonal" as const, sections: ["profile", "display", "agent"] as SettingsSection[] },
    { label: "settingsProduct" as const, sections: ["products"] as SettingsSection[] },
    ...(canManage ? [{ label: "settingsSystem" as const, sections: ["accounts", ...(isAdmin ? ["project-admins", "ai"] as const : [])] as SettingsSection[] }] : []),
  ];
  const allowed = route.section === "access" ? Boolean(product && mayAdministerProduct(user, product))
    : route.section === "accounts" || route.section === "ai" || route.section === "project-admins" ? isAdmin
    : route.section === "devices" || route.section === "dispatch" ? canUseAi
    : !inProduct || ["products", "new-product"].includes(route.section) || Boolean(product);
  const go = (section: SettingsSection) => navigate(section === "products" && product ? { section: "overview", productId: product.id }
    : section === "accounts" && !isAdmin ? { section: "access", productId: owned[0]?.id } : { section });
  useEffect(() => { content.current?.scrollTo({ top: 0 }); content.current?.focus({ preventScroll: true }); }, [route.section, route.productId, route.nodeId, route.componentId, route.accountId]);
  const scope = route.section === "new-product" ? t("settingsNewProductScope")
    : route.section === "access" && !isAdmin || inProduct && route.section !== "products" ? t("settingsProductScope", { product: product?.name ?? "" })
    : route.section === "accounts" || route.section === "access" && isAdmin || route.section === "ai" || route.section === "project-admins" ? t("settingsSystemScope")
    : route.section === "products" ? t("settingsProductsHelp") : t("settingsPersonalScope");
  const parent: SettingsRoute | undefined = route.nodeId ? { section: "devices" }
    : route.componentId ? { section: "components", productId: route.productId }
    : route.accountId ? { section: "accounts", filterProductId: route.filterProductId }
    : inAgent && route.section !== "agent" ? { section: "agent" }
    : inProduct && !["products", "overview"].includes(route.section) ? product ? { section: "overview", productId: product.id } : { section: "products" }
    : undefined;
  const title = route.nodeId ? t("settingsDeviceDetail") : route.componentId ? t("settingsComponentDetail")
    : route.accountId ? t("settingsAccountDetail") : route.section === "ai" ? t("settingsModelsTitle") : t(LABELS[route.section]);
  const entry = (section: SettingsSection, description: MessageKey, next: SettingsRoute = { section }) => <button type="button" className="settings-hub-row" onClick={() => navigate(next)}>
    <span><strong>{t(LABELS[section])}</strong><small>{t(description)}</small></span><ChevronRight size={18} />
  </button>;
  const productHub = <>
    {product ? <>
      <div className="settings-product-summary"><strong>{product.name}</strong><span>{product.keyPrefix}</span><p>{t("settingsProductOverviewHelp")}</p></div>
      <div className="settings-hub-list">
        {entry("product", "settingsBasicHelp", { section: "product", productId: product.id })}
        {entry("components", "settingsComponentsHelp", { section: "components", productId: product.id })}
        {(isAdmin || product.access?.isProjectAdmin || mayAdministerProduct(user,product)) && entry("builders", "settingsBuilderAllocationHelp", {section:"builders",productId:product.id})}
        {entry("artifacts", "settingsArtifactsHelp", { section: "artifacts", productId: product.id })}
        {entry("tokens", "settingsSdkHelp", { section: "tokens", productId: product.id })}
      </div>
      {mayAdministerProduct(user, product) && <button type="button" className="text-button settings-access-shortcut" onClick={() => navigate(isAdmin ? { section: "accounts", filterProductId: product.id } : { section: "access", productId: product.id })}>{t("settingsManageProductAccess")}<ChevronRight size={16} /></button>}
    </> : <div className="settings-empty"><h2>{t("settingsFirstProduct")}</h2><p>{t("settingsProductsHelp")}</p><button type="button" className="primary-button" onClick={() => navigate({ section: "new-product" })}><Plus size={16} />{t("addProduct")}</button></div>}
  </>;
  return (
    <SettingsDraftProvider guard={guard}>
      <div ref={shell} className={`settings-page ${route.section === "index" ? "settings-directory" : "settings-detail"}`}>
        <header className="settings-page-header">
          <button type="button" className="text-button" onClick={() => navigate(null)}><ArrowLeft size={17} /> {t("settingsBackToWorkspace")}</button>
          <strong>{t("settingsEntry")}</strong>
        </header>
        <div className="settings-page-layout">
          <nav className="settings-page-nav" aria-label={t("settingsEntry")}>
            {groups.map(group => <section key={group.label}>
              <h2>{t(group.label)}</h2>
              {group.sections.map(section => <button type="button" key={section} aria-current={active === section ? "page" : undefined} onClick={() => go(section)}>
                <span>{t(LABELS[section])}</span><ChevronRight size={16} />
              </button>)}
            </section>)}
          </nav>
          {route.section !== "index" && <main className="settings-page-main" ref={content} tabIndex={-1} onFocusCapture={event => {
            const field = event.target;
            requestAnimationFrame(() => { if (content.current) revealSettingsField(field, content.current); });
          }}>
            <button type="button" className="text-button settings-directory-back" onClick={() => navigate({ section: "index" })}><ArrowLeft size={16} /> {t("settingsDirectory")}</button>
            {parent && <nav className="settings-breadcrumb" aria-label={t("settingsLocation")}><button type="button" className="text-button" onClick={() => navigate(parent)}><ArrowLeft size={16} />{t(LABELS[parent.section])}</button><ChevronRight size={14} /><span>{title}</span></nav>}
            <header className="settings-page-title">
              <div><p>{scope}</p><h1>{title}</h1></div>
              {(inProduct && route.section !== "new-product" || route.section === "access" && !isAdmin || route.section === "project-admins" && isAdmin) && products.length > 0 && <div className="settings-product-actions"><label>{t("settingsCurrentProduct")}<select value={product?.id ?? ""} onChange={event => navigate({ section: route.section === "products" ? "overview" : route.section, productId: event.target.value })}>
                {!product && <option value="">{t("settingsUnavailable")}</option>}
                {(route.section === "access" ? owned : products).map(value => <option key={value.id} value={value.id}>{value.name}{value.archivedAt ? ` · ${t("archived")}` : ""}</option>)}
              </select></label>{inProduct && <button type="button" className="secondary-button" onClick={() => navigate({ section: "new-product" })}><Plus size={16} />{t("addProduct")}</button>}</div>}
            </header>
            <div className="settings-page-body" key={`${route.section}:${product?.id ?? ""}:${route.nodeId ?? ""}:${route.componentId ?? ""}:${route.accountId ?? ""}`}>
              {!allowed ? <p role="alert">{t("settingsUnavailable")}</p>
                : route.section === "profile" ? <AccountSettings user={user} products={products} onLoggedOut={onLoggedOut} />
                : route.section === "display" ? <DisplaySettings user={user} />
                : route.section === "project-admins" ? product ? <ProjectAdministratorsSettings productId={product.id} /> : <p>{t("settingsUnavailable")}</p>
                : route.section === "builders" && product ? <ProjectBuilderSettings productId={product.id} />
                : route.section === "agent" ? <><p className="settings-hub-intro">{t("settingsAgentHelp")}</p><div className="settings-hub-list">
                  {entry("connections", "settingsConnectionsHelp")}
                  {canUseAi && <>{entry("devices", "settingsDevicesHelp")}{entry("dispatch", "settingsDispatchHelp")}</>}
                </div></>
                : route.section === "products" || route.section === "overview" ? productHub
                : route.section === "access" && product && !isAdmin ? <ProductAccessSettings productId={product.id} user={user} />
                : route.section === "connections" ? <AiConnectionsSettings />
                : route.section === "devices" ? <NodeSettings products={products} nodeId={route.nodeId} onOpenNode={nodeId => navigate({ section: "devices", nodeId })} />
                : route.section === "dispatch" ? <DispatchDefaultsSettings onOpenDevices={() => navigate({ section: "devices" })} />
                : route.section === "accounts" || route.section === "access" && isAdmin ? <AccountManagement user={user} products={products} accountId={route.accountId} filterProductId={route.section === "access" ? product?.id : route.filterProductId} onNavigate={(accountId, filterProductId) => navigate({ section: "accounts", accountId, filterProductId })} />
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
