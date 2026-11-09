import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MissionGoStore } from "./store.js";
import { ConsoleChanges } from "./console-changes.js";
import { AgentSessionStore } from "./agent-session-store.js";
const cleanup:(()=>void)[]=[];
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.useRealTimers();});
function fixture() {
 const store=new MissionGoStore(":memory:");const feed=new ConsoleChanges(store.database);
 cleanup.push(()=>{feed.close();store.close();});
 const product=store.createProduct({name:"Synthetic",keyPrefix:"SYN"});
 return {store,feed,db:store.database.connection,product};
}
it("publishes only committed rows, including nested rollback and direct autocommit writes",async()=>{
 const f=fixture();await Promise.resolve();const listener=vi.fn();f.feed.subscribe(listener);const start=f.feed.latest();
 expect(()=>f.store.database.transaction(()=>{f.store.createProduct({name:"rollback",keyPrefix:"ROLL"});throw new Error("abort");})).toThrow();
 await Promise.resolve();expect(listener).not.toHaveBeenCalled();expect(f.feed.latest()).toBe(start);
 f.store.database.transaction(()=>{
  f.db.prepare("UPDATE products SET name='committed' WHERE id=?").run(f.product.id);
  try{f.store.database.transaction(()=>{f.db.prepare("UPDATE products SET name='wrong' WHERE id=?").run(f.product.id);throw new Error("inner");});}catch{/* deliberately rolled back */}
 });
 await Promise.resolve();expect(listener).toHaveBeenCalledOnce();expect(f.feed.page(start).changes).toHaveLength(1);
 f.db.prepare("UPDATE products SET name='autocommit' WHERE id=?").run(f.product.id);await Promise.resolve();expect(listener).toHaveBeenCalledTimes(2);
});
it("deduplicates unchanged node snapshots and schedules online expiry without repeated database reads",async()=>{
 vi.useFakeTimers();vi.setSystemTime("2026-11-09T02:00:00Z");const f=fixture();const now=new Date().toISOString();
 f.db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
 VALUES('node','owner','fixture','Node','synthetic','[]',?,?,?)`).run(now,now,now);
 await Promise.resolve();const start=f.feed.latest();
 vi.advanceTimersByTime(10_000);
 f.db.prepare("UPDATE nodes SET last_seen_at=?,updated_at=? WHERE id='node'").run(new Date().toISOString(),new Date().toISOString());
 await Promise.resolve();expect(f.feed.latest()).toBe(start);
 const spy=vi.spyOn(f.db,"prepare");vi.advanceTimersByTime(20_000);await Promise.resolve();expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 vi.advanceTimersByTime(40_001);await Promise.resolve();expect(f.feed.page(start).changes).toMatchObject([{kind:"nodes",account_id:"owner"}]);
 vi.advanceTimersByTime(30_000);await Promise.resolve();expect(f.feed.page(start).changes).toHaveLength(2);
});
it("keeps message edits while dropping identical snapshots and observation-only ticks",async()=>{
 vi.useFakeTimers();vi.setSystemTime("2026-11-09T02:00:00Z");const f=fixture();const now=new Date().toISOString();
 f.db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at) VALUES('n','owner','n','N','synthetic','[]',?,?)`).run(now,now);
 f.db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES('d','owner','n','codex','auto','launched','synthetic',?)`).run(now);
 const sessions=new AgentSessionStore(f.store.database);const id=sessions.createForDispatch({dispatchId:"d",nodeId:"n",sessionRef:"native"});
 const snapshot=(text:string)=>sessions.recordSnapshot({nodeId:"n",sessionId:id,status:"active",messages:[{sourceId:"m",role:"agent",text,occurredAt:now}],turnState:{turnActive:true,observedAt:new Date().toISOString(),lastProgressAt:now}});
 snapshot("first");await Promise.resolve();const start=f.feed.latest();vi.advanceTimersByTime(5000);snapshot("first");await Promise.resolve();
 expect(f.feed.latest()).toBe(start);
 snapshot("edited");await Promise.resolve();expect(f.feed.page(start).changes.some(c=>c.kind==="sessions"&&c.account_id==="owner")).toBe(true);
});
it("resets expired and future cursors, bounds retention and persists restart identity",async()=>{
 const f=fixture();const start=f.feed.latest();
 f.db.prepare("DELETE FROM console_changes").run();
 f.db.prepare("UPDATE products SET name='after pruning' WHERE id=?").run(f.product.id);
 expect(f.feed.page(0).reset).toBe(true);expect(f.feed.page(f.feed.latest()+1).reset).toBe(true);
 expect(f.feed.page(start).reset).toBe(false);
 await Promise.resolve();
});
it("does not broadcast orphaned private rows as public invalidations",()=>{
 const f=fixture();const start=f.feed.latest();
 // A linked row with no resolvable parent must not acquire a global audience.
 f.db.exec("PRAGMA foreign_keys=OFF");
 f.db.prepare("INSERT INTO external_native_messages(id,session_id,source_id,payload_json,position) VALUES('m','missing','secret','{}',0)").run();
 expect(f.feed.latest()).toBe(start);
});

it("persists the epoch and replays committed changes after a server restart",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"console-journal-")),path=join(dir,"test.sqlite");
 let store=new MissionGoStore(path),feed=new ConsoleChanges(store.database);
 try {
  store.createProduct({name:"Before restart",keyPrefix:"BEFORE"});await Promise.resolve();
  const epoch=feed.epoch,cursor=feed.latest();feed.close();store.close();
  store=new MissionGoStore(path);feed=new ConsoleChanges(store.database);
  store.createProduct({name:"After restart",keyPrefix:"AFTER"});await Promise.resolve();
  expect(feed.epoch).toBe(epoch);expect(feed.page(cursor).changes).toMatchObject([{kind:"products"}]);
 } finally {feed.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

it("shares bounded live pages across subscribers without losing a multi-page commit",async()=>{
 const f=fixture();await Promise.resolve();
 const first=vi.fn(),second=vi.fn();f.feed.subscribe(first);f.feed.subscribe(second);
 const spy=vi.spyOn(f.db,"prepare");
 try {
  f.store.database.transaction(()=>{for(let i=0;i<1001;i++)f.db.prepare("UPDATE products SET name=? WHERE id=?").run(`revision-${i}`,f.product.id);});
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(3);expect(second).toHaveBeenCalledTimes(3);
  expect(first.mock.calls.flatMap(([batch])=>batch.page.changes)).toHaveLength(1001);
  for(let i=0;i<3;i++)expect(first.mock.calls[i]![0].page).toBe(second.mock.calls[i]![0].page);
  expect(spy.mock.calls.filter(([sql])=>String(sql).startsWith("SELECT * FROM console_changes"))).toHaveLength(3);
 }finally{spy.mockRestore();}
});
