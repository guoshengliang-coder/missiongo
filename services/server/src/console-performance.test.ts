import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsolePerformance } from "./console-performance.js";
const instances:ConsolePerformance[]=[],dirs:string[]=[];
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.close()));await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(path=":memory:"){const m=new ConsolePerformance(path,"test-build",true);instances.push(m);for(let i=0;i<100&&!m.status().ready&&!m.status().degraded;i++)await new Promise(r=>setTimeout(r,20));expect(m.status().ready).toBe(true);return m;}
const scope={account:"owner",products:["product"]};
it("persists deduplicated content-free aggregates across restart; enforces account and product scope",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"and518-"));dirs.push(dir);const path=join(dir,"metrics.sqlite"),m=await fixture(path);
 const event={id:"same-event",scope,source:"web" as const,version:"v1",stage:"submit" as const,result:"success" as const,durationMs:27};
 m.record(event);m.record(event);
 const report:any=await m.report("owner",p=>p.includes("product"),Date.now()-60000,Date.now()+1);
 expect(report.rows).toHaveLength(1);expect(report.rows[0].n).toBe(1);expect(report.rows[0].p95UpperBoundMs).toBeNull();expect(report.rows[0].p50UpperBoundMs).toBe(64);
 expect((await m.report("other",()=>true,Date.now()-60000,Date.now()+1) as any).rows).toEqual([]);
 expect((await m.report("owner",()=>false,Date.now()-60000,Date.now()+1) as any).rows).toEqual([]);
 expect(JSON.stringify(report)).not.toContain("same-event");expect(JSON.stringify(report)).not.toContain('"account"');
 await m.close();const restarted=await fixture(path);
 expect((await restarted.report("owner",()=>true,Date.now()-60000,Date.now()+1) as any).rows[0].n).toBe(1);
});
it("bounds the request-side queue and does not wait for storage on recording",async()=>{
 const m=await fixture();let rejected=0;for(let i=0;i<2100;i++)if(!m.record({id:`event-${i}`,scope,source:"server",version:"v1",stage:"http_attempt",result:"success"}))rejected++;
 expect(rejected).toBeGreaterThan(0);expect(m.status().queued).toBeLessThanOrEqual(2048);
});
it("a failed collector remains fail-open and returns an explicitly incomplete report",async()=>{
 const m=new ConsolePerformance("/dev/null/unwritable.sqlite","v1",true);instances.push(m);
 await new Promise(r=>setTimeout(r,150));expect(m.record({id:"failed",scope,source:"server",version:"v1",stage:"submit",result:"success"})).toBe(false);
 const result:any=await m.report("owner",()=>true,0,1);expect(result.complete).toBe(false);expect(result.status.degraded).toBe(true);
});
it("restarts classify unfinished observations as missing, rather than resuming another monotonic clock",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"and518-restart-"));dirs.push(dir);const path=join(dir,"metrics.sqlite"),m=await fixture(path);
 m.record({id:"accepted-1",operation:"command-1",scope,source:"server",version:"v1",stage:"logical_accepted",result:"success"});
 await m.close();const next=await fixture(path),r:any=await next.report("owner",()=>true,Date.now()-60000,Date.now()+1);
 expect(r.rows).toEqual(expect.arrayContaining([expect.objectContaining({stage:"missing",result:"process_restart",timed:0})]));
 expect(r.pendingObservations).toBe(0);
});
it("disk budget rejects further collection instead of blocking business; on-disk files remain bounded",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"and518-cap-"));dirs.push(dir);const path=join(dir,"metrics.sqlite"),budget=256*1024;
 const m=new ConsolePerformance(path,"v1",true,budget);instances.push(m);
 for(let i=0;i<100&&!m.status().ready&&!m.status().degraded;i++)await new Promise(r=>setTimeout(r,10));
 for(let i=0;i<2500&&!m.status().degraded;i++){
  m.record({id:`capacity-${i}`,scope,source:"web",version:`version-${i}`,stage:"submit",result:"success",durationMs:1});
  if(i%16===0)await new Promise(r=>setTimeout(r,5));
 }
 for(let i=0;i<100&&!m.status().degraded;i++)await new Promise(r=>setTimeout(r,10));
 expect(m.status().degraded).toBe(true);
 await m.close();
 const { readdir,stat }=await import("node:fs/promises");let bytes=0;for(const name of await readdir(dir))bytes+=(await stat(join(dir,name))).size;
 expect(bytes).toBeLessThanOrEqual(budget);
});
it("removes expired seven-day aggregates and permits expired event IDs again",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"and518-retention-"));dirs.push(dir);const path=join(dir,"metrics.sqlite"),m=await fixture(path);
 const event={id:"retained-event",scope,source:"web" as const,version:"v1",stage:"submit" as const,result:"success" as const,durationMs:12};
 m.record(event);await m.close();
 const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(path),old=Date.now()-8*86400000;
 db.prepare("UPDATE samples SET bucket=?").run(old);db.prepare("UPDATE seen SET at=?").run(old);db.prepare("UPDATE health SET bucket=?").run(old);db.close();
 const reopened=await fixture(path);expect((await reopened.report("owner",()=>true,Date.now()-60000,Date.now()+1) as any).rows).toEqual([]);
 reopened.record(event);expect((await reopened.report("owner",()=>true,Date.now()-60000,Date.now()+1) as any).rows[0].n).toBe(1);
});
it("P95 requires 100 timed samples in identical dimensions and never mixes versions",async()=>{
 const m=await fixture();for(let i=0;i<100;i++)m.record({id:`percentile-${i}`,scope,source:"web",version:i<50?"old":"new",stage:"submit",result:"success",durationMs:30});
 let r:any=await m.report("owner",()=>true,Date.now()-60000,Date.now()+1);expect(r.rows).toHaveLength(2);expect(r.rows.every((x:any)=>x.p95UpperBoundMs===null)).toBe(true);
 for(let i=100;i<150;i++)m.record({id:`percentile-${i}`,scope,source:"web",version:"new",stage:"submit",result:"success",durationMs:30});
 r=await m.report("owner",()=>true,Date.now()-60000,Date.now()+1);expect(r.rows.find((x:any)=>x.version==="new").p95UpperBoundMs).toBe(64);expect(r.rows.find((x:any)=>x.version==="old").p95UpperBoundMs).toBeNull();
});
