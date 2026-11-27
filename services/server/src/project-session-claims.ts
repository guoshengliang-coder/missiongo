import { assertDispatchExecution } from "./builder-authority.js";
import { conflict } from "./errors.js";
import type { ExternalSessionIdentity } from "./external-agent-session-store.js";
import type { MissionGoStore } from "./store.js";

interface ProjectSession {
  dispatchId: string;
  projectSessionId: string;
  productId: string;
  status: string;
  archived: string | null;
  ref: string;
  revoked: string | null;
}

/** Reuse a verified project conversation; never infer identity from names or item keys. */
export class ProjectSessionClaims {
  constructor(private readonly store: MissionGoStore) {}

  resolve(accountId: string, itemKey: string, input: { dispatchId?: string; session?: ExternalSessionIdentity }): ProjectSession | undefined {
    if (!input.dispatchId && input.session?.refKind !== "native") return undefined;
    const rows = this.store.database.connection.prepare(`SELECT d.id AS dispatchId,s.id AS projectSessionId,
      f.product_id AS productId,d.status,COALESCE(s.archived_at,d.archived_at) AS archived,
      s.agent_session_ref AS ref,n.revoked_at AS revoked
      FROM free_session_starts f JOIN dispatches d ON d.id=f.dispatch_id
      JOIN agent_sessions s ON s.dispatch_id=d.id JOIN nodes n ON n.id=d.node_id
      WHERE d.account_id=? AND ${input.dispatchId ? "d.id=?" : "s.agent_kind=? AND s.agent_session_ref=?"}`)
      .all(accountId, ...(input.dispatchId ? [input.dispatchId] : [input.session!.agentKind, input.session!.sessionRef])) as unknown as ProjectSession[];
    if (!rows.length) return undefined;
    if (rows.length !== 1) throw conflict("project_session_ambiguous", "The native identity matches multiple project conversations; use the original dispatchId.");
    const row = rows[0]!;
    assertDispatchExecution(this.store.database, row.dispatchId);
    if (row.productId !== this.store.getWorkItem(itemKey).productId || row.status !== "launched"
      || row.archived || row.revoked || row.ref.startsWith("pending:")) {
      throw conflict("project_session_not_claimable", "Use an active project conversation owned by this account and scoped to the item's product.");
    }
    return row;
  }

  resolveScopedDispatch(accountId: string, itemKeys: readonly string[], session?: ExternalSessionIdentity): string | undefined {
    if (session?.refKind !== "native" || !itemKeys.length) return;
    const db = this.store.database.connection;
    const rows = db.prepare(`SELECT d.id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id
      JOIN nodes n ON n.id=d.node_id WHERE d.account_id=? AND s.agent_kind=? AND s.agent_session_ref=?
        AND n.revoked_at IS NULL AND d.status='launched' AND d.archived_at IS NULL AND s.archived_at IS NULL
        AND d.repository_scope_json IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) keys WHERE NOT EXISTS (
            SELECT 1 FROM dispatch_items i JOIN work_items w ON w.id=i.item_id
            WHERE i.dispatch_id=d.id AND w.item_key=keys.value
          )
        )`).all(accountId, session.agentKind, session.sessionRef, JSON.stringify(itemKeys)) as unknown as { id: string }[];
    if (rows.length > 1) throw conflict("dispatch_identity_ambiguous", "Use the original dispatchId for this conversation.");
    if (rows[0]) assertDispatchExecution(this.store.database, rows[0].id);
    return rows[0]?.id;
  }

  link(project: ProjectSession, itemKey: string): void {
    const item = this.store.getWorkItem(itemKey);
    // The caller wraps this association, the claim and its receipt in one transaction.
    // Existing projections already use dispatch_items for item detail and execution history.
    this.store.database.connection.prepare(`INSERT OR IGNORE INTO dispatch_items(dispatch_id,item_id,position)
      SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM dispatch_items WHERE dispatch_id=?`)
      .run(project.dispatchId, item.id, project.dispatchId);
  }

  assertLinked(project: ProjectSession, itemKey: string): void {
    if (!this.store.database.connection.prepare(`SELECT 1 FROM dispatch_items i JOIN work_items w ON w.id=i.item_id
      WHERE i.dispatch_id=? AND w.item_key=?`).get(project.dispatchId, itemKey)) {
      throw conflict("project_session_item_not_claimed", "Claim this item with the original project dispatchId before registering progress.");
    }
  }
}
