import type { DatabaseSync } from "node:sqlite";
import { beforeExecutionStops } from "./before-execution-stops.js";

/** Reconstruct a pre-AND-367 fixture before tests remove older tables/columns.
 * Collaboration triggers refer to work_items.revision, which did not exist then. */
export function beforeCollaboration(db: DatabaseSync): void {
  beforeExecutionStops(db);
  db.exec(`DROP TABLE collaboration_receipts;
    DROP TABLE collaboration_events;
    DROP TABLE collaboration_requests;
    DROP TABLE collaboration_drafts;
    DROP TABLE collaboration_grants;
    DELETE FROM schema_migrations WHERE version=202611030735;`);
}
