import { useEffect, useRef } from "react";
import { productIconUrl } from "./api";
import type { Product } from "./types";

export const PRODUCT_ICON_PRELOAD_LIMIT = 8;
export const PRODUCT_ICON_PRELOAD_CONCURRENCY = 2;
const START_DELAY_MS = 200;
const LOAD_TIMEOUT_MS = 8_000;
type IconProduct = Pick<Product, "id" | "updatedAt" | "hasIcon" | "archivedAt">;
type ImageLoader = (url: string, signal: AbortSignal) => Promise<boolean>;

export function productIconPreloadUrls(products: readonly IconProduct[], selectedId: string): string[] {
  const eligible = products.filter(product => product.hasIcon && !product.archivedAt);
  return [...new Set([
    ...eligible.filter(product => product.id === selectedId),
    ...eligible.filter(product => product.id !== selectedId),
  ].map(productIconUrl))].slice(0, PRODUCT_ICON_PRELOAD_LIMIT);
}

/** Warm the browser's private cache, retaining neither image bytes nor failures. */
function loadImage(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image();
    let finished = false;
    const timer = setTimeout(() => finish(false, true), LOAD_TIMEOUT_MS);
    const finish = (success: boolean, cancel = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      image.onload = null;
      image.onerror = null;
      if (cancel) image.removeAttribute("src");
      resolve(success);
    };
    const aborted = () => finish(false, true);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    image.onload = () => finish(image.naturalWidth > 0);
    image.onerror = () => finish(false);
    image.decoding = "async";
    image.fetchPriority = "low";
    image.src = url;
    if (image.complete && image.naturalWidth > 0) finish(true);
  });
}

/** One account-scoped queue. Updates replace pending work and deduplicate requests. */
export class ProductIconPreloader {
  private pending: string[] = [];
  private active = new Map<string, AbortController>();
  private completed = new Set<string>();
  private allowed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly load: ImageLoader = loadImage) {}

  update(urls: readonly string[]) {
    if (this.disposed) return;
    this.allowed = new Set(urls.slice(0, PRODUCT_ICON_PRELOAD_LIMIT));
    for (const url of this.completed) if (!this.allowed.has(url)) this.completed.delete(url);
    for (const [url, controller] of this.active) if (!this.allowed.has(url)) {
      // Cancellation stops browser I/O now; its promise may settle in a later
      // microtask, after the same URL has already returned to the warm set.
      this.active.delete(url);
      controller.abort();
    }
    this.pending = [...this.allowed].filter(url => !this.active.has(url) && !this.completed.has(url));
    if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, START_DELAY_MS);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.pending = [];
    this.completed.clear();
  }

  private pump() {
    if (this.disposed) return;
    while (this.active.size < PRODUCT_ICON_PRELOAD_CONCURRENCY && this.pending.length) {
      const url = this.pending.shift()!;
      const controller = new AbortController();
      this.active.set(url, controller);
      void Promise.resolve().then(() => controller.signal.aborted ? false : this.load(url, controller.signal))
        .catch(() => false).then(success => {
          if (this.active.get(url) !== controller) return;
          this.active.delete(url);
          if (!this.disposed && !controller.signal.aborted && success && this.allowed.has(url)) this.completed.add(url);
          this.pump();
        });
    }
  }
}

export function useProductIconPreload(accountId: string | undefined, products: readonly IconProduct[], selectedId: string) {
  const preloader = useRef<ProductIconPreloader | null>(null);
  const urlsKey = JSON.stringify(productIconPreloadUrls(products, selectedId));
  useEffect(() => {
    if (!accountId) return;
    const queue = new ProductIconPreloader();
    preloader.current = queue;
    return () => { queue.dispose(); preloader.current = null; };
  }, [accountId]);
  useEffect(() => { preloader.current?.update(JSON.parse(urlsKey) as string[]); }, [accountId, urlsKey]);
}
