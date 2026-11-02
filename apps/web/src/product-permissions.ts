import type { AuthenticatedUser, ProductPermission } from "./api";
import type { Product } from "./types";

/** Current project roles govern management; creator attribution remains historical. */
export function mayAdministerProduct(user: AuthenticatedUser, product: Product): boolean {
  return user.role === "admin" || product.access?.isProjectAdmin === true;
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
