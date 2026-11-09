/** Derived display data. Source tables remain authoritative for every action. */
interface TriggerOptions {
  when?: string;
  updates?: string;
  item?: boolean;
  filter?: string;
  merge?: boolean;
  mergeWhen?: string;
  mergeFilter?: string;
}
// $.column denotes a source row; quoted '$.json.path' stays a JSON path.
const source = (sql:string,ref:string) => sql.replace(/(?<!['"])\$\./g,ref+".");
const trigger = (table:string,kind:string,id:string,options:TriggerOptions={}) =>
  (["INSERT","UPDATE","DELETE"] as const).map(operation=>{
    const ref=operation==="DELETE"?"OLD":"NEW",value=source(id,ref);
    const predicate=(filter:string|undefined)=>!filter?undefined:operation==="UPDATE"
      ? `(${source(filter,"OLD")}) OR (${source(filter,"NEW")})` : source(filter,ref);
    const checks=[operation==="UPDATE"?options.when:undefined,predicate(options.filter)].filter(Boolean);
    const condition=checks.length?` WHEN ${checks.map(check=>`(${check})`).join(" AND ")}`:"";
    const mergeChecks=[operation==="UPDATE"?options.mergeWhen:undefined,predicate(options.mergeFilter)].filter(Boolean);
    const mergeCondition=mergeChecks.map(check=>`(${check})`).join(" AND ")||"1";
    // Explicit UPSERT is intentional: a source statement's ON CONFLICT policy
    // can override INSERT OR IGNORE in a trigger and turn deduplication into an error.
    return `CREATE TRIGGER display_${table}_${operation.toLowerCase()} AFTER ${operation}${operation==="UPDATE"&&options.updates?` OF ${options.updates}`:""} ON ${table}${condition} BEGIN
      ${options.merge===false?"":`INSERT INTO merge_display_dirty(kind,id) SELECT '${kind}',${value} WHERE ${mergeCondition} ON CONFLICT DO NOTHING;`}
      ${["account","product","item","token"].includes(kind)?`INSERT INTO item_list_changes VALUES ('${kind}',${value}) ON CONFLICT DO NOTHING;`:""}
      ${options.item?`INSERT INTO item_list_dirty VALUES (${value}) ON CONFLICT DO NOTHING;`:""}
    END;`;
  }).join("\n");

export const DISPLAY_PROJECTION_SCHEMA = `
CREATE TABLE merge_display_dirty(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
CREATE TABLE item_list_changes(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
CREATE TABLE item_list_dirty(item_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE item_list_projection(item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), list_json TEXT NOT NULL CHECK(json_valid(list_json)), status_order INTEGER NOT NULL, version INTEGER NOT NULL) STRICT;
CREATE TABLE merge_display_dependencies(delivery_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
  PRIMARY KEY(delivery_id,kind,id)) WITHOUT ROWID;
CREATE INDEX merge_display_dependency_lookup ON merge_display_dependencies(kind,id,delivery_id);
CREATE TABLE merge_delivery_projection(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,batch_id TEXT,sequence INTEGER NOT NULL,visible INTEGER NOT NULL,attention INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),fresh_from INTEGER,fresh_until INTEGER,fresh_blocker TEXT) STRICT;
CREATE INDEX merge_delivery_projection_scope ON merge_delivery_projection(product_id,account_id,sequence DESC);
CREATE INDEX merge_delivery_projection_session ON merge_delivery_projection(session_id,sequence DESC);
CREATE TABLE merge_batch_projection(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,sequence INTEGER NOT NULL,data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
CREATE INDEX merge_batch_projection_scope ON merge_batch_projection(product_id,account_id,sequence DESC);
CREATE TABLE merge_session_projection(product_id TEXT NOT NULL,account_id TEXT NOT NULL,session_id TEXT NOT NULL,
  stage TEXT NOT NULL,expires_at INTEGER,expired_stage TEXT,PRIMARY KEY(product_id,account_id,session_id)) WITHOUT ROWID;
CREATE INDEX merge_delivery_source_session ON merge_deliveries(product_id,account_id,json_extract(data_json,'$.sessionId'));
CREATE INDEX merge_delivery_source_batch ON merge_deliveries(json_extract(data_json,'$.batchId'));
CREATE INDEX merge_batch_source_session ON merge_batches(json_extract(data_json,'$.sessionId'),product_id,account_id);
${trigger("merge_deliveries", "delivery", "$.id")}
${trigger("merge_batches", "batch", "$.id")}
${trigger("work_items", "item", "$.id", {item:true,mergeWhen:"OLD.content_version IS NOT NEW.content_version OR OLD.builder_account_id IS NOT NEW.builder_account_id OR OLD.status IS NOT NEW.status OR OLD.product_id IS NOT NEW.product_id OR OLD.title IS NOT NEW.title OR OLD.execution_disposition IS NOT NEW.execution_disposition"})}
${trigger("work_item_events", "item", "$.item_id", {item:true,mergeFilter:"$.event_type IN ('status_changed','item_updated','builder_changed','execution_taken_over','delivery_recorded','delivery_evidence_added','release_evidence_added')"})}
${trigger("work_item_comments", "item", "$.item_id", {item:true,merge:false})}
${trigger("work_item_attachments", "item", "$.item_id", {item:true,merge:false})}
${trigger("work_item_affected_components", "item", "$.item_id", {item:true,merge:false})}
${trigger("item_executions", "item", "$.item_id", {item:true})}
${trigger("builder_handovers", "item", "$.item_id", {item:true})}
${trigger("builder_execution_authorizations", "item", "$.item_id")}
${trigger("mcp_agent_claim_receipts", "item", "json_extract($.result_json,'$.item.id')")}
${trigger("builder_revoked_dispatches", "dispatch", "$.dispatch_id")}
${trigger("builder_revoked_external_sessions", "session", "$.session_id")}
${trigger("dispatches", "dispatch", "$.id", {updates:"status,archived_at,node_id,account_id",when:"OLD.status IS NOT NEW.status OR OLD.archived_at IS NOT NEW.archived_at OR OLD.node_id IS NOT NEW.node_id OR OLD.account_id IS NOT NEW.account_id"})}
${trigger("agent_sessions", "session", "$.id", {updates:"settings_revision,agent_session_ref,archived_at,dispatch_id",when:"OLD.settings_revision IS NOT NEW.settings_revision OR OLD.agent_session_ref IS NOT NEW.agent_session_ref OR OLD.archived_at IS NOT NEW.archived_at OR OLD.dispatch_id IS NOT NEW.dispatch_id"})}
${trigger("external_agent_sessions", "session", "$.id", {updates:"native_settings_json,session_ref,archived_at,product_id,native_node_id",when:"OLD.native_settings_json IS NOT NEW.native_settings_json OR OLD.session_ref IS NOT NEW.session_ref OR OLD.archived_at IS NOT NEW.archived_at OR OLD.product_id IS NOT NEW.product_id OR OLD.native_node_id IS NOT NEW.native_node_id"})}
${trigger("agent_session_messages", "session", "$.session_id", {when:"OLD.role IS NOT NEW.role OR OLD.text IS NOT NEW.text OR OLD.source_id IS NOT NEW.source_id OR OLD.occurred_at IS NOT NEW.occurred_at",filter:"$.role='user'"})}
${trigger("agent_session_commands", "session", "$.session_id", {updates:"kind,created_at",filter:"$.kind='message'"})}
${trigger("external_native_messages", "session", "$.session_id", {filter:"json_extract($.payload_json,'$.role')='user'"})}
${trigger("external_native_commands", "session", "$.session_id")}
${trigger("external_agent_session_items", "session", "$.session_id")}
${trigger("free_session_starts", "dispatch", "$.dispatch_id")}
${trigger("nodes", "node", "$.id", {updates:"revoked_at",when:"OLD.revoked_at IS NOT NEW.revoked_at"})}
${trigger("products", "product", "$.id", {updates:"archived_at",when:"OLD.archived_at IS NOT NEW.archived_at"})}
${trigger("accounts", "account", "$.id", {updates:"nickname,email,disabled_at,role,ai_scope",when:"OLD.nickname IS NOT NEW.nickname OR OLD.email IS NOT NEW.email OR OLD.disabled_at IS NOT NEW.disabled_at OR OLD.role IS NOT NEW.role OR OLD.ai_scope IS NOT NEW.ai_scope"})}
${trigger("account_products", "account", "$.account_id")}
${trigger("product_administrators", "account", "$.account_id")}
${trigger("access_tokens", "token", "$.id")}
${trigger("collaboration_requests", "item", "$.source_item_id", {item:true})}
${trigger("item_transfers", "item", "$.source_item_id", {item:true})}
INSERT INTO item_list_dirty SELECT id FROM work_items;
INSERT INTO merge_display_dirty SELECT 'delivery',id FROM merge_deliveries;
INSERT INTO merge_display_dirty SELECT 'batch',id FROM merge_batches;
`;

/** Additive repair: existing v1 databases retain their source events and receipts. */
export const DISPLAY_ACTIVITY_SCHEMA = `
ALTER TABLE merge_delivery_projection ADD COLUMN expected_activity TEXT NOT NULL DEFAULT '';
ALTER TABLE merge_batch_projection ADD COLUMN activity_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX merge_delivery_projection_visible ON merge_delivery_projection(product_id,account_id,sequence DESC) WHERE visible=1;
CREATE INDEX merge_delivery_projection_attention ON merge_delivery_projection(product_id,account_id,session_id,sequence DESC) WHERE attention=1;
CREATE INDEX merge_delivery_projection_active_session ON merge_delivery_projection(session_id) WHERE visible=1 OR attention=1;
CREATE INDEX merge_delivery_projection_unmerged_activity ON merge_delivery_projection(session_id,expected_activity)
  WHERE json_extract(data_json,'$.state')!='merged';
CREATE TABLE merge_display_activity(session_id TEXT PRIMARY KEY,activity TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE merge_display_activity_scopes(session_id TEXT NOT NULL,product_id TEXT NOT NULL,account_id TEXT NOT NULL,
  PRIMARY KEY(session_id,product_id,account_id)) WITHOUT ROWID;
${["agent_session_messages","agent_session_commands","external_native_messages","external_native_commands"].flatMap(table=>
  ["insert","update","delete"].map(operation=>`DROP TRIGGER display_${table}_${operation};`)).join("\n")}
${trigger("agent_session_messages", "activity", "$.session_id", {when:"OLD.role IS NOT NEW.role OR OLD.text IS NOT NEW.text OR OLD.source_id IS NOT NEW.source_id OR OLD.occurred_at IS NOT NEW.occurred_at",filter:"$.role='user'"})}
${trigger("agent_session_commands", "activity", "$.session_id", {updates:"kind,created_at",filter:"$.kind='message'"})}
${trigger("external_native_messages", "activity", "$.session_id", {filter:"json_extract($.payload_json,'$.role')='user'"})}
${trigger("external_native_commands", "activity", "$.session_id", {updates:"created_at,session_id"})}
INSERT INTO merge_display_dirty SELECT 'delivery',id FROM merge_deliveries WHERE 1 ON CONFLICT DO NOTHING;
INSERT INTO merge_display_dirty SELECT 'batch',id FROM merge_batches WHERE 1 ON CONFLICT DO NOTHING;
`;
