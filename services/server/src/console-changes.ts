import type { ConsoleChangeKind } from "@missiongo/contracts";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MissionGoDatabase } from "./storage/database.js";

export const CONSOLE_CHANGE_SCHEMA = `
CREATE TABLE console_changes (
 version INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
 account_id TEXT, product_id TEXT, item_key TEXT, resource_id TEXT
) STRICT;
CREATE TABLE console_change_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL);
`;
export interface ConsoleChange {
 version: number; kind: ConsoleChangeKind; account_id: string | null; product_id: string | null;
 item_key: string | null; resource_id: string | null;
}
interface Spec { kind: ConsoleChangeKind; account?: string; product?: string; item?: string; resource?: string; ignore?: string[]; adminAlso?: boolean }
const ignored = new Set(["updated_at", "observed_at", "last_used_at", "received_at", "native_synced_at", "next_at", "lease_until"]);
const item = (column = "item_id") => `(SELECT item_key FROM work_items WHERE id=$.${column})`;
const product = (column = "item_id") => `(SELECT product_id FROM work_items WHERE id=$.${column})`;
const dispatchOwner = (column = "dispatch_id") => `(SELECT account_id FROM dispatches WHERE id=$.${column})`;
const sessionOwner = `(SELECT d.account_id FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=$.session_id)`;
const externalOwner = `(SELECT account_id FROM external_agent_sessions WHERE id=$.session_id)`;
const specs: Record<string, Spec> = {
 products: { kind: "products", product: "$.id", ignore: ["next_item_sequence"] },
 components: { kind: "products", product: "$.product_id" },
 work_items: { kind: "item", product: "$.product_id", item: "$.item_key" },
 accounts: { kind: "access", account: "$.id", adminAlso: true },
 account_products: { kind: "access", account: "$.account_id", adminAlso: true },
 product_administrators: { kind: "access", account: "$.account_id", adminAlso: true },
 ai_authorizations: { kind: "config", account: "$.account_id" },
 access_tokens: { kind: "config", product: "$.product_id" },
 nodes: { kind: "nodes", account: "$.account_id", resource: "$.id", ignore: ["last_seen_at"] },
 node_product_repos: { kind: "nodes", account: `(SELECT account_id FROM nodes WHERE id=$.node_id)` },
 dispatches: { kind: "sessions", account: "$.account_id", ignore: ["read_at"] },
 dispatch_items: { kind: "sessions", account: dispatchOwner() },
 agent_sessions: { kind: "sessions", account: dispatchOwner(), resource: "$.id", ignore: ["activity_repair_pending"] },
 external_agent_sessions: { kind: "sessions", account: "$.account_id", resource: "$.id", ignore: ["read_at"] },
 agent_session_preferences: { kind: "sessions", account: "$.account_id" },
 merge_deliveries: { kind: "merge", product: "$.product_id", account: "$.account_id" },
 merge_batches: { kind: "merge", product: "$.product_id", account: "$.account_id" },
 personal_notifications: { kind: "personal", account: "$.account_id" },
 dingtalk_bindings: { kind: "config", account: "$.account_id", adminAlso: true },
 dingtalk_projects: { kind: "config", product: "$.product_id" },
 // Global configuration carries no object identifier and is visible only to administrators.
 dingtalk_settings: { kind: "admin" },
 ai_provider_settings: { kind: "admin" },
 agent_artifacts: { kind: "artifact", account: "$.account_id", resource: "$.session_id" },
 agent_history_pages: { kind: "history", account: "$.account_id", resource: "$.session_id" },
 agent_history_sources: { kind: "history", account: "$.account_id", resource: "$.session_id" },
};
for (const table of ["work_item_events", "work_item_comments", "work_item_attachments", "work_item_affected_components", "ai_executions", "item_executions", "builder_handovers", "status_handovers", "item_execution_stop_confirmations", "item_performer_stop_confirmations", "completion_discoveries", "dingtalk_notifications"])
 specs[table] = { kind: "item", product: product(), item: item() };
