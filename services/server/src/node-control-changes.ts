import { randomUUID } from "node:crypto";
import type { MissionGoDatabase } from "./storage/database.js";
import { MissionGoError } from "./errors.js";

/** A wake is a hint, never a delivery lease. The durable work remains in SQLite.
 * TEMP rows roll back with the business transaction; the microtask only drains
 * committed hints. Transcript and clock-only writes never wake input; a real
 * idle/input-ready transition wakes work deferred by the native runtime. */
export class NodeControlChanges {
  private readonly epoch = randomUUID();
  private readonly revisions = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private scheduled = false;
  private closed = false;
  constructor(private readonly database: MissionGoDatabase) {
    const db = database.connection;
    db.exec("CREATE TEMP TABLE node_control_pending(node_id TEXT PRIMARY KEY)");
    db.function("node_control_wake", () => { this.schedule(); return 0; });
    const install = (table: string, nodes: (row: string) => string, columns?: string[]) => {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const row = operation === "DELETE" ? "OLD" : "NEW";
        const condition = operation === "UPDATE" && columns ? `WHEN ${columns.map(c => c === "snapshot_json" ? "json_extract(OLD.snapshot_json,'$.stopRequested') IS NOT json_extract(NEW.snapshot_json,'$.stopRequested') OR json_extract(OLD.snapshot_json,'$.state') IS NOT json_extract(NEW.snapshot_json,'$.state')"
          : c === "turn_state_json" || c === "native_snapshot_json" ? (c === "native_snapshot_json" ? ["$.status", "$.turnState.turnActive", "$.turnState.waitingForInput"] : ["$.turnActive", "$.waitingForInput"])
            .map(path => `json_extract(OLD.${c},'${path}') IS NOT json_extract(NEW.${c},'${path}')`).join(" OR ")
          : `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}` : "";
        db.exec(`CREATE TEMP TRIGGER control_${table}_${operation} AFTER ${operation} ON main.${table} ${condition} BEGIN
          INSERT OR IGNORE INTO node_control_pending SELECT id FROM nodes WHERE id IN (${nodes(row)});
          SELECT node_control_wake(); END;`);
      }
    };
    const sessionNode = (row: string) => `SELECT node_id FROM agent_sessions WHERE id=${row}.session_id`;
    install("agent_session_commands", sessionNode, ["status", "error", "turn_id"]);
    install("agent_session_approvals", sessionNode, ["decision", "retry_status"]);
    install("external_native_commands", row => `SELECT native_node_id FROM external_agent_sessions WHERE id=${row}.session_id`, ["status", "error"]);
    install("agent_sessions", row => `SELECT ${row}.node_id`, ["desired_settings_json", "settings_revision", "archived_at", "source_restore_pending", "status", "turn_state_json"]);
    // Column names are read from the schema so this stays independent of the
    // optional external settings implementation's storage layout.
    const externalColumns = (db.prepare("PRAGMA table_info(external_agent_sessions)").all() as {name:string}[])
      .map(c => c.name).filter(c => /settings|native_node_id|native_generation|archived_at|native_snapshot_json/.test(c));
    install("external_agent_sessions", row => `SELECT ${row}.native_node_id`, externalColumns);
    install("managed_execution_intents", row => `SELECT ${row}.node_id`, ["generation", "ownership_held", "snapshot_json"]);
    install("nodes", row => `SELECT ${row}.id`, ["revoked_at", "agents_json"]);
    for (const table of ["accounts", "account_products"]) install(table,
      row => `SELECT id FROM nodes WHERE account_id=${row}.${table === "accounts" ? "id" : "account_id"}`);
  }
  cursor(nodeId: string): string { if (!this.closed) this.drain(); return `${this.epoch}:${this.revisions.get(nodeId) ?? 0}`; }
  private schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.drain(); });
  }
  private drain() {
    const db = this.database.connection;
    const rows = db.prepare("SELECT node_id FROM node_control_pending").all() as {node_id:string}[];
    db.exec("DELETE FROM node_control_pending");
    for (const {node_id: id} of rows) {
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
      for (const finish of this.waiters.get(id) ?? []) finish();
    }
  }
  async wait(nodeId: string, cursor: string | undefined, ms: number, signal: AbortSignal): Promise<string> {
    if (cursor !== this.cursor(nodeId) || ms <= 0 || signal.aborted || this.closed) return this.cursor(nodeId);
    const waiting = this.waiters.get(nodeId) ?? new Set<() => void>();
    if (waiting.size >= 2) throw new MissionGoError("node_control_busy", "This node already has active control polls.", 429);
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener("abort", finish); waiting.delete(finish);
        if (!waiting.size) this.waiters.delete(nodeId);
        resolve();
      };
      const timer = setTimeout(finish, ms); timer.unref();
      waiting.add(finish); this.waiters.set(nodeId, waiting);
      signal.addEventListener("abort", finish, {once:true});
      // No await between initial cursor check and registration. Recheck for
      // any queued committed write before going idle.
      if (cursor !== this.cursor(nodeId) || signal.aborted) finish();
    });
    return this.cursor(nodeId);
  }
  close() { this.closed = true; for (const waiting of this.waiters.values()) for (const finish of waiting) finish(); this.waiters.clear(); }
}
