import type { PersonalAttentionProductCount } from "@missiongo/domain";

/** Counts arrive only for products that hold any; a product with none is absent. */
export function productCount(rows: readonly PersonalAttentionProductCount[] | undefined, productId: string): number {
  return rows?.find(row => row.productId === productId)?.count ?? 0;
}
