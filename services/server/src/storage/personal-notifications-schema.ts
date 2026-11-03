/** Only new business events create messages; no historical notification backfill. */
export const PERSONAL_NOTIFICATIONS_SCHEMA = `
  CREATE TABLE notification_events (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    business_event_id TEXT UNIQUE REFERENCES work_item_events(id) ON DELETE CASCADE,
    comment_id TEXT UNIQUE REFERENCES work_item_comments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    CHECK ((business_event_id IS NULL) != (comment_id IS NULL))
  ) STRICT;
  CREATE TABLE personal_notifications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('mention','reply','verification','decision')),
    read_at TEXT,
    UNIQUE(event_id,account_id)
  ) STRICT;
  CREATE INDEX personal_notifications_account ON personal_notifications(account_id,sequence DESC);
  CREATE INDEX personal_notifications_unread ON personal_notifications(account_id,sequence) WHERE read_at IS NULL;
  ALTER TABLE dingtalk_notifications ADD COLUMN personal_notification_id TEXT REFERENCES personal_notifications(id) ON DELETE SET NULL;
  ALTER TABLE dingtalk_projects ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 1 CHECK(comments_enabled IN (0,1));
`;
