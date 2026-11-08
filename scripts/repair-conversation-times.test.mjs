import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repairConversationTimes } from "./repair-conversation-times.mjs";

test("scoped preview, backup, concurrent-message protection and repeatable application", () => {
  const root=mkdtempSync(join(tmpdir(),"conversation-times-"));
  const database=join(root,"data.sqlite"),backup=join(root,"backup.sqlite");
  const original="2026-11-07T03:39:51.894Z",polluted="2026-11-08T11:24:23.000Z";
  try {
    const db=new DatabaseSync(database);
    db.exec(`CREATE TABLE agent_sessions(id TEXT,dispatch_id TEXT,activity_at TEXT,created_at TEXT,agent_session_ref TEXT);
      CREATE TABLE dispatches(id TEXT,account_id TEXT); CREATE TABLE free_session_starts(dispatch_id TEXT,product_id TEXT);
      CREATE TABLE dispatch_items(dispatch_id TEXT,item_id TEXT); CREATE TABLE work_items(id TEXT,product_id TEXT);
      CREATE TABLE external_agent_sessions(id TEXT,account_id TEXT,activity_at TEXT,created_at TEXT,session_ref TEXT);
      CREATE TABLE external_agent_session_items(session_id TEXT,item_id TEXT);
      CREATE TABLE external_native_commands(id TEXT,session_id TEXT,created_at TEXT);
      CREATE TABLE external_agent_session_reports(id TEXT,session_id TEXT,created_at TEXT);
      CREATE TABLE agent_session_commands(id TEXT,session_id TEXT,kind TEXT,created_at TEXT);
      CREATE TABLE session_unread_state(session_key TEXT,source_at TEXT);`);
    for(const [id,product] of [["safe","product"],["changed","product"],["unknown","product"],["other","elsewhere"]]) {
      db.prepare("INSERT INTO dispatches VALUES (?,'owner')").run(id);
      db.prepare("INSERT INTO free_session_starts VALUES (?,?)").run(id,product);
      db.prepare("INSERT INTO agent_sessions VALUES (?,?,?,?,?)").run(id,id,polluted,original,`native-${id}`);
      if(id!=="unknown")db.prepare("INSERT INTO session_unread_state VALUES (?,?)").run(`dispatch:${id}`,original);
    }
    const options={database,accountId:"owner",productId:"product"};
    const plan=repairConversationTimes(options);
    assert.deepEqual(plan.rows.map(r=>r.id).sort(),["changed","safe","unknown"]);
    assert.equal(plan.rows.find(r=>r.id==="safe").proposedTime,original);
    assert.equal(plan.rows.find(r=>r.id==="unknown").action,"skip");
    assert.equal(db.prepare("SELECT activity_at FROM agent_sessions WHERE id='safe'").get().activity_at,polluted);
    assert.throws(()=>repairConversationTimes({...options,apply:true,plan}),/backup/);
    db.exec(`CREATE TABLE session_message_clocks(session_key TEXT PRIMARY KEY,message_at TEXT);
      CREATE TABLE session_message_times(session_key TEXT,source_id TEXT,occurred_at TEXT,provenance TEXT);`);
    for(const id of ["safe","changed"]) db.prepare("INSERT INTO session_message_times VALUES (?,'legacy:source-frontier',?,'legacy_source_frontier')").run(`dispatch:${id}`,original);
    db.prepare("INSERT INTO session_message_clocks VALUES ('dispatch:safe',?)").run(polluted);
    db.prepare("INSERT INTO session_message_times VALUES ('dispatch:changed','new-reply',?,'source_message')").run(polluted);
    db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
    const applied=repairConversationTimes({...options,apply:true,plan,backup});
    assert.equal(applied.rows.find(r=>r.id==="safe").action,"repaired");
    assert.equal(applied.rows.find(r=>r.id==="changed").reason,"source_changed_since_preview");
    assert.equal(db.prepare("SELECT message_at FROM session_message_clocks WHERE session_key='dispatch:safe'").get().message_at,original);
    repairConversationTimes({...options,apply:true,plan,backup});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM conversation_time_repairs").get().n,1);
    db.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
