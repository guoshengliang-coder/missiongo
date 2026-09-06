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
    // Events recorded that an agent acted but not which one. An AI reading an
    // item back cannot then tell a fact a person supplied from a guess the
    // previous agent wrote, and treats its own speculation as evidence.
    const eventAttributionMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 13")
      .get() as unknown as { version: number } | undefined;
    if (!eventAttributionMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(work_item_events)")
          .all() as unknown as Array<{ name: string }>;
        for (const column of ["account_id", "client_id", "execution_id"]) {
          if (!columns.some((existing) => existing.name === column)) {
            this.connection.exec(`ALTER TABLE work_item_events ADD COLUMN ${column} TEXT;`);
          }
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(13, new Date().toISOString());
      });
    }
    // Analyses used to be events. They are comments: an agent writes one to be
    // read and answered, and a wrong one has to be withdrawable. Move them across
    // rather than leaving the timeline with two ways to say the same thing.
    const commentMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 14")
      .get() as unknown as { version: number } | undefined;
    if (!commentMigration) {
      this.transaction(() => {
        // Two tables cannot be ordered against each other by an ISO timestamp:
        // a comment and the status change it explains are usually written in the
        // same millisecond, and the tie then resolves by whichever table the
        // merge happened to read first. A per-item sequence settles it.
        const eventColumns = this.connection
          .prepare("PRAGMA table_info(work_item_events)")
          .all() as unknown as Array<{ name: string }>;
        if (!eventColumns.some((column) => column.name === "timeline_seq")) {
          this.connection.exec("ALTER TABLE work_item_events ADD COLUMN timeline_seq INTEGER NOT NULL DEFAULT 0;");
        }
        this.connection.exec(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY created_at, rowid) AS seq
            FROM work_item_events
          )
          UPDATE work_item_events
          SET timeline_seq = (SELECT seq FROM ranked WHERE ranked.id = work_item_events.id)
          WHERE timeline_seq = 0;
        `);
        this.connection.exec(`
          INSERT INTO work_item_comments
            (id, item_id, actor_kind, account_id, client_id, execution_id, body_kind, body_json,
             timeline_seq, created_at)
          SELECT id, item_id, actor_kind, account_id, client_id, execution_id, 'structured', payload_json,
                 timeline_seq, created_at
          FROM work_item_events
          WHERE event_type = 'analysis_appended';
        `);
        this.connection.exec("DELETE FROM work_item_events WHERE event_type = 'analysis_appended';");
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(14, new Date().toISOString());
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

    // A product can carry an uploaded icon. It is small enough (a 96px PNG) to
    // live in the row rather than in the attachment store, which is scoped to
    // work items.
    const productIconMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 16")
      .get() as unknown as { version: number } | undefined;
    if (!productIconMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(products)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "icon_png")) {
          this.connection.exec("ALTER TABLE products ADD COLUMN icon_png TEXT;");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(16, new Date().toISOString());
      });
    }
    // The analysis fields were bug-shaped -- conclusion, evidence, risks -- but
    // MissionGo holds ideas, requirements, tasks and notes too, and "root cause"
    // is not the question for most of them. The shape becomes what an analysis of
    // any item actually has: what was understood, what was found, and what could
    // not be settled alone.
    //
    // Done in JS rather than SQL because the JSON1 rewrite for a nested array is
    // considerably harder to read than the two lines it replaces.
    const analysisShapeMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 17")
      .get() as unknown as { version: number } | undefined;
    if (!analysisShapeMigration) {
      this.transaction(() => {
        const rows = this.connection
          .prepare("SELECT id, body_json FROM work_item_comments WHERE body_kind = 'structured'")
          .all() as unknown as Array<{ id: string; body_json: string }>;
        const update = this.connection.prepare("UPDATE work_item_comments SET body_json = ? WHERE id = ?");
        for (const row of rows) {
          const body = JSON.parse(row.body_json) as Record<string, unknown>;
          if (body.conclusion === undefined) continue;
          const { conclusion, risks, ...rest } = body;
          update.run(JSON.stringify({
            // These predate the field, and inventing one would put words in the
            // agent's mouth. Say so instead.
            understanding: "（迁移自旧格式，当时未记录对条目的理解）",
            finding: conclusion,
            openQuestions: Array.isArray(risks) ? risks : [],
            ...rest,
          }), row.id);
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(17, new Date().toISOString());
      });
    }
    this.connection.exec("PRAGMA optimize;");
  }
}
