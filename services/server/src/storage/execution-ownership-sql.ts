/** Internal SQL only. Expressions below are fixed call-site identifiers, never request data.
 * A registered installation is one local executor: every repository alias shares its owner.
 */
export function executorConflictSql(node: string, dispatch: string, registeredManual = true): string {
  const peers = `SELECT peer.id FROM nodes peer JOIN nodes target ON target.installation_id=peer.installation_id WHERE target.id=${node}`;
  const manual = `EXISTS (SELECT 1 FROM dispatches d WHERE d.node_id IN (${peers}) AND d.id<>${dispatch}
    AND (d.status IN ('queued','delivered','launched') OR d.delivered_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.id=d.id)
    AND NOT EXISTS (SELECT 1 FROM managed_manual_reconciliations m WHERE m.dispatch_id=d.id AND m.generation=d.execution_generation AND m.delivered_at=d.delivered_at))`;
  return `(EXISTS (SELECT 1 FROM managed_execution_intents i WHERE i.node_id IN (${peers}) AND i.ownership_held=1 AND i.id<>${dispatch})
    OR (${registeredManual ? `EXISTS (SELECT 1 FROM managed_executor_registrations r JOIN nodes n ON n.installation_id=r.installation_id WHERE n.id=${node}) AND ` : ""}${manual}))`;
}
