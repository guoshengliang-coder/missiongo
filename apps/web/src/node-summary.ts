import type { DispatchNode, Product } from "./types";

export interface RepoCoverage {
  /** Live products this device has a saved checkout for. */
  readonly configured: number;
  /** Live products this account can see. */
  readonly total: number;
}

/**
 * How many of this account's products can be dispatched to the device, for the
 * collapsed row (AND-54). Only saved mappings count: a suggestion or a path
 * somebody is still typing sends no work anywhere until it is saved. Archived
 * products are left out on both sides -- nobody dispatches to them, so a device
 * without one is not missing anything.
 */
export function repoCoverage(
  node: Pick<DispatchNode, "repos">,
  products: readonly Pick<Product, "id" | "archivedAt">[],
): RepoCoverage {
  const mapped = new Set(node.repos.filter((repo) => repo.repoPath.trim()).map((repo) => repo.productId));
  const live = products.filter((product) => !product.archivedAt);
  return { configured: live.filter((product) => mapped.has(product.id)).length, total: live.length };
}

/**
 * Whether the repository form holds a typed path that differs from what is
 * saved. Collapsing a card keeps its drafts, so the row has to say they are
 * there; picking the saved path again is not an edit.
 */
export function hasRepoDrafts(
  drafts: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(drafts).some(([productId, path]) => path.trim() !== (saved[productId] ?? "").trim());
}

/**
 * One device has nothing to choose between, so its card starts open; with
 * several the list of rows is the overview, and each opens on its own.
 */
export function deviceStartsOpen(deviceCount: number): boolean {
  return deviceCount === 1;
}
