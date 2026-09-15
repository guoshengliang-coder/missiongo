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
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    icon_png TEXT,
    -- Who may archive it. Deliberately not a foreign key: deleting an account
    -- must not take its products with it, and ON DELETE SET NULL would silently
    -- hand every one of them to nobody.
    created_by_account_id TEXT
  ) STRICT;

  -- Accounts sign in by email. The password format is the same scrypt string the
  -- environment variable used to carry, so an existing deployment's hash moves
  -- into the table unchanged.
  --
  -- credentials_changed_at is what makes "change the password and the other
  -- browser is signed out" work without a sessions table. Sessions and AI tokens
  -- are signed and stateless, and each carries the value this column held when it
  -- was minted; a token whose copy no longer matches is refused. Moving this
  -- column therefore invalidates every credential the account holds -- which is
  -- also the cost: a single session cannot be revoked on its own.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_scrypt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    credentials_changed_at TEXT NOT NULL,
    disabled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Three independent switches rather than one level: an account can be allowed
  -- to read a product in the console without its AI clients getting the same
  -- reach, which a ranked scale could not express.
  CREATE TABLE IF NOT EXISTS account_products (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    can_view INTEGER NOT NULL DEFAULT 0 CHECK (can_view IN (0, 1)),
    can_operate INTEGER NOT NULL DEFAULT 0 CHECK (can_operate IN (0, 1)),
    can_use_ai INTEGER NOT NULL DEFAULT 0 CHECK (can_use_ai IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, product_id)
  ) STRICT;

  -- One record per AI authorization handed out through OAuth, so a person can
  -- see what is connected to their account and cut off one client without
  -- touching the rest.
  --
  -- The token itself stays signed and stateless; this is not a copy of it and
  -- holds no secret. Verification still rests on the signature, and consults
  -- this table for one question only: has this authorization been revoked. A
  -- token with no row here is therefore still valid -- which is deliberate, so
  -- that shipping this does not invalidate every authorization already in the
  -- wild. Those stay revocable the way they always were, by changing the
  -- account's password, and age out within the token lifetime.
  CREATE TABLE IF NOT EXISTS ai_authorizations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The signed client id, which carries the client's registered name; the
    -- console decodes it for display rather than storing a name that could
    -- disagree with the one the token was issued to.
    client_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('android', 'macos', 'web', 'server', 'shared', 'other')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
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
    report_json TEXT,
    environment_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    derived_from_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
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
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log', 'document')),
    display_number INTEGER NOT NULL CHECK (display_number > 0),
    original_filename TEXT NOT NULL,
    storage_filename TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS work_item_attachment_counters (
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'log', 'document')),
    next_number INTEGER NOT NULL CHECK (next_number > 0),
    PRIMARY KEY (item_id, kind)
  ) STRICT;

  -- account_id / client_id / execution_id say who wrote an event, not just
  -- whether a person or a machine did. Human events carry an account as well
  -- since accounts became plural: actor_kind = 'human' named somebody only while
  -- there was one of them. Still null on events written before migration 13, and
  -- on ones written through the deployment's operator token, which has no
  -- account behind it.
  CREATE TABLE IF NOT EXISTS work_item_events (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
    from_status TEXT,
    to_status TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    account_id TEXT,
    client_id TEXT,
    execution_id TEXT,
    timeline_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  ) STRICT;

  -- Comments are people and agents talking on an item, so unlike an event they
  -- have state: one can be withdrawn. Events stay append-only and never update,
  -- which is what makes them worth reading as an audit trail.
  --
  -- A withdrawn comment is kept and hidden rather than deleted. An AI reads an
  -- item back before it acts, so a wrong analysis that cannot be taken down gets
  -- quoted as evidence on every later read.
  CREATE TABLE IF NOT EXISTS work_item_comments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
    account_id TEXT,
    client_id TEXT,
    execution_id TEXT,
    body_kind TEXT NOT NULL CHECK (body_kind IN ('structured', 'free')),
    body_json TEXT NOT NULL,
    -- Who the agent says it is (which machine's Claude Code, which Codex) and
    -- its own one-line summary of what follows. Columns rather than keys inside
    -- body_json because both apply to free-text comments too, and a free body
    -- is just { text }.
    agent_name TEXT,
    summary TEXT,
    timeline_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    withdrawn_at TEXT,
    withdrawn_by TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_work_item_comments_item
  ON work_item_comments(item_id, timeline_seq);

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

  -- A node is one developer machine that pulls dispatches and starts agent
  -- sessions. Its credential lives here rather than in access_tokens because
  -- that table binds a token to a single product and to platform 'android',
  -- while a machine serves every product it has a checkout for.
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    -- Chosen by the macOS client the first time it runs, so logging in again on
    -- the same Mac finds the same node. Its unique index lives in the migration
    -- that adds it: this schema runs before migrations, when an existing database
    -- does not have the column yet.
    installation_id TEXT,
    -- The Mac's own name, as the client reports it on every sign-in.
    name TEXT NOT NULL,
    -- What a person chose to call it, from the console or the client. Null means
    -- the device name is used; it prefixes every session name the Mac starts.
    nickname TEXT,
    hostname TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    agents_json TEXT NOT NULL DEFAULT '[]',
    -- Checkouts the machine reported it can already work in, so the console can
    -- offer a list instead of asking someone to type an absolute path.
    repo_candidates_json TEXT NOT NULL DEFAULT '[]',
    last_seen_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Which checkout on that machine a product's items are worked in. A product
  -- deliberately is not a git repo, so the mapping cannot be derived and has to
  -- be stated per machine.
  CREATE TABLE IF NOT EXISTS node_product_repos (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    repo_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- One dispatch is one session. The batch shares a session, so the items hang
  -- off the dispatch rather than the dispatch off an item.
  CREATE TABLE IF NOT EXISTS dispatches (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    agent_kind TEXT NOT NULL CHECK (agent_kind IN ('claude_code', 'codex', 'hermes')),
    mode TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'launched', 'failed', 'cancelled')),
    repo_path TEXT NOT NULL,
    session_name TEXT,
    session_url TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    completed_at TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS dispatch_items (
    dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (dispatch_id, item_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS access_tokens (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sdk', 'mcp', 'node')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('android')),
    source_component_id TEXT REFERENCES components(id) ON DELETE SET NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS feedback_drafts (
    id TEXT PRIMARY KEY,
    access_token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE RESTRICT,
    client_draft_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    source_component_id TEXT REFERENCES components(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('editing', 'submitted', 'expired')),
    type TEXT NOT NULL CHECK (type IN ('idea', 'requirement', 'bug', 'task', 'note')),
    priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    environment_json TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    logs_json TEXT NOT NULL DEFAULT '[]',
    submitted_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (access_token_id, client_draft_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS feedback_web_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    access_token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
    draft_id TEXT NOT NULL REFERENCES feedback_drafts(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sdk_rate_limits (
    access_token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
    bucket TEXT NOT NULL,
    window_started_at_ms INTEGER NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (access_token_id, bucket)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS feedback_attachment_uploads (
    draft_id TEXT NOT NULL REFERENCES feedback_drafts(id) ON DELETE CASCADE,
    client_attachment_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL UNIQUE REFERENCES work_item_attachments(id) ON DELETE CASCADE,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY (draft_id, client_attachment_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_components_product ON components(product_id);
  -- The primary key already serves "which products can this account reach".
  -- This one serves the reverse, "which accounts can reach this product".
  CREATE INDEX IF NOT EXISTS idx_account_products_product ON account_products(product_id);
  CREATE INDEX IF NOT EXISTS idx_ai_authorizations_account
    ON ai_authorizations(account_id, issued_at DESC);
  -- idx_work_items_derived_from is not here either, for the same reason: the
  -- column arrives with its migration on a database older than AND-50.
  -- idx_products_created_by is not here. This whole script runs before the
  -- migrations, and on a database created before AND-33 the products table has
  -- no created_by_account_id yet, so indexing it here fails the start. The
  -- migration adds the column and the index together.
  CREATE INDEX IF NOT EXISTS idx_work_items_product_sequence ON work_items(product_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_work_items_product_status ON work_items(product_id, status);
  CREATE INDEX IF NOT EXISTS idx_work_item_attachments_item_created ON work_item_attachments(item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_work_item_events_item_created ON work_item_events(item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_executions_item_created ON ai_executions(item_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_leases_active_item
    ON execution_leases(item_id) WHERE released_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_access_tokens_product ON access_tokens(product_id, kind);
  CREATE INDEX IF NOT EXISTS idx_nodes_account ON nodes(account_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_node_product_repos_unique ON node_product_repos(node_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_dispatches_account_created ON dispatches(account_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dispatches_node_queued ON dispatches(node_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_dispatch_items_item ON dispatch_items(item_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_drafts_expiry ON feedback_drafts(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_web_sessions_expiry ON feedback_web_sessions(expires_at);
`;
