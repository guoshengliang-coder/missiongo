import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import type { AuthenticatedUser } from "./api";
import type { Product } from "./types";
import { AccountSettings, AccountManagement, AiConnectionsSettings, DeepSeekSettings } from "./account-settings";
import { DisplaySettings } from "./display-settings";
import { DispatchDefaultsSettings } from "./dispatch-defaults-settings";
import { NodeSettings } from "./node-settings";
import { useI18n, type MessageKey } from "./i18n";
import { mayAdministerProduct } from "./product-permissions";
import { SettingsDraftProvider } from "./settings-drafts";
import { PRODUCT_SETTINGS, type SettingsRoute, type SettingsSection, type ProductSettingsSection } from "./settings-state";

const LABELS: Record<SettingsSection, MessageKey> = {
  index: "settingsEntry", profile: "settingsProfile", display: "displaySettings", connections: "settingsConnections",
  devices: "settingsDevices", dispatch: "dispatchDefaultsTitle", product: "productInformation", components: "moduleManagement",
  artifacts: "releaseArtifacts", tokens: "settingsSdk", access: "settingsMembers", accounts: "manageAccountsTab", ai: "settingsAiService", "new-product": "addProduct",
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
  navigate: (route: SettingsRoute | null) => void; guard: RefObject<() => boolean>; onLoggedOut: () => void;
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
  const inProduct = PRODUCT_SETTINGS.includes(route.section as ProductSettingsSection) || route.section === "new-product";
  const isAdmin = user.role === "admin";
  const personal: SettingsSection[] = ["profile", "display", "connections", ...(canUseAi ? ["devices", "dispatch"] as const : [])];
  const productSections: SettingsSection[] = product ? PRODUCT_SETTINGS.filter(value => value !== "access" || mayAdministerProduct(user, product)) : [];
  const groups = [
    { label: "settingsPersonal" as const, sections: personal },
    { label: "settingsProduct" as const, sections: [...productSections, "new-product" as const] },
    ...(isAdmin ? [{ label: "settingsSystem" as const, sections: ["accounts", "ai"] as SettingsSection[] }] : []),
  ];
  const allowed = groups.some(group => group.sections.includes(route.section)) && (!inProduct || route.section === "new-product" || Boolean(product));
  const go = (section: SettingsSection) => navigate(PRODUCT_SETTINGS.includes(section as ProductSettingsSection) && product ? { section, productId: product.id } : { section });
  useEffect(() => { content.current?.scrollTo({ top: 0 }); content.current?.focus({ preventScroll: true }); }, [route.section, route.productId]);
  const scope = route.section === "new-product" ? t("settingsNewProductScope") : inProduct ? t("settingsProductScope", { product: product?.name ?? "" }) : route.section === "accounts" || route.section === "ai" ? t("settingsSystemScope") : t("settingsPersonalScope");
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
              {group.sections.map(section => <button type="button" key={section} aria-current={route.section === section ? "page" : undefined} onClick={() => go(section)}>
                <span>{t(LABELS[section])}</span>{section === "new-product" ? <Plus size={16} /> : <ChevronRight size={16} />}
              </button>)}
            </section>)}
          </nav>
          {route.section !== "index" && <main className="settings-page-main" ref={content} tabIndex={-1} onFocusCapture={event => {
            const field = event.target;
            requestAnimationFrame(() => { if (content.current) revealSettingsField(field, content.current); });
          }}>
            <button type="button" className="text-button settings-directory-back" onClick={() => navigate({ section: "index" })}><ArrowLeft size={16} /> {t("settingsDirectory")}</button>
            <header className="settings-page-title">
              <div><p>{scope}</p><h1>{t(LABELS[route.section])}</h1></div>
              {inProduct && route.section !== "new-product" && <label>{t("settingsCurrentProduct")}<select value={product?.id ?? ""} onChange={event => navigate({ section: route.section, productId: event.target.value })}>
                {!product && <option value="">{t("settingsUnavailable")}</option>}
                {products.map(value => <option key={value.id} value={value.id}>{value.name}{value.archivedAt ? ` · ${t("archived")}` : ""}</option>)}
              </select></label>}
            </header>
            <div className="settings-page-body" key={`${route.section}:${product?.id ?? ""}`}>
              {!allowed ? <p role="alert">{t("settingsUnavailable")}</p>
                : route.section === "profile" ? <AccountSettings user={user} products={products} onLoggedOut={onLoggedOut} />
                : route.section === "display" ? <DisplaySettings user={user} />
                : route.section === "connections" ? <AiConnectionsSettings />
                : route.section === "devices" ? <NodeSettings products={products} />
                : route.section === "dispatch" ? <DispatchDefaultsSettings onOpenDevices={() => navigate({ section: "devices" })} />
                : route.section === "accounts" ? <AccountManagement user={user} products={products} />
                : route.section === "ai" ? <DeepSeekSettings />
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
