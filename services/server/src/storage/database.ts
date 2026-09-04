import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { INITIAL_SCHEMA } from "./schema.js";

export class MissionGoDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }

    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") {
      this.connection.exec("PRAGMA journal_mode = WAL;");
    }
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.connection.exec("COMMIT;");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK;");
      throw error;
    }
  }

  private migrate(): void {
    this.connection.exec(INITIAL_SCHEMA);
    const componentColumns = this.connection.prepare("PRAGMA table_info(components)").all() as unknown as Array<{ name: string }>;
    if (!componentColumns.some((column) => column.name === "parent_component_id")) {
      this.connection.exec(
        "ALTER TABLE components ADD COLUMN parent_component_id TEXT REFERENCES components(id) ON DELETE SET NULL;",
      );
    }
    this.connection.exec("CREATE INDEX IF NOT EXISTS idx_components_parent ON components(parent_component_id);");
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, new Date().toISOString());
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(2, new Date().toISOString());
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(3, new Date().toISOString());
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(4, new Date().toISOString());
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(5, new Date().toISOString());
    this.connection.exec("PRAGMA optimize;");
  }
}
