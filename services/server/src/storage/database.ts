import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { INITIAL_SCHEMA } from "./schema.js";

const LEGACY_CODEX_THREAD_LINK = /^codex:\/\/threads\/[A-Za-z0-9-]{1,100}$/;

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

  /**
   * Number a new migration with a UTC timestamp, YYYYMMDDHHMM, not the next
   * integer. Two branches both reaching for "the next number" collide, and the
   * collision is silent: after the merge the second migration finds the first
   * one's row, concludes it has already run, and never applies. The small
   * numbers below shipped before this rule and keep their identity forever.
   * scripts/check-migrations.mjs enforces it.
   */
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
    // A comment used to say only "AI", which told a reader nothing about which
    // machine's Claude Code or Codex wrote it, and every AI comment arrived at
    // full length with no way to skim. Give comments somewhere to record who
    // wrote them and a one-line summary. Both apply to free-text comments as
    // well as analyses, so they are columns rather than body_json keys.
    //
    // No backfill: the agent name and summary are things an agent has to say,
    // and inventing either for an existing comment would be putting words in
    // its mouth. Old comments read exactly as they always did.
    const commentBylineMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609081100")
      .get() as unknown as { version: number } | undefined;
    if (!commentBylineMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(work_item_comments)")
          .all() as unknown as Array<{ name: string }>;
        for (const column of ["agent_name", "summary"]) {
          if (!columns.some((existing) => existing.name === column)) {
            this.connection.exec(`ALTER TABLE work_item_comments ADD COLUMN ${column} TEXT;`);
          }
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609081100, new Date().toISOString());
      });
    }
    // Dispatching work to a machine needs somewhere to record the machines, the
    // checkout each product lives in on them, and what was handed over. The
    // tables are created by INITIAL_SCHEMA for a fresh database; this migration
    // is what brings an existing one up to the same shape.
    const dispatchMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609131130")
      .get() as unknown as { version: number } | undefined;
    if (!dispatchMigration) {
      this.transaction(() => {
        this.connection.exec(INITIAL_SCHEMA);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609131130, new Date().toISOString());
      });
    }
    // The machines report which checkouts they already have, so the console can
    // offer them instead of asking for a typed absolute path. Separate from the
    // migration above because that one may already have run on a live database.
    const repoCandidatesMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609131230")
      .get() as unknown as { version: number } | undefined;
    if (!repoCandidatesMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(nodes)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "repo_candidates_json")) {
          this.connection.exec("ALTER TABLE nodes ADD COLUMN repo_candidates_json TEXT NOT NULL DEFAULT '[]';");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609131230, new Date().toISOString());
      });
    }
    // Machines now join by signing in from the macOS client instead of typing a
    // pairing code. The client names its installation so a second login on the
    // same Mac finds the same node; pairing codes have no remaining use, and a
    // table nothing reads is a table someone later trusts.
    const clientRegistrationMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609140100")
      .get() as unknown as { version: number } | undefined;
    if (!clientRegistrationMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(nodes)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "installation_id")) {
          this.connection.exec("ALTER TABLE nodes ADD COLUMN installation_id TEXT;");
        }
        this.connection.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_account_installation
            ON nodes(account_id, installation_id) WHERE installation_id IS NOT NULL;
          DROP TABLE IF EXISTS node_pairing_codes;
        `);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609140100, new Date().toISOString());
      });
    }
    // A machine gets a nickname separate from its device name (AND-39), so that
    // clearing the nickname can go back to what the Mac calls itself. Existing
    // names stay where they are, as device names, and every nickname starts
    // empty: nothing recorded which names a person typed and which the client
    // sent, and the client overwrites the device name on its next sign-in anyway.
    const nicknameMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609141000")
      .get() as unknown as { version: number } | undefined;
    if (!nicknameMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(nodes)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "nickname")) {
          this.connection.exec("ALTER TABLE nodes ADD COLUMN nickname TEXT;");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609141000, new Date().toISOString());
      });
    }
    // Accounts move out of the environment and into the database (AND-33), so
    // that there can be more than one of them and each can be told which
    // products it may reach. The tables are in INITIAL_SCHEMA for a fresh
    // database; this brings an existing one up to the same shape.
    //
    // Only adds: two tables and a nullable column. scripts/rollback.sh rolls
    // back code and not schema, so the previous release has to keep running
    // against the new shape, and it does -- it reads neither.
    //
    // The environment administrator is not written here. Seeding needs the
    // configured id, email and password hash, which this class has no access
    // to, and a version row would record "done" for a database that never got
    // one. seedBootstrapAccount() does it from the server's config instead, on
    // every start, and is idempotent.
    //
    // The bare account_id columns on work_item_events, work_item_comments,
    // nodes and dispatches stay bare: making them foreign keys means proving
    // every historical value resolves, and the values that are there came from
    // the environment administrator, whose id the seed reuses. Worth doing,
    // worth doing on its own.
    const accountsMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609150500")
      .get() as unknown as { version: number } | undefined;
    if (!accountsMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(products)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "created_by_account_id")) {
          this.connection.exec("ALTER TABLE products ADD COLUMN created_by_account_id TEXT;");
        }
        this.connection.exec(INITIAL_SCHEMA);
        // Kept out of INITIAL_SCHEMA on purpose: that script runs before any
        // migration, when the column may not exist yet.
        this.connection.exec(
          "CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by_account_id);",
        );
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609150500, new Date().toISOString());
      });
    }
    // An AI authorization could not be listed or revoked on its own: the token
    // was signed, stateless, and recorded nowhere, so the only way to cut one
    // off was to change the account's password and cut off all of them.
    // docs/security-boundaries.md has listed this as owed since before accounts
    // were plural.
    //
    // Only adds a table, so the previous release keeps running against it --
    // scripts/rollback.sh reverts code and not schema.
    const aiAuthorizationsMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609151500")
      .get() as unknown as { version: number } | undefined;
    if (!aiAuthorizationsMigration) {
      this.transaction(() => {
        this.connection.exec(INITIAL_SCHEMA);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609151500, new Date().toISOString());
      });
    }
    // An item can be split off from another (AND-50): an AI working on one item
    // records a follow-up the user approved in the session, and both items show
    // the relation. A nullable column rather than a link table, because an item
    // comes from at most one other.
    //
    // Only adds a column and an index, so the previous release keeps running
    // against it -- scripts/rollback.sh reverts code and not schema.
    const derivedFromMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609151610")
      .get() as unknown as { version: number } | undefined;
    if (!derivedFromMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(work_items)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "derived_from_item_id")) {
          this.connection.exec(
            "ALTER TABLE work_items ADD COLUMN derived_from_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;",
          );
        }
        this.connection.exec(
          "CREATE INDEX IF NOT EXISTS idx_work_items_derived_from ON work_items(derived_from_item_id);",
        );
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609151610, new Date().toISOString());
      });
    }
    // Accounts were only ever an email address, so every comment a person wrote
    // was signed "human" and nothing else. A nickname gives them a name on the
    // timeline; empty means "use the part of the address before the @", decided
    // when the name is rendered rather than backfilled here, so that correcting
    // an address does not leave a stale name behind.
    //
    // Only adds a nullable column, so the previous release keeps running against
    // it -- scripts/rollback.sh reverts code and not schema.
    const accountNicknameMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609160637")
      .get() as unknown as { version: number } | undefined;
    if (!accountNicknameMigration) {
      this.transaction(() => {
        const columns = this.connection
          .prepare("PRAGMA table_info(accounts)")
          .all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "nickname")) {
          this.connection.exec("ALTER TABLE accounts ADD COLUMN nickname TEXT;");
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609160637, new Date().toISOString());
      });
    }
    const aiProviderMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609180239")
      .get() as unknown as { version: number } | undefined;
    if (!aiProviderMigration) {
      this.transaction(() => {
        this.connection.exec(INITIAL_SCHEMA);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609180239, new Date().toISOString());
      });
    }
    // A launched Codex thread can now be followed and answered from the web
    // console. These tables are additive so the previous release continues to
    // run if application code is rolled back while the database stays current.
    const agentSessionMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609201034")
      .get() as unknown as { version: number } | undefined;
    if (!agentSessionMigration) {
      this.transaction(() => {
        this.connection.exec(INITIAL_SCHEMA);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609201034, new Date().toISOString());
      });
    }
    // Commands originally carried reply text only. A stop request is a distinct
    // operation and pins the exact active turn it is allowed to interrupt.
    // Both columns are additive so the previous release continues to read and
    // write ordinary replies if application code is rolled back.
    const agentSessionCommandKindMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609201550")
      .get() as unknown as { version: number } | undefined;
    const commandKindColumns = this.connection
      .prepare("PRAGMA table_info(agent_session_commands)")
      .all() as unknown as Array<{ name: string }>;
    if (!agentSessionCommandKindMigration
      || !commandKindColumns.some((column) => column.name === "kind")
      || !commandKindColumns.some((column) => column.name === "turn_id")) {
      this.transaction(() => {
        if (!commandKindColumns.some((column) => column.name === "kind")) {
          this.connection.exec(
            "ALTER TABLE agent_session_commands ADD COLUMN kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'interrupt'));",
          );
        }
        if (!commandKindColumns.some((column) => column.name === "turn_id")) {
          this.connection.exec("ALTER TABLE agent_session_commands ADD COLUMN turn_id TEXT;");
        }
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609201550, new Date().toISOString());
      });
    }
    // A reply waiting on an unavailable Mac can now be cancelled and edited.
    // The status CHECK lives in the table definition, so an existing database
    // has to rebuild the table to widen it. Fresh databases already have the
    // new column and only need the migration marker.
    const cancellableReplyMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609202336")
      .get() as unknown as { version: number } | undefined;
    if (!cancellableReplyMigration) {
      const commandColumns = this.connection
        .prepare("PRAGMA table_info(agent_session_commands)")
        .all() as unknown as Array<{ name: string }>;
      if (!commandColumns.some((column) => column.name === "cancelled_at")) {
        this.connection.exec("PRAGMA foreign_keys = OFF;");
        try {
          this.transaction(() => {
            this.connection.exec(`
              CREATE TABLE agent_session_commands_new (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'interrupt')),
                text TEXT NOT NULL,
                turn_id TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'failed', 'cancelled')),
                error TEXT,
                created_at TEXT NOT NULL,
                delivered_at TEXT,
                cancelled_at TEXT
              ) STRICT;
              INSERT INTO agent_session_commands_new
                (id, session_id, account_id, kind, text, turn_id, status, error, created_at, delivered_at, cancelled_at)
              SELECT id, session_id, account_id, kind, text, turn_id, status, error, created_at, delivered_at, NULL
              FROM agent_session_commands;
              DROP TABLE agent_session_commands;
              ALTER TABLE agent_session_commands_new RENAME TO agent_session_commands;
              CREATE UNIQUE INDEX idx_agent_session_one_queued_command
                ON agent_session_commands(session_id) WHERE status IN ('queued', 'delivering');
            `);
            const violations = this.connection.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("Rebuilding agent session commands broke a foreign key.");
          });
        } finally {
          this.connection.exec("PRAGMA foreign_keys = ON;");
        }
      }
      // If a process dies after the rebuild and before this insert, the next
      // start observes cancelled_at and records the migration without rebuilding.
      this.connection
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(202609202336, new Date().toISOString());
    }
    // Claude Code can now use the same mirrored conversation channel as Codex.
    // The agent kind is guarded by a table CHECK, so existing databases need a
    // table rebuild; fresh databases already have the widened definition.
    const claudeAgentSessionMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210206")
      .get() as unknown as { version: number } | undefined;
    if (!claudeAgentSessionMigration) {
      const table = this.connection
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
        .get() as unknown as { sql: string };
      if (!table.sql.includes("'claude_code'")) {
        this.connection.exec("PRAGMA foreign_keys = OFF;");
        try {
          this.transaction(() => {
            this.connection.exec(`
              CREATE TABLE agent_sessions_new (
                id TEXT PRIMARY KEY,
                dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'claude_code')),
                agent_session_ref TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'unavailable', 'failed')),
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              ) STRICT;
              INSERT INTO agent_sessions_new
                (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, last_error, created_at, updated_at)
              SELECT id, dispatch_id, node_id, agent_kind, agent_session_ref, status, last_error, created_at, updated_at
              FROM agent_sessions;
              DROP TABLE agent_sessions;
              ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
            `);
            const violations = this.connection.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("Rebuilding agent sessions broke a foreign key.");
          });
        } finally {
          this.connection.exec("PRAGMA foreign_keys = ON;");
        }
      }
      this.connection
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(202609210206, new Date().toISOString());
    }
    // MissionGo's archive is deliberately local: it hides a mirrored session
    // without mutating the Codex or Claude conversation that may still be used
    // from another device. Restoring resumes snapshots from the same ref.
    const agentSessionArchiveMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210421")
      .get() as unknown as { version: number } | undefined;
    const agentSessionColumns = this.connection
      .prepare("PRAGMA table_info(agent_sessions)")
      .all() as unknown as Array<{ name: string }>;
    if (!agentSessionArchiveMigration
      || !agentSessionColumns.some((column) => column.name === "archived_at")
      || !agentSessionColumns.some((column) => column.name === "archive_source")) {
      this.transaction(() => {
        if (!agentSessionColumns.some((column) => column.name === "archived_at")) {
          this.connection.exec("ALTER TABLE agent_sessions ADD COLUMN archived_at TEXT;");
        }
        if (!agentSessionColumns.some((column) => column.name === "archive_source")) {
          this.connection.exec(
            "ALTER TABLE agent_sessions ADD COLUMN archive_source TEXT CHECK (archive_source IN ('missiongo', 'source'));",
          );
        }
        this.connection.exec(
          "CREATE INDEX IF NOT EXISTS idx_agent_sessions_archived ON agent_sessions(archived_at, updated_at DESC);",
        );
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210421, new Date().toISOString());
      });
    }
    // Agent-session mirroring was introduced after dispatches already existed
    // in production. Recover the historical Codex thread refs so the node can
    // observe whether those source conversations have since been archived.
    const legacyCodexSessionMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210545")
      .get() as unknown as { version: number } | undefined;
    if (!legacyCodexSessionMigration) {
      const dispatches = this.connection
        .prepare(
          `SELECT d.id, d.node_id, d.session_url, d.created_at, d.completed_at
           FROM dispatches d
           LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
           WHERE d.status = 'launched' AND d.agent_kind = 'codex'
             AND d.session_url IS NOT NULL AND s.id IS NULL`,
        )
        .all() as unknown as Array<{
          id: string;
          node_id: string;
          session_url: string;
          created_at: string;
          completed_at: string | null;
        }>;
      this.transaction(() => {
        const insert = this.connection.prepare(
          `INSERT INTO agent_sessions
             (id, dispatch_id, node_id, agent_kind, agent_session_ref, status,
              last_error, created_at, updated_at, archived_at, archive_source)
           VALUES (?, ?, ?, 'codex', ?, 'unavailable', NULL, ?, ?, NULL, NULL)`,
        );
        for (const dispatch of dispatches) {
          if (!LEGACY_CODEX_THREAD_LINK.test(dispatch.session_url)) continue;
          const threadId = dispatch.session_url.slice("codex://threads/".length);
          insert.run(
            randomUUID(),
            dispatch.id,
            dispatch.node_id,
            threadId,
            dispatch.created_at,
            dispatch.completed_at ?? dispatch.created_at,
          );
        }
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210545, new Date().toISOString());
      });
    }
    // Keep Claude's background work separate from the conversation transcript.
    // The host reports only safe task labels, never raw tool output or command
    // lines, and the JSON column makes the latest task snapshot replaceable.
    const agentSessionActivitiesMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210557")
      .get() as unknown as { version: number } | undefined;
    const activityColumns = this.connection
      .prepare("PRAGMA table_info(agent_sessions)")
      .all() as unknown as Array<{ name: string }>;
    if (!agentSessionActivitiesMigration
      || !activityColumns.some((column) => column.name === "activities_json")) {
      this.transaction(() => {
        if (!activityColumns.some((column) => column.name === "activities_json")) {
          this.connection.exec("ALTER TABLE agent_sessions ADD COLUMN activities_json TEXT NOT NULL DEFAULT '[]';");
        }
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210557, new Date().toISOString());
      });
    }
    // Session updated_at is the node mirror checkpoint and moves on every
    // snapshot. Keep a separate activity clock for user-visible ordering so an
    // unchanged background poll cannot make an old conversation look new.
    const agentSessionActivityMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210627")
      .get() as unknown as { version: number } | undefined;
    const orderingColumns = this.connection
      .prepare("PRAGMA table_info(agent_sessions)")
      .all() as unknown as Array<{ name: string }>;
    if (!agentSessionActivityMigration
      || !orderingColumns.some((column) => column.name === "activity_at")) {
      this.transaction(() => {
        if (!orderingColumns.some((column) => column.name === "activity_at")) {
          this.connection.exec("ALTER TABLE agent_sessions ADD COLUMN activity_at TEXT NOT NULL DEFAULT '';");
        }
        // Message observed_at was historically refreshed by every snapshot, so
        // it cannot recover real activity. Creation, archive and command times
        // are trustworthy and deliberately produce a conservative backfill.
        this.connection.exec(`
          UPDATE agent_sessions AS session
          SET activity_at = MAX(
            session.created_at,
            COALESCE(session.archived_at, session.created_at),
            COALESCE((
              SELECT MAX(COALESCE(command.cancelled_at, command.delivered_at, command.created_at))
              FROM agent_session_commands command
              WHERE command.session_id = session.id
            ), session.created_at)
          )
          WHERE session.activity_at = '';
          CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity
            ON agent_sessions(activity_at DESC);
        `);
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210627, new Date().toISOString());
      });
    }
    // DeepSeek may classify only the latest Agent reply after an administrator
    // explicitly enables that automatic third-party transmission. The cached
    // row is keyed by the source-message hash so a late answer cannot replace
    // the classification for a newer turn. Both changes are additive: an older
    // release ignores the flag and the cache table during rollback.
    const agentAttentionMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210802")
      .get() as unknown as { version: number } | undefined;
    const providerColumns = this.connection
      .prepare("PRAGMA table_info(ai_provider_settings)")
      .all() as unknown as Array<{ name: string }>;
    if (!agentAttentionMigration
      || !providerColumns.some((column) => column.name === "agent_attention_enabled")) {
      this.transaction(() => {
        if (!providerColumns.some((column) => column.name === "agent_attention_enabled")) {
          this.connection.exec(
            "ALTER TABLE ai_provider_settings ADD COLUMN agent_attention_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_attention_enabled IN (0, 1));",
          );
        }
        this.connection.exec(INITIAL_SCHEMA);
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210802, new Date().toISOString());
      });
    }
    // A historical hand-off can predate conversation mirroring and therefore
    // have no agent_sessions row. Keep a local archive marker on the dispatch
    // so those finished, dispatch-only entries can leave the main console too.
    const dispatchArchiveMigration = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 202609210926")
      .get() as unknown as { version: number } | undefined;
    const dispatchColumns = this.connection
      .prepare("PRAGMA table_info(dispatches)")
      .all() as unknown as Array<{ name: string }>;
    if (!dispatchArchiveMigration
      || !dispatchColumns.some((column) => column.name === "archived_at")) {
      this.transaction(() => {
        if (!dispatchColumns.some((column) => column.name === "archived_at")) {
          this.connection.exec("ALTER TABLE dispatches ADD COLUMN archived_at TEXT;");
        }
        this.connection.exec(
          "CREATE INDEX IF NOT EXISTS idx_dispatches_archived ON dispatches(archived_at, completed_at DESC);",
        );
        this.connection
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(202609210926, new Date().toISOString());
      });
    }
    this.connection.exec("PRAGMA optimize;");
  }
}
