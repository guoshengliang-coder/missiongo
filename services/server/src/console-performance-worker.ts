import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PERFORMANCE_BUCKETS } from "@missiongo/domain";

const DAY = 86400000, cap = workerData.maxBytes ?? 64 * 1024 * 1024;
if (workerData.path !== ":memory:") mkdirSync(dirname(workerData.path), { recursive: true });
const db = new DatabaseSync(workerData.path);
db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${Math.floor(cap * .75 / 4096)}; PRAGMA journal_mode=WAL;
 PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=50; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=0; PRAGMA wal_autocheckpoint=128;
 CREATE TABLE IF NOT EXISTS samples(bucket INTEGER, account TEXT, scope TEXT, source TEXT, version TEXT, agent TEXT, kind TEXT, stage TEXT, result TEXT,
 n INTEGER, timed INTEGER, total REAL, lo REAL, hi REAL, histogram TEXT, PRIMARY KEY(bucket,account,scope,source,version,agent,kind,stage,result));
 CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY,at INTEGER);
 CREATE TABLE IF NOT EXISTS health(bucket INTEGER,account TEXT,scope TEXT,accepted INTEGER,dropped INTEGER,duplicates INTEGER,PRIMARY KEY(bucket,account,scope));
 CREATE TABLE IF NOT EXISTS coverage(minute INTEGER PRIMARY KEY,version TEXT);
 CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,account TEXT,scope TEXT,source TEXT,version TEXT,agent TEXT,kind TEXT,at INTEGER);
 CREATE INDEX IF NOT EXISTS seen_at ON seen(at); CREATE INDEX IF NOT EXISTS samples_bucket ON samples(bucket);`);
let dropped = 0, accepted = 0, duplicates = 0;
const clean = (now: number) => {
 db.prepare("DELETE FROM samples WHERE bucket<?").run(now - 7 * DAY);
 db.prepare("DELETE FROM health WHERE bucket<?").run(now - 7 * DAY);
 db.prepare("DELETE FROM seen WHERE at<?").run(now - DAY);
 db.prepare("DELETE FROM coverage WHERE minute<?").run(now - 7 * DAY);
 for(const p of db.prepare("SELECT * FROM pending WHERE at<? LIMIT 10000").all(now-DAY) as any[])if(!aggregate({...p,stage:"missing",result:"expired"},now))throw new Error("Missing observation capacity exhausted");
 db.prepare("DELETE FROM pending WHERE at<?").run(now-DAY);
};
function health(e:any,now:number,kind:"accepted"|"dropped"|"duplicates"){
 const bucket=Math.floor(now/300000)*300000;
 const exists=db.prepare("SELECT 1 FROM health WHERE bucket=? AND account=? AND scope=?").get(bucket,e.account,e.scope);
 if(!exists&&(db.prepare("SELECT count(*) AS n FROM health").get() as any).n>=30000)throw new Error("Health capacity exhausted");
 db.prepare(`INSERT INTO health VALUES (?,?,?,?,?,?) ON CONFLICT(bucket,account,scope) DO UPDATE SET ${kind}=${kind}+1`).run(bucket,e.account,e.scope,kind==="accepted"?1:0,kind==="dropped"?1:0,kind==="duplicates"?1:0);
}
function aggregate(e: any, now: number) {
 const bucket = Math.floor(now / 300000) * 300000;
 const key = [bucket,e.account,e.scope,e.source,e.version,e.agent,e.kind,e.stage,e.result];
 const prior = db.prepare("SELECT * FROM samples WHERE bucket=? AND account=? AND scope=? AND source=? AND version=? AND agent=? AND kind=? AND stage=? AND result=?").get(...key) as any;
 if (!prior && (db.prepare("SELECT count(*) AS n FROM samples").get() as any).n >= 30000) { dropped++; return false; }
 const h: number[] = prior ? JSON.parse(prior.histogram) : Array(PERFORMANCE_BUCKETS.length).fill(0);
 const value = e.durationMs;
 if (value !== undefined) h[PERFORMANCE_BUCKETS.findIndex(b => value <= b)]!++;
 db.prepare(`INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...key,(prior?.n ?? 0)+1,
  (prior?.timed ?? 0)+(value === undefined?0:1),(prior?.total ?? 0)+(value ?? 0),
  value === undefined ? prior?.lo ?? null : Math.min(prior?.lo ?? value,value),
  value === undefined ? prior?.hi ?? null : Math.max(prior?.hi ?? value,value),JSON.stringify(h));
 return true;
}
// Unfinished server observations from a previous process cannot resume its monotonic clock.
const now = Date.now(); clean(now);
for (const p of db.prepare("SELECT * FROM pending LIMIT 10000").all() as any[]) if(!aggregate({...p,stage:"missing",result:"process_restart"},now))throw new Error("Restart observation capacity exhausted");
db.exec("DELETE FROM pending; PRAGMA wal_checkpoint(TRUNCATE)");
parentPort!.on("message", (m: any) => {
 try {
  if(m.kind === "events") {
   const at=Date.now(); clean(at); const before={dropped,accepted,duplicates}; db.exec("BEGIN IMMEDIATE");
   try {
    for(const e of m.events) {
     if(db.prepare("SELECT 1 FROM seen WHERE id=?").get(e.id)) {duplicates++;health(e,at,"duplicates");continue;}
     if((db.prepare("SELECT count(*) AS n FROM seen").get() as any).n>=10000) {dropped++;health(e,at,"dropped");continue;}
     if(!aggregate(e,at)){health(e,at,"dropped");continue;}
     health(e,at,"accepted");
     db.prepare("INSERT INTO seen VALUES (?,?)").run(e.id,at); accepted++;
     if(e.stage==="logical_accepted") db.prepare("INSERT OR IGNORE INTO pending VALUES (?,?,?,?,?,?,?,?)").run(e.operation,e.account,e.scope,e.source,e.version,e.agent,e.kind,at);
     if(e.stage==="agent_first_output" || e.stage==="missing") db.prepare("DELETE FROM pending WHERE id=?").run(e.operation);
    }
    db.exec("COMMIT");
   }catch(error){db.exec("ROLLBACK");dropped=before.dropped;accepted=before.accepted;duplicates=before.duplicates;throw error;}
   db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
   parentPort!.postMessage({kind:"ack",count:m.events.length,accepted,dropped,duplicates},[]);
  } else if(m.kind === "heartbeat") {
   clean(Date.now()); db.prepare("INSERT OR REPLACE INTO coverage VALUES (?,?)").run(Math.floor(Date.now()/60000)*60000,m.version);
   db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } else if(m.kind === "report") {
   const rows = db.prepare("SELECT * FROM samples WHERE account=? AND bucket>=? AND bucket<? ORDER BY bucket LIMIT 30001").all(m.account,Math.floor(m.from/300000)*300000,m.to);
   const coverage = db.prepare("SELECT minute,version FROM coverage WHERE minute>=? AND minute<? ORDER BY minute LIMIT 10081").all(m.from,m.to);
   const healthRows=db.prepare("SELECT scope,sum(accepted) AS accepted,sum(dropped) AS dropped,sum(duplicates) AS duplicates FROM health WHERE account=? AND bucket>=? AND bucket<? GROUP BY scope LIMIT 30001").all(m.account,Math.floor(m.from/300000)*300000,m.to);
   const pending=db.prepare("SELECT scope,count(*) AS n FROM pending WHERE account=? GROUP BY scope LIMIT 10001").all(m.account);
   parentPort!.postMessage({kind:"report",request:m.request,rows,coverage,pending,health:healthRows,accepted,dropped,duplicates},[]);
  }
 }catch { parentPort!.postMessage({kind:"fault",request:m.request,count:m.events?.length ?? 0},[]); }
});
parentPort!.postMessage({kind:"ready"},[]);
