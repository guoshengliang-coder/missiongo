import {afterEach, expect, it} from "vitest";
import {setTimeout as delay} from "node:timers/promises";
import {MissionGoDatabase} from "./storage/database.js";
import {NodeControlChanges} from "./node-control-changes.js";
import {DispatchStore} from "./dispatch-store.js";
import {buildApp} from "./app.js";
import {TEST_CONSOLE_ACCOUNT} from "./testing-fixtures.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const database = new MissionGoDatabase(":memory:"); const changes = new NodeControlChanges(database); const db = database.connection;
  cleanup.push(() => {changes.close(); database.close();});
  const at = new Date().toISOString();
  for (const id of ["one","two"]) {
    db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
      VALUES (?,'owner',?,?,?,'[]',?,?)`).run(id,id,id,id,at,at);
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES (?,'owner',?,'codex','default','launched','fixture',?)`).run(id,id,at);
    db.prepare(`INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,created_at,updated_at)
      VALUES (?,?,?,'codex',?,'idle',?,?)`).run(id,id,id,id,at,at);
  }
  const enqueue = (session = "one", id = "command") => db.prepare(`INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at)
    VALUES (?,?,'owner','message','continue','queued',?)`).run(id,session,at);
  return {database,db,changes,enqueue};
}
it("wakes only the target node after committed work, including the registration boundary", async () => {
  const f=fixture(); const one=f.changes.cursor("one"), two=f.changes.cursor("two"); const signal=new AbortController().signal;
  const pending=f.changes.wait("one",one,1000,signal); f.enqueue();
  expect(await pending).not.toBe(one); expect(f.changes.cursor("two")).toBe(two);
  expect(await f.changes.wait("one",one,1000,signal)).not.toBe(one);
});
it("does not wake on rollback, transcript clocks, heartbeat or identical command acknowledgements", async () => {
  const f=fixture(); const cursor=f.changes.cursor("one");
  expect(()=>f.database.transaction(()=>{f.enqueue();throw new Error("rollback");})).toThrow("rollback");
  await Promise.resolve(); expect(f.changes.cursor("one")).toBe(cursor);
  f.db.prepare("UPDATE agent_sessions SET status='idle',turn_state_json=? WHERE id='one'").run(JSON.stringify({observedAt:new Date().toISOString()}));
  f.db.prepare("UPDATE nodes SET last_seen_at=? WHERE id='one'").run(new Date().toISOString());
  expect(f.changes.cursor("one")).toBe(cursor);
  f.enqueue(); const queued=f.changes.cursor("one");
  f.db.prepare("UPDATE agent_session_commands SET status='queued' WHERE id='command'").run();
  expect(f.changes.cursor("one")).toBe(queued);
});
it("bounds waiters and releases cancelled, expired and closing polls", async () => {
  const f=fixture(); const cursor=f.changes.cursor("one"), a=new AbortController(), b=new AbortController();
  const first=f.changes.wait("one",cursor,1000,a.signal), second=f.changes.wait("one",cursor,1000,b.signal);
  await expect(f.changes.wait("one",cursor,1000,new AbortController().signal)).rejects.toMatchObject({statusCode:429});
  a.abort(); await first; b.abort(); await second;
  expect(await f.changes.wait("one",cursor,5,new AbortController().signal)).toBe(cursor);
  const final=f.changes.wait("one",cursor,1000,new AbortController().signal); f.changes.close(); await final;
});
it("rechecks revocation across a real HTTP wait and never leaks another node cursor", async () => {
  const app=buildApp({databasePath: ":memory:", adminAccount:TEST_CONSOLE_ACCOUNT}); cleanup.push(()=>app.close());
  const store=new DispatchStore(app.missionGoStore.database);
  const node=store.registerNode({accountId:TEST_CONSOLE_ACCOUNT.id,installationId:"control-http",name:"Synthetic"});
  const origin=await app.listen({host:"127.0.0.1",port:0}); const headers={authorization:`Bearer ${node.token}`};
  const initial=await fetch(origin+"/api/v1/node/control-changes?waitMs=0",{headers}); expect(initial.status).toBe(200);
  const {cursor}=await initial.json() as {cursor:string};
  const waiting=fetch(origin+`/api/v1/node/control-changes?cursor=${encodeURIComponent(cursor)}&waitMs=1000`,{headers});
  await delay(10); app.missionGoStore.database.connection.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(),node.nodeId);
  expect((await waiting).status).toBe(401);
});
it("wakes for external input/settings while pure external mirrors remain silent",()=>{
  const f=fixture(),at=new Date().toISOString();
  f.db.prepare(`INSERT INTO external_agent_sessions(id,account_id,client_id,agent_kind,session_ref,ref_kind,progress_status,created_at,updated_at,activity_at,native_node_id,native_generation)
    VALUES ('external','owner','fixture','codex','external-ref','native','working',?,?,?,'one',1)`).run(at,at,at);
  f.db.prepare("UPDATE external_agent_sessions SET native_snapshot_json=? WHERE id='external'").run(JSON.stringify({status:"active",messages:[]}));
  const before=f.changes.cursor("one"),other=f.changes.cursor("two");
  f.db.prepare("UPDATE external_agent_sessions SET native_snapshot_json=?,native_synced_at=? WHERE id='external'").run(JSON.stringify({status:"active",messages:[{text:"new text"}]}),at);
  expect(f.changes.cursor("one")).toBe(before);
  f.db.prepare("UPDATE external_agent_sessions SET native_settings_json=? WHERE id='external'").run(JSON.stringify({revision:1,desired:{model:"fixture"}}));
  expect(f.changes.cursor("one")).not.toBe(before);
  const settings=f.changes.cursor("one");
  f.db.prepare("INSERT INTO external_native_commands(id,session_id,text,status,created_at) VALUES ('external-command','external','continue','queued',?)").run(at);
  expect(f.changes.cursor("one")).not.toBe(settings);expect(f.changes.cursor("two")).toBe(other);
});

it("wakes deferred input when the native runtime becomes idle or starts waiting for an answer",()=>{
  const f=fixture();f.db.prepare("UPDATE agent_sessions SET status='active',turn_state_json=? WHERE id='one'").run(JSON.stringify({turnActive:true,waitingForInput:false}));
  const active=f.changes.cursor("one");
  f.db.prepare("UPDATE agent_sessions SET status='idle',turn_state_json=? WHERE id='one'").run(JSON.stringify({turnActive:false,waitingForInput:false}));
  expect(f.changes.cursor("one")).not.toBe(active);
  const idle=f.changes.cursor("one");
  f.db.prepare("UPDATE agent_sessions SET turn_state_json=? WHERE id='one'").run(JSON.stringify({turnActive:false,waitingForInput:true}));
  expect(f.changes.cursor("one")).not.toBe(idle);
});
