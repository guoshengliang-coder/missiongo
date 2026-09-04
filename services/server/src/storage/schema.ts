export const INITIAL_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    key_prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    next_item_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_item_sequence > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('android', 'macos', 'web', 'server', 'shared', 'other')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (product_id, name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    item_key TEXT NOT NULL UNIQUE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    source_component_id TEXT REFERENCES components(id) ON DELETE SET NULL,
    area_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('idea', 'requirement', 'bug', 'task', 'note')),
    priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
    status TEXT NOT NULL CHECK (status IN ('inbox', 'ready', 'in_progress', 'on_hold', 'pending_verification', 'done', 'cancelled')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    environment_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (product_id, sequence)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS work_item_affected_components (
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    component_id TEXT NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
    PRIMARY KEY (item_id, component_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS work_item_attachments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log')),
    original_filename TEXT NOT NULL,
    storage_filename TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS work_item_events (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
    from_status TEXT,
    to_status TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ai_executions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('process', 'continue', 'verify')),
    trigger_source TEXT NOT NULL CHECK (trigger_source IN ('agent_pull', 'web_dispatch', 'android_dispatch', 'scheduler')),
    status TEXT NOT NULL CHECK (status IN ('created', 'running', 'waiting_for_human', 'succeeded', 'failed', 'aborted', 'lease_expired')),
    report_json TEXT,
    human_question TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS execution_leases (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES ai_executions(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_components_product ON components(product_id);
  CREATE INDEX IF NOT EXISTS idx_work_items_product_sequence ON work_items(product_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_work_items_product_status ON work_items(product_id, status);
  CREATE INDEX IF NOT EXISTS idx_work_item_attachments_item_created ON work_item_attachments(item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_work_item_events_item_created ON work_item_events(item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_executions_item_created ON ai_executions(item_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_leases_active_item
    ON execution_leases(item_id) WHERE released_at IS NULL;
`;
