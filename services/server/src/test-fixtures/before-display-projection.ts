import type { DatabaseSync } from "node:sqlite";

/** Restore the pre-AND-484 fixture shape, including dependencies on old columns. */
export function beforeDisplayProjection(db: Pick<DatabaseSync,"prepare"|"exec">): void {
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'display_%'").all() as {name:string}[];
  for(const {name} of triggers)db.exec(`DROP TRIGGER "${name}"`);
  for(const name of ["merge_delivery_source_session","merge_delivery_source_batch","merge_batch_source_session"])db.exec(`DROP INDEX IF EXISTS ${name}`);
  for(const name of ["item_list_projection","item_list_dirty","item_list_changes","merge_display_dirty","merge_display_dependencies","merge_delivery_projection","merge_batch_projection","merge_session_projection","merge_display_activity","merge_display_activity_scopes"])db.exec(`DROP TABLE IF EXISTS ${name}`);
  db.exec("DELETE FROM schema_migrations WHERE version IN (202611090156,202611090308,202611120007,202611120900,202611121223)");
}
