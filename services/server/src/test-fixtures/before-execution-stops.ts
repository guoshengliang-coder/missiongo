import type { DatabaseSync } from "node:sqlite";

/** Remove later triggers before reconstructing historical session tables in migration tests. */
export function beforeExecutionStops(db: DatabaseSync): void {
  for (const name of ["invalidate_linked_performer_stop_on_insert","invalidate_linked_performer_stop_on_update","invalidate_external_stop_on_activity","invalidate_external_stop_on_progress","invalidate_performer_stop_on_activity","invalidate_dispatch_stop_on_activity",
    "invalidate_external_stop_on_command","invalidate_dispatch_stop_on_command",
    "invalidate_external_stop_on_delivery","invalidate_dispatch_stop_on_delivery",
    "invalidate_external_stop_on_message","invalidate_dispatch_stop_on_message"]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  db.exec("DROP TABLE IF EXISTS item_performer_stop_confirmations;");
  if ((db.prepare("PRAGMA table_info(item_executions)").all() as {name:string}[]).some(row=>row.name === "stop_generation")) {
    db.exec("ALTER TABLE item_executions DROP COLUMN stop_generation;");
  }
  db.exec("DELETE FROM schema_migrations WHERE version=202611040657;");
  db.exec(`DROP TABLE IF EXISTS item_execution_stop_confirmations;
    DROP TABLE IF EXISTS item_execution_activity;
    DELETE FROM schema_migrations WHERE version=202611031536;`);
}
