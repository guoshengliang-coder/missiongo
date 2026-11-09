/** Read-only console invalidations. Business data is fetched through its existing
 * permission-checked endpoint; a version never authorizes a write or replay. */
export const CONSOLE_CHANGE_KINDS = ["item","sessions","nodes","merge","personal","products","plan","artifact","history","config","admin","access"] as const;
export type ConsoleChangeKind = (typeof CONSOLE_CHANGE_KINDS)[number];
export interface ConsoleChangeResource {
 readonly kind: ConsoleChangeKind;
 readonly productId?: string;
 readonly itemKey?: string;
 readonly resourceId?: string;
}
