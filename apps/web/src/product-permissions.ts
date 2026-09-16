import type { AuthenticatedUser } from "./api";
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
