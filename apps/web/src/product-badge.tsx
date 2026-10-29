import { productIconUrl } from "./api";
import { productBadgeColor } from "./product-color";
import type { Product } from "./types";

/**
 * Products are told apart at a glance. An uploaded icon wins; otherwise the item
 * prefix -- the same AND / HG that labels every key in the list -- sits on a
 * colour derived from the product id, so a product is distinguishable the moment
 * it exists, with nothing to configure.
 */
export function ProductBadge({ product, size = 22 }: { product: Product; size?: number }) {
  if (product.hasIcon) return <img className="product-badge" src={productIconUrl(product)} alt="" aria-hidden="true" loading="lazy" decoding="async" style={{ width: size, height: size }} />;
  return <span className="product-badge generated" aria-hidden="true" style={{ width: size, height: size, background: productBadgeColor(product.id), fontSize: Math.max(11, Math.round(size * 0.38)) }}>{product.keyPrefix.slice(0, 3)}</span>;
}
