import type { WorkItemPriority, WorkItemType } from "./work-item.js";

/** Additional list filters; dates are inclusive local calendar days in the UI,
 * and UTC instants (exclusive upper bounds) at the HTTP/store boundary. */
export interface ItemFilters {
  readonly collaborations?: readonly ("sent"|"received"|"waiting"|"verification")[];
  /** Server-resolved current viewer, used only by the verification filter. */
  readonly collaborationVerifierAccountId?: string;
  readonly types?: readonly WorkItemType[];
  readonly priorities?: readonly WorkItemPriority[];
  readonly proposerKeys?: readonly string[];
  readonly sourceComponentIds?: readonly string[];
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly updatedFrom?: string;
  readonly updatedTo?: string;
}
export const ITEM_FILTER_ARRAYS = [
  "collaborations",
  "types",
  "priorities",
  "proposerKeys",
  "sourceComponentIds",
] as const;
export const ITEM_FILTER_DATES = [
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
] as const;

/** Stable across equivalent multi-select orders, for URLs and cached counts. */
export function itemFilterKey(filters: ItemFilters = {}): string {
  return JSON.stringify([
    ...ITEM_FILTER_ARRAYS.map((key) => [...new Set(filters[key] ?? [])].sort()),
    ...ITEM_FILTER_DATES.map((key) => filters[key] ?? ""),
  ]);
}
