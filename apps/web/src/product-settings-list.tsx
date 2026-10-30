import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ProductBadge } from "./product-badge";
import { useI18n } from "./i18n";
import type { Product } from "./types";

/** A product is chosen explicitly before any product-scoped editor is opened. */
export function ProductSettingsList({ products, onOpen, description, actions }: {
  actions?: ReactNode;
  products: readonly Product[];
  onOpen: (product: Product) => void;
  description?: ((product: Product) => ReactNode) | undefined;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const visible = products.filter(product =>
    (status === "all" || Boolean(product.archivedAt) === (status === "archived"))
    && `${product.name} ${product.keyPrefix}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="settings-product-list" aria-label={t("settingsProducts")}>
    <div className="settings-list-toolbar">
      <label className="settings-toolbar-search"><span className="sr-only">{t("settingsSearchProducts")}</span><input placeholder={t("settingsSearchProducts")} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label><span className="sr-only">{t("settingsProductStatus")}</span><select value={status} onChange={event => setStatus(event.target.value)}>
        <option value="active">{t("settingsActiveProducts")}</option>
        <option value="archived">{t("settingsArchivedProducts")}</option>
        <option value="all">{t("settingsAllProducts")}</option>
      </select></label>
      {actions}
    </div>
    <p className="account-note" role="status">{t("settingsProductCount", { count: visible.length })}</p>
    <div className="settings-product-grid">
      {visible.map(product => <button type="button" className="settings-product-card" key={product.id} data-product-id={product.id} onClick={() => onOpen(product)}>
        <ProductBadge product={product} size={40} />
        <span><strong>{product.name}</strong><small>{product.keyPrefix}{product.archivedAt ? ` · ${t("archived")}` : ""}</small>
          {description && <small>{description(product)}</small>}
        </span><ChevronRight size={18} />
      </button>)}
    </div>
    {!visible.length && <p className="settings-empty">{t("settingsNoMatchingProducts")}{(search || status !== "active") && <button type="button" className="text-button" onClick={() => { setSearch(""); setStatus("active"); }}>{t("clearListFilters")}</button>}</p>}
  </section>;
}
