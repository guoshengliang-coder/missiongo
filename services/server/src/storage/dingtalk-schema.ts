export const DINGTALK_SCHEMA = `
  CREATE TABLE dingtalk_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), corp_id TEXT NOT NULL, client_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, encrypted_secret TEXT NOT NULL, revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE dingtalk_bindings (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    corp_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL,
    revision TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(corp_id,user_id)
  ) STRICT;
  CREATE TABLE dingtalk_projects (
    product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE dingtalk_notifications (
    id TEXT PRIMARY KEY, event_id TEXT UNIQUE REFERENCES work_item_events(id) ON DELETE CASCADE,
    item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE, account_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN('verification','test')),
    status TEXT NOT NULL CHECK(status IN('queued','sending','accepted','sent','failed','skipped','uncertain')),
    reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    task_id TEXT, recipient TEXT, config_revision INTEGER, binding_revision TEXT,
    next_at TEXT NOT NULL, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX dingtalk_notifications_pending ON dingtalk_notifications(status,next_at);
  CREATE INDEX dingtalk_notifications_item ON dingtalk_notifications(item_id,created_at);
  CREATE TABLE dingtalk_audit (
    id TEXT PRIMARY KEY, actor_account_id TEXT NOT NULL, action TEXT NOT NULL,
    subject TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at TEXT NOT NULL
  ) STRICT;
`;
