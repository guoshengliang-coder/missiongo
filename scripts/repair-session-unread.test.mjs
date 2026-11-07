import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repairSessionUnread } from "./repair-session-unread.mjs";

test("repair uses a read baseline, preserves real output, defaults to dry-run and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "unread-repair-"));
  const baseline = join(dir,"before.sqlite"), database = join(dir,"current.sqlite");
  const read = "2026-11-07T00:00:00.000Z", polluted = "2026-11-07T01:50:25.000Z";
  try {
    for (const [path, current] of [[baseline,false],[database,true]]) {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE dispatches(id TEXT, node_id TEXT, read_at TEXT, unread_at TEXT,status TEXT,error TEXT);
        CREATE TABLE agent_sessions(id TEXT, dispatch_id TEXT, status TEXT, turn_state_json TEXT,last_error TEXT);
        CREATE TABLE agent_session_messages(session_id TEXT,source_id TEXT,role TEXT,phase TEXT,text TEXT,questions_json TEXT,occurred_at TEXT);
        CREATE TABLE agent_session_commands(session_id TEXT,created_at TEXT);`);
      for (const id of ["safe","real-reply","changed-ack","pending","dispatch-failure"]) {
        db.prepare("INSERT INTO dispatches VALUES (?,?,?,?,?,?)").run(id,"node",current && id === "changed-ack" ? "2026-11-07T00:10:00.000Z" : read,current ? polluted : read,
          current && id === "dispatch-failure" ? "failed" : "launched",current && id === "dispatch-failure" ? "synthetic failure" : null);
        db.prepare("INSERT INTO agent_sessions VALUES (?,?,'idle','{}',NULL)").run(id,id);
        db.prepare("INSERT INTO agent_session_messages VALUES (?,?,'agent','final_answer','original',NULL,?)").run(id,"answer",read);
        if (current) db.prepare("INSERT INTO agent_session_messages VALUES (?,?,'agent',?,'synthetic',?,?)")
          .run(id,"extra",id === "real-reply" ? "final_answer" : "execution",id === "pending" ? '[{"title":"Choose"}]' : null,"2026-11-06T23:00:00.000Z");
      }
      db.close();
    }
    const options = { database, baseline, nodeId: "node", from: "2026-11-07T01:50:00.000Z", until: "2026-11-07T01:51:00.000Z" };
    const dry = repairSessionUnread(options);
    assert.deepEqual(dry.filter(r => r.action === "candidate").map(r => r.id),["safe"]);
    const check = new DatabaseSync(database);
    assert.equal(check.prepare("SELECT unread_at FROM dispatches WHERE id='safe'").get().unread_at,polluted);
    check.close();
    assert.deepEqual(repairSessionUnread({ ...options, apply: true }).filter(r => r.action === "repaired").map(r => r.id),["safe"]);
    assert.equal(repairSessionUnread({ ...options, apply: true }).filter(r => r.action === "repaired").length,0);
    const after = new DatabaseSync(database);
    assert.equal(after.prepare("SELECT unread_at FROM dispatches WHERE id='real-reply'").get().unread_at,polluted);
    assert.equal(after.prepare("SELECT count(*) n FROM session_unread_repairs").get().n,1);
    after.close();
    assert.throws(() => repairSessionUnread({ ...options, until: "2026-11-08T00:00:00.000Z" }),/ten minutes/);
  } finally { rmSync(dir,{ recursive: true, force: true }); }
});
