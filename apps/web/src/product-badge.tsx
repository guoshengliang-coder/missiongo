import { useLayoutEffect, useRef, useState } from "react";
import { productIconUrl } from "./api";
import { productBadgeColor } from "./product-color";
import type { Product } from "./types";

/**
 * Products are told apart at a glance. An uploaded icon wins; otherwise the item
 * prefix -- the same AND / HG that labels every key in the list -- sits on a
 * colour derived from the product id, so a product is distinguishable the moment
 * it exists, with nothing to configure.
 */
export function ProductBadge({ product, size = 22, loading = "lazy" }: {
  product: Product; size?: number; loading?: "lazy" | "eager";
}) {
  const src = product.hasIcon ? productIconUrl(product) : undefined;
  // Version changes remount the readiness boundary, isolating late decodes.
  return <BadgeImage key={src ?? product.id} product={product} size={size} src={src} loading={loading} />;
}

function BadgeImage({ product, size, src, loading }: {
  product: Product; size: number; src: string | undefined; loading: "lazy" | "eager";
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [state, setState] = useState(src ? "loading" : "fallback");
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    let active = true;
    let decoding = false;
    const failed = () => { if (active) setState("fallback"); };
    const loaded = () => {
      if (!active || decoding || !image.complete || image.naturalWidth === 0) return;
      decoding = true;
      const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decoded.then(() => {
        if (active && image.complete && image.naturalWidth > 0) setState("ready");
      }, failed);
    };
    image.addEventListener("load", loaded);
    image.addEventListener("error", failed);
    // A cached image can complete before the listeners are installed.
    if (image.complete) { if (image.naturalWidth > 0) loaded(); else failed(); }
    return () => {
      active = false;
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
    };
  }, []);

  return <span className="product-badge generated" aria-hidden="true" data-icon-state={state}
    style={{ width: size, height: size, background: state === "ready" ? undefined : productBadgeColor(product.id), fontSize: Math.max(11, Math.round(size * 0.38)) }}>
    <span className="product-badge-label">{product.keyPrefix.slice(0, 3)}</span>
    {src && <img ref={imageRef} className="product-badge-image" src={src} alt="" loading={loading} decoding="async" />}
  </span>;
}
