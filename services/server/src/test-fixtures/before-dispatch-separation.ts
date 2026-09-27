import type { DatabaseSync } from "node:sqlite";
import { MANAGED_EXECUTION_SCHEMA } from "../storage/managed-execution-schema.js";
const version = 202609271508;
const names = ["message", "settings", "restore", "insert", "start"];
export function restoreNodeOwnership(db: DatabaseSync): void {
  db.exec(`DELETE FROM schema_migrations WHERE version=${version};
    CREATE UNIQUE INDEX IF NOT EXISTS managed_execution_node_owner ON managed_execution_intents(node_id) WHERE ownership_held=1;`);
  for (const name of names) {
    db.exec(`DROP TRIGGER IF EXISTS managed_manual_${name};`);
    db.exec(MANAGED_EXECUTION_SCHEMA.match(new RegExp(`CREATE TRIGGER managed_manual_${name}\\s[\\s\\S]*?END;`))![0]);
  }
}
