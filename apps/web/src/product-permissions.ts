import type { AuthenticatedUser, ProductPermission } from "./api";
import type { Product } from "./types";

/**
 * Whether this account administers this product: retires it, and decides who
 * else reaches it.
 *
 * One judgement for both, because the server makes one judgement for both
 * (`requireProductOwnership`). Keeping them as two expressions in two files is
 * how they would drift.
 *
 * A product with no recorded creator predates accounts, and the seed backfill
 * hands those to the administrator who ran the deployment -- so an absent
 * creator means "not a member's", and answers false here. A creator who was
 * since deleted leaves the id pointing at nobody, which matches no live account
 * and answers false the same way. Both match what the server does, so a control
 * drawn from this does not offer something that comes back 403.
 *
 * The caller decides what to do while `user` is still loading: a button is
 * better drawn hopefully and refused by the server than flickering disabled, and
 * a tab is better withheld than shown and then failing to load.
 */
export function mayAdministerProduct(user: AuthenticatedUser, product: Product): boolean {
  return user.role === "admin" || product.createdByAccountId === user.id;
}

export type PermissionField = "canView" | "canOperate" | "canUseAi";

/**
 * One checkbox in a permission grid (AND-63).
 *
 * A member's box is its row. An administrator's is what the role gives it:
 * view and operate are always on and no row can take them away, so they are
 * drawn ticked and cannot be unticked. AI is on by role too -- unless the
 * administrator's AI reach has been narrowed, in which case the rows decide it
 * like a member's, and the box is the row again.
 *
 * `byRole` says the value comes from the role rather than a row, so the caller
 * can lock it; `checked` is what to draw. Operate and AI each include viewing,
 * which the view box reflects for members as it always has.
 */
export function permissionCell(
  field: PermissionField,
  row: Omit<ProductPermission, "productId">,
  administrator: { readonly aiUnrestricted: boolean } | undefined,
): { readonly checked: boolean; readonly byRole: boolean } {
  if (administrator && field !== "canUseAi") return { checked: true, byRole: true };
  if (administrator && administrator.aiUnrestricted) return { checked: true, byRole: true };
  if (field === "canView") return { checked: row.canView || row.canOperate || row.canUseAi, byRole: false };
  return { checked: row[field], byRole: false };
}
