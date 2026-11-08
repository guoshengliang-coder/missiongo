// Scoped message-clock reconciliation. No message bodies are exported. Preview
// works before the migration; apply requires its exact plan and a real backup.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasTable = (db, name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
function scopedRows(db, accountId, productId) {
  return [
    ...db.prepare(`SELECT s.id,'dispatch:'||d.id AS key,s.activity_at AS previousTime,s.created_at AS createdAt,s.agent_session_ref AS sessionRef
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE d.account_id=? AND (
        EXISTS(SELECT 1 FROM free_session_starts f WHERE f.dispatch_id=d.id AND f.product_id=?) OR
        EXISTS(SELECT 1 FROM dispatch_items i JOIN work_items w ON w.id=i.item_id WHERE i.dispatch_id=d.id AND w.product_id=?))`)
      .all(accountId, productId, productId).map(row => ({ ...row, kind: "dispatch" })),
    ...db.prepare(`SELECT s.id,'external:'||s.id AS key,s.activity_at AS previousTime,s.created_at AS createdAt,s.session_ref AS sessionRef
      FROM external_agent_sessions s WHERE s.account_id=? AND EXISTS(
        SELECT 1 FROM external_agent_session_items i JOIN work_items w ON w.id=i.item_id WHERE i.session_id=s.id AND w.product_id=?)
        AND NOT EXISTS(SELECT 1 FROM external_agent_session_items i JOIN work_items w ON w.id=i.item_id WHERE i.session_id=s.id AND w.product_id<>?)`)
      .all(accountId, productId, productId).map(row => ({ ...row, kind: "external" })),
  ];
}

function evidence(db, row) {
  if (hasTable(db, "session_message_times")) return db.prepare(`SELECT source_id,occurred_at,provenance
    FROM session_message_times WHERE session_key=? ORDER BY source_id`).all(row.key);
  // Match the migration's trust boundary; legacy occurred_at is not evidence.
  const times = [];
  const frontier = db.prepare("SELECT source_at FROM session_unread_state WHERE session_key=?").get(row.key)?.source_at;
  if (frontier) times.push({ source_id: "legacy:source-frontier", occurred_at: frontier, provenance: "legacy_source_frontier" });
  const commands = row.kind === "dispatch"
    ? db.prepare("SELECT id,created_at FROM agent_session_commands WHERE session_id=? AND kind='message'").all(row.id)
    : db.prepare("SELECT id,created_at FROM external_native_commands WHERE session_id=?").all(row.id);
  for (const command of commands) times.push({ source_id: `command:${command.id}`, occurred_at: command.created_at, provenance: "server_message" });
  if (row.kind === "external") for (const report of db.prepare("SELECT id,created_at FROM external_agent_session_reports WHERE session_id=?").all(row.id)) {
    times.push({ source_id: `report:${report.id}`, occurred_at: report.created_at, provenance: "server_message" });
  }
  return times.sort((a,b) => a.source_id.localeCompare(b.source_id));
}