for (const table of ["agent_session_messages", "agent_session_commands", "agent_session_approvals", "agent_session_attention", "agent_session_attachments"])
 specs[table] = { kind: "sessions", account: sessionOwner, resource: "$.session_id" };
for (const table of ["external_native_messages", "external_native_commands", "external_agent_session_reports", "external_agent_session_items", "external_session_attachments"])
 specs[table] = { kind: "sessions", account: externalOwner, resource: "$.session_id" };
for (const table of ["account_dispatch_defaults", "account_integration_defaults"])
 specs[table] = { kind: "config", account: "$.account_id" };
for (const table of ["implementation_plan_approvals", "implementation_plan_requests", "implementation_plan_versions", "implementation_plan_continuations", "plan_documents"])
 specs[table] = { kind: "plan", account: "$.account_id" };
for (const table of ["collaboration_requests", "collaboration_drafts"])
 specs[table] = { kind: "item", product: product("source_item_id"), item: item("source_item_id") };
specs.collaboration_grants = { kind: "products", product: "$.source_product_id" };
specs.release_observations = { kind: "merge", product: "$.product_id" };
specs.session_unread_state = { kind: "sessions", account: "COALESCE((SELECT account_id FROM dispatches WHERE id=substr($.session_key,10)),(SELECT account_id FROM external_agent_sessions WHERE id=substr($.session_key,10)))" };
specs.insight_batches = { kind: "config", account: "$.account_id" };

/** Durable invalidations, not business payloads. SQLite triggers cover HTTP, MCP,
 * SDK and background writes equally. The TEMP wake trigger is connection-local:
 * a microtask reads only committed rows after the synchronous transaction ends. */
