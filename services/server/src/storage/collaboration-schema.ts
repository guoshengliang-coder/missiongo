export const COLLABORATION_SCHEMA = `
CREATE TABLE collaboration_grants (
 id TEXT PRIMARY KEY, source_product_id TEXT NOT NULL REFERENCES products(id),
 target_product_id TEXT NOT NULL REFERENCES products(id), module_id TEXT NOT NULL DEFAULT '',
 builder_account_id TEXT REFERENCES accounts(id), enabled INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL REFERENCES accounts(id), updated_at TEXT NOT NULL,
 UNIQUE(source_product_id,target_product_id,module_id), CHECK(source_product_id != target_product_id)
) STRICT;
CREATE TABLE collaboration_drafts (
 id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL REFERENCES work_items(id),
 grant_id TEXT NOT NULL REFERENCES collaboration_grants(id), payload_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES accounts(id),
 actor_kind TEXT NOT NULL, agent_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 invalidated_at TEXT, submitted_request_id TEXT
) STRICT;
CREATE TABLE collaboration_requests (
 id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL REFERENCES work_items(id),
 target_item_id TEXT NOT NULL REFERENCES work_items(id), grant_id TEXT NOT NULL REFERENCES collaboration_grants(id),
 draft_id TEXT UNIQUE REFERENCES collaboration_drafts(id), approved_version INTEGER NOT NULL,
 payload_json TEXT NOT NULL, approved_by TEXT NOT NULL REFERENCES accounts(id),
 verifier_account_id TEXT NOT NULL REFERENCES accounts(id), owner_account_id TEXT REFERENCES accounts(id),
 created_at TEXT NOT NULL, withdrawn_at TEXT, withdrawal_reason TEXT, access_revoked_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1, CHECK(source_item_id != target_item_id)
) STRICT;
CREATE UNIQUE INDEX collaboration_active_edge ON collaboration_requests(source_item_id,target_item_id) WHERE withdrawn_at IS NULL;
CREATE TRIGGER collaboration_insert_revision AFTER INSERT ON collaboration_requests BEGIN
 UPDATE work_items SET revision=revision+1 WHERE id IN (NEW.source_item_id,NEW.target_item_id);
END;
CREATE TRIGGER collaboration_update_revision AFTER UPDATE ON collaboration_requests BEGIN
 UPDATE work_items SET revision=revision+1 WHERE id IN (OLD.source_item_id,OLD.target_item_id,NEW.source_item_id,NEW.target_item_id);
END;
CREATE INDEX collaboration_target ON collaboration_requests(target_item_id);
CREATE INDEX collaboration_draft_source ON collaboration_drafts(source_item_id);
CREATE TABLE collaboration_events (
 id TEXT PRIMARY KEY, request_id TEXT REFERENCES collaboration_requests(id), draft_id TEXT REFERENCES collaboration_drafts(id),
 kind TEXT NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX collaboration_event_request ON collaboration_events(request_id);
CREATE INDEX collaboration_event_draft ON collaboration_events(draft_id);
CREATE TABLE collaboration_receipts (
 account_id TEXT NOT NULL, command_key TEXT NOT NULL, digest TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(account_id,command_key)
) STRICT;
`;