export function repairConversationTimes({ database, accountId, productId, plan, backup, sourceEvidence = [], apply = false }) {
  if (!accountId || !productId) throw new Error("Explicit accountId and productId are required.");
  if (apply) {
    if (!plan || plan.version !== 1 || plan.accountId !== accountId || plan.productId !== productId) throw new Error("A matching preview plan is required.");
    if (!backup || readFileSync(backup).subarray(0,16).toString() !== "SQLite format 3\0") throw new Error("A SQLite backup is required before applying corrections.");
  }
  const db = new DatabaseSync(database, { readOnly: !apply });
  try {
    if (apply) {
      if (!hasTable(db,"session_message_clocks")) throw new Error("Deploy the message-clock migration first.");
      db.exec("BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS conversation_time_repairs(
        plan_digest TEXT NOT NULL,session_key TEXT NOT NULL,previous_time TEXT,corrected_time TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,applied_at TEXT NOT NULL,PRIMARY KEY(plan_digest,session_key)) STRICT`);
    }
    const rows = scopedRows(db,accountId,productId).map(row => {
      const native = (apply ? plan.rows.find(item => item.key === row.key)?.sourceEvidence : sourceEvidence.find(item => item.id === row.id));
      if (native && (native.sessionRef !== row.sessionRef || !/^[a-f0-9]{64}$/.test(native.sha256) || !Number.isFinite(Date.parse(native.messageAt))
        || Date.parse(native.messageAt) > Date.now()+60_000 || !Number.isSafeInteger(native.messageCount) || native.messageCount<1)) throw new Error("Invalid or changed native evidence identity.");
      const nativeStamp = native ? [{source_id:`native-history:${native.sha256}`,occurred_at:native.messageAt,provenance:"verified_native_history"}] : [];
      const stamps = [...new Map([...evidence(db,row),...nativeStamp].map(stamp=>[stamp.source_id,stamp])).values()].sort((a,b)=>a.source_id.localeCompare(b.source_id)).filter(item => Number.isFinite(Date.parse(item.occurred_at)) && Date.parse(item.occurred_at) <= Date.now() + 60_000);
      const proposedTime = stamps.map(item => item.occurred_at).sort().at(-1);
      const currentTime = hasTable(db,"session_message_clocks")
        ? db.prepare("SELECT message_at FROM session_message_clocks WHERE session_key=?").get(row.key)?.message_at ?? row.createdAt : row.previousTime;
      const result = { ...row,...(native?{sourceEvidence:native}:{}),currentTime,proposedTime:proposedTime ?? null,evidenceCount:stamps.length,evidenceDigest:hash(stamps),
        action:proposedTime ? "candidate" : "skip",reason:proposedTime ? "trusted_message_times" : "no_trusted_source_time" };
      if (!apply || !proposedTime) return result;
      const approved = plan.rows.find(item => item.key === row.key && item.id === row.id && item.kind === row.kind);
      if (!approved || approved.action !== "candidate") return { ...result,action:"skip",reason:"outside_preview" };
      // A native re-observation may add evidence after preview. Never overwrite
      // a newer conversation or silently use changed historical evidence.
      if (approved.proposedTime !== proposedTime) return { ...result,action:"skip",reason:"source_changed_since_preview" };
      if (currentTime > proposedTime && currentTime !== approved.currentTime) return { ...result,action:"skip",reason:"projection_changed_since_preview" };
      for (const stamp of nativeStamp) db.prepare(`INSERT OR IGNORE INTO session_message_times VALUES (?,?,?,?)`)
        .run(row.key,stamp.source_id,stamp.occurred_at,stamp.provenance);
      db.prepare(`INSERT OR IGNORE INTO conversation_time_repairs VALUES (?,?,?,?,?,?)`)
        .run(hash(plan),row.key,currentTime,proposedTime,hash(stamps),new Date().toISOString());
      db.prepare(`INSERT INTO session_message_clocks(session_key,message_at) VALUES (?,?)
        ON CONFLICT(session_key) DO UPDATE SET message_at=excluded.message_at`).run(row.key,proposedTime);
      return { ...result,action:currentTime === proposedTime ? "verified" : "repaired" };
    });
    if (apply) db.exec("COMMIT");
    return { version:1,accountId,productId,generatedAt:new Date().toISOString(),apply,rows };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values}=parseArgs({options:{database:{type:"string"},"account-id":{type:"string"},"product-id":{type:"string"},
    plan:{type:"string"},"source-evidence":{type:"string"},backup:{type:"string"},apply:{type:"boolean",default:false}}});
  if(!values.database) throw new Error("--database is required.");
  console.log(JSON.stringify(repairConversationTimes({database:values.database,accountId:values["account-id"],productId:values["product-id"],
    apply:values.apply,backup:values.backup,...(values["source-evidence"]?{sourceEvidence:JSON.parse(readFileSync(values["source-evidence"],"utf8"))}:{}),...(values.plan?{plan:JSON.parse(readFileSync(values.plan,"utf8"))}:{})})));
}