export class ConsoleChanges {
 readonly epoch: string;
 private cursor: number;
 private queued = false;
 private closed = false;
 private listeners = new Set<() => void>();
 private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
 private clockQueue = new Set<string>();
 private readonly db: DatabaseSync;
 constructor(database: MissionGoDatabase) {
  this.db = database.connection;
  this.db.prepare("INSERT OR IGNORE INTO console_change_meta(id,epoch) VALUES(1,?)").run(randomUUID());
  this.epoch = (this.db.prepare("SELECT epoch FROM console_change_meta WHERE id=1").get() as {epoch:string}).epoch;
  this.install();
  this.cursor = this.latest();
  this.db.function("console_change_wake", () => { this.wake(); return 0; });
  this.db.exec(`CREATE TEMP TRIGGER console_change_wake AFTER INSERT ON main.console_changes BEGIN SELECT console_change_wake(); END;`);
  this.db.function("console_clock_wake", (kind, id) => { this.clockQueue.add(`${kind}:${id}`); this.wake(); return 0; });
  for (const [table, kind] of [["nodes","nodes"],["agent_sessions","sessions"],["external_agent_sessions","external"],["merge_batches","merge"],["dispatches","dispatch-clock"],["agent_session_commands","command"],["external_native_commands","external-command"]]) {
   this.db.exec(`CREATE TEMP TRIGGER console_clock_${table} AFTER UPDATE ON main.${table} BEGIN SELECT console_clock_wake('${kind}', NEW.id); END;
    CREATE TEMP TRIGGER console_clock_insert_${table} AFTER INSERT ON main.${table} BEGIN SELECT console_clock_wake('${kind}', NEW.id); END;`);
   for (const row of this.db.prepare(`SELECT id FROM ${table}`).all() as {id:string}[]) this.clockQueue.add(`${kind}:${row.id}`);
  }
  this.wake();
 }
 private install() {
  const expression = (sql: string | undefined, row: string) => sql ? sql.replaceAll("$.", `${row}.`) : "NULL";
  for (const [table, spec] of Object.entries(specs)) {
   const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name);
   if (!columns.length) throw new Error(`Missing console change source: ${table}`);
   const meaningful = columns.filter(c=>!ignored.has(c) && !spec.ignore?.includes(c));
   const value = (row: string, column: string) => {
    if (column === "turn_state_json") return `json_remove(${row}.${column}, '$.observedAt')`;
    if (column === "native_snapshot_json") return `json_remove(${row}.${column}, '$.turnState.observedAt', '$.syncedAt')`;
    return `${row}.${column}`;
   };
   let changed = meaningful.map(c=>`${value("OLD",c)} IS NOT ${value("NEW",c)}`).join(" OR ");
   if (table === "agent_sessions") changed += " OR julianday(json_extract(NEW.turn_state_json, '$.observedAt'))-julianday(json_extract(OLD.turn_state_json, '$.observedAt'))>=120.0/86400";
   if (table === "external_agent_sessions") changed += " OR julianday(json_extract(NEW.native_snapshot_json, '$.turnState.observedAt'))-julianday(json_extract(OLD.native_snapshot_json, '$.turnState.observedAt'))>=120.0/86400";
   if (table === "nodes") changed += " OR OLD.last_seen_at IS NULL AND NEW.last_seen_at IS NOT NULL OR julianday(NEW.last_seen_at)-julianday(OLD.last_seen_at)>60.0/86400";
   for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS console_v1_${table}_${operation} AFTER ${operation} ON main.${table}
     ${operation === "UPDATE" ? `WHEN ${changed}` : ""} BEGIN
     INSERT INTO console_changes(kind,account_id,product_id,item_key,resource_id) SELECT '${spec.kind}',${expression(spec.account,row)},${expression(spec.product,row)},${expression(spec.item,row)},${expression(spec.resource,row)} WHERE ${spec.kind === 'admin' ? '1' : `COALESCE(${expression(spec.account,row)},${expression(spec.product,row)},${expression(spec.item,row)}) IS NOT NULL`};
     ${spec.adminAlso ? "INSERT INTO console_changes(kind) VALUES('admin');" : ""}
     END;`);
   }
  }
  // Revocation must wake the receiving project even after its source-item read
  // permission disappears. The signal contains only the already-visible target.
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
   const row=operation === "DELETE" ? "OLD" : "NEW";
   this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS console_v1_collaboration_access_${operation} AFTER ${operation} ON main.collaboration_requests
    ${operation === "UPDATE" ? "WHEN OLD.access_revoked_at IS NOT NEW.access_revoked_at OR OLD.withdrawn_at IS NOT NEW.withdrawn_at OR OLD.target_item_id IS NOT NEW.target_item_id" : ""} BEGIN
    INSERT INTO console_changes(kind,product_id) SELECT 'access',product_id FROM work_items WHERE id=${row}.target_item_id;
   END;`);
  }
 }
 latest(): number { return Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='console_changes'").get() as {seq:number}|undefined)?.seq ?? 0); }
 page(after: number, limit = 500): { changes: ConsoleChange[]; version: number; reset: boolean; more: boolean } {
  const latest = this.latest();
  const first = (this.db.prepare("SELECT MIN(version) AS n FROM console_changes").get() as {n:number|null}).n;
  const reset = after > latest || after < 0 || (first !== null && after < first - 1);
  const changes = reset ? [] : this.db.prepare("SELECT * FROM console_changes WHERE version>? ORDER BY version LIMIT ?").all(after,limit) as unknown as ConsoleChange[];
  const version = changes.at(-1)?.version ?? latest;
  return { changes, version: reset ? latest : version, reset, more: version < latest };
 }
 subscribe(listener: () => void) { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; }
 private wake() {
  if (this.closed || this.queued) return;
  this.queued = true;
  queueMicrotask(() => {
   this.queued = false;
   if (this.closed) return;
   const clocks = [...this.clockQueue]; this.clockQueue.clear();
   for (const key of clocks) this.schedule(key);
   const latest = this.latest();
   if (latest <= this.cursor) return;
   this.cursor = latest;
   // Bounded retention; cleanup happens only on writes, never on keepalive.
   this.db.prepare("DELETE FROM console_changes WHERE version<=?").run(latest - 10_000);
   for (const listener of this.listeners) listener();
  });
 }
 private schedule(key: string) {
  const previous = this.deadlines.get(key); if (previous) clearTimeout(previous);
  this.deadlines.delete(key);
  const separator=key.indexOf(":"), kind=key.slice(0,separator), id=key.slice(separator+1);
  let account: string | null = null, productId: string | null = null, resource: string | null = null;
  const times: number[] = [];
  if (kind === "nodes") {
   const row = this.db.prepare("SELECT account_id,last_seen_at FROM nodes WHERE id=? AND revoked_at IS NULL").get(id) as {account_id:string;last_seen_at:string}|undefined;
   if (!row) return; account=row.account_id;
   const at=Date.parse(row.last_seen_at); times.push(at+60_001,at+90_001);
  } else if (kind === "dispatch-clock") {
   const row=this.db.prepare("SELECT account_id,status,delivered_at,retry_not_before FROM dispatches WHERE id=?").get(id) as {account_id:string;status:string;delivered_at:string|null;retry_not_before:string|null}|undefined;
   if(!row)return;account=row.account_id;
   if(row.status==="delivered")times.push(Date.parse(row.delivered_at??"")+600_001);
   times.push(Date.parse(row.retry_not_before??""));
  } else if (kind === "command" || kind === "external-command") {
   const external=kind==="external-command";
   const row=this.db.prepare(external
    ? "SELECT s.account_id,c.status,c.delivering_at,c.created_at,c.session_id,'message' AS kind,NULL AS turn_id FROM external_native_commands c JOIN external_agent_sessions s ON s.id=c.session_id WHERE c.id=?"
    : "SELECT d.account_id,c.status,c.delivering_at,c.created_at,c.session_id,c.kind,c.turn_id FROM agent_session_commands c JOIN agent_sessions s ON s.id=c.session_id JOIN dispatches d ON d.id=s.dispatch_id WHERE c.id=?")
    .get(id) as {account_id:string;status:string;delivering_at:string|null;created_at:string;session_id:string;kind:string;turn_id:string|null}|undefined;
   if(!row)return;account=row.account_id;resource=row.session_id;
   if(row.kind==="interrupt" && (row.status==="delivering" || row.status==="queued"&&row.turn_id!=="startup")) times.push(Date.parse(row.delivering_at??row.created_at)+120_001);
   else if(row.status==="delivering")times.push(Date.parse(row.delivering_at??row.created_at)+(external?300_001:1800_001));
  } else if (kind === "merge") {
   const row = this.db.prepare("SELECT account_id,product_id,data_json FROM merge_batches WHERE id=?").get(id) as {account_id:string;product_id:string;data_json:string}|undefined;
   if (!row) return; account=row.account_id; productId=row.product_id;
   const data=JSON.parse(row.data_json); times.push(Date.parse(data.integration?.publication?.expiresAt ?? ""));
  } else {
   const external=kind === "external";
   const row = this.db.prepare(external ? "SELECT account_id,native_snapshot_json AS snapshot FROM external_agent_sessions WHERE id=?"
    : "SELECT d.account_id,s.turn_state_json AS snapshot FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE s.id=?").get(id) as {account_id:string;snapshot:string|null}|undefined;
   if (!row) return; account=row.account_id; resource=id;
   const data=JSON.parse(row.snapshot ?? "{}"); const turn=external ? data.turnState ?? {} : data;
   times.push(Date.parse(turn.observedAt ?? "")+120_001,Date.parse(turn.lastProgressAt ?? "")+600_001);
  }
  const next=times.filter(t=>Number.isFinite(t) && t>Date.now()).sort((a,b)=>a-b)[0];
  if (!next) return;
  const timer=setTimeout(()=>{
   this.deadlines.delete(key);
   if (this.closed) return;
   this.db.prepare("INSERT INTO console_changes(kind,account_id,product_id,resource_id) VALUES(?,?,?,?)")
    .run(["external","dispatch-clock","command","external-command"].includes(kind) ? "sessions" : kind,account,productId,resource);
   this.schedule(key);
  },Math.min(next-Date.now(),2_147_483_647)); timer.unref(); this.deadlines.set(key,timer);
 }
 close() { this.closed=true; this.listeners.clear(); for (const timer of this.deadlines.values()) clearTimeout(timer); this.deadlines.clear(); }
}
