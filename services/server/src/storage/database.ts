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

    const flatComponentMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 6")
      .get() as unknown as { version: number } | undefined;
    if (!flatComponentMigration) {
      this.transaction(() => {
        const componentColumns = this.connection
          .prepare("PRAGMA table_info(components)")
          .all() as unknown as Array<{ name: string }>;
        if (componentColumns.some((column) => column.name === "parent_component_id")) {
          this.connection.exec("DROP INDEX IF EXISTS idx_components_parent;");
          this.connection.exec("ALTER TABLE components DROP COLUMN parent_component_id;");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(6, new Date().toISOString());
      });
    }
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(7, new Date().toISOString());

    const structuredReportMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 8")
      .get() as unknown as { version: number } | undefined;
    if (!structuredReportMigration) {
      this.transaction(() => {
        const workItemColumns = this.connection
          .prepare("PRAGMA table_info(work_items)")
          .all() as unknown as Array<{ name: string }>;
        if (!workItemColumns.some((column) => column.name === "report_json")) {
          this.connection.exec("ALTER TABLE work_items ADD COLUMN report_json TEXT;");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(8, new Date().toISOString());
      });
    }
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(9, new Date().toISOString());
    this.connection
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(10, new Date().toISOString());

    const attachmentNumberMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 11")
      .get() as unknown as { version: number } | undefined;
    if (!attachmentNumberMigration) {
      this.transaction(() => {
        const attachmentColumns = this.connection
          .prepare("PRAGMA table_info(work_item_attachments)")
          .all() as unknown as Array<{ name: string }>;
        if (!attachmentColumns.some((column) => column.name === "display_number")) {
          this.connection.exec("ALTER TABLE work_item_attachments ADD COLUMN display_number INTEGER;");
        }
        this.connection.exec(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY item_id, kind
              ORDER BY created_at, rowid
            ) AS number
            FROM work_item_attachments
          )
          UPDATE work_item_attachments
          SET display_number = (SELECT number FROM ranked WHERE ranked.id = work_item_attachments.id)
          WHERE display_number IS NULL;
        `);
        this.connection.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_attachments_item_kind_number
          ON work_item_attachments(item_id, kind, display_number);
        `);
        this.connection.exec(`
          CREATE TABLE IF NOT EXISTS work_item_attachment_counters (
            item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log')),
            next_number INTEGER NOT NULL CHECK (next_number > 0),
            PRIMARY KEY (item_id, kind)
          ) STRICT;
        `);
        this.connection.exec(`
          INSERT OR IGNORE INTO work_item_attachment_counters (item_id, kind, next_number)
          SELECT item_id, kind, MAX(display_number) + 1
          FROM work_item_attachments
          GROUP BY item_id, kind;
        `);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(11, new Date().toISOString());
      });
    }

    // Products and modules are only ever soft-retired: work items reference a
    // module by id, so deleting one would strand the context on every item that
    // came from it.
    const archiveMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 12")
      .get() as unknown as { version: number } | undefined;
    if (!archiveMigration) {
      this.transaction(() => {
        for (const table of ["products", "components"]) {
          const columns = this.connection
            .prepare(`PRAGMA table_info(${table})`)
            .all() as unknown as Array<{ name: string }>;
          if (!columns.some((column) => column.name === "archived_at")) {
            this.connection.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT;`);
          }
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(12, new Date().toISOString());
      });
    }

    // 13 and 14 belong to the comment work on feat/ai-write-comments; this one
    // takes 15 so the two branches do not both claim a number.
    // Readable material that is not machine output became its own kind, and the
    // CHECK constraint above lives inside the table definition, so SQLite can
    // only widen it by rebuilding. Existing rows keep the kind they were filed
    // under -- a .txt already stored as a log stays a log, because moving it
    // would rewrite history the diagnostics panel already showed.
    const documentKindMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 15")
      .get() as unknown as { version: number } | undefined;
    if (!documentKindMigration) {
      this.connection.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.transaction(() => {
          this.connection.exec(`
            CREATE TABLE work_item_attachments_new (
              id TEXT PRIMARY KEY,
              item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
              kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log', 'document')),
              display_number INTEGER NOT NULL CHECK (display_number > 0),
              original_filename TEXT NOT NULL,
              storage_filename TEXT NOT NULL UNIQUE,
              content_type TEXT NOT NULL,
              size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
              created_at TEXT NOT NULL
            ) STRICT;
            INSERT INTO work_item_attachments_new
              SELECT id, item_id, kind, display_number, original_filename, storage_filename, content_type, size_bytes, created_at
              FROM work_item_attachments;
            DROP TABLE work_item_attachments;
            ALTER TABLE work_item_attachments_new RENAME TO work_item_attachments;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_attachments_item_kind_number
              ON work_item_attachments(item_id, kind, display_number);

            CREATE TABLE work_item_attachment_counters_new (
              item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
              kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log', 'document')),
              next_number INTEGER NOT NULL CHECK (next_number > 0),
              PRIMARY KEY (item_id, kind)
            ) STRICT;
            INSERT INTO work_item_attachment_counters_new
              SELECT item_id, kind, next_number FROM work_item_attachment_counters;
            DROP TABLE work_item_attachment_counters;
            ALTER TABLE work_item_attachment_counters_new RENAME TO work_item_attachment_counters;
          `);
          const violations = this.connection.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) throw new Error("Rebuilding the attachment tables broke a foreign key.");
          this.connection
            .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(15, new Date().toISOString());
        });
      } finally {
        this.connection.exec("PRAGMA foreign_keys = ON;");
      }
    }
    this.connection.exec("PRAGMA optimize;");
  }
}
