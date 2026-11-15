import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsolePerformance } from "./console-performance.js";
import { validListObservation, validPerformanceEvent, type ListObservation } from "@missiongo/domain";
const instances:ConsolePerformance[]=[],dirs:string[]=[];
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.close()));await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(path=":memory:"){const m=new ConsolePerformance(path,"test",true);instances.push(m);await expect.poll(()=>m.status().ready).toBe(true);return m;}
const list:ListObservation={protocol:1,device:"phone",scenario:"cache_return",dataset:"account_feed",visitId:"ephemeral-visit",rows:200};
const event={id:"event",stage:"list_visit" as const,result:"success" as const,list,scope:{account:"owner",products:[]},source:"web" as const,version:"v1"};
const report=(m:ConsolePerformance,account="owner",allows=(_p:string[])=>true)=>m.report(account,allows,Date.now()-60000,Date.now()+1) as Promise<any>;
it("counts one observed visit despite different retry ids; request counts do not become visits",async()=>{
 const m=await fixture();m.record(event);m.record({...event,id:"retry-event"});
 for(let i=0;i<3;i++)m.record({...event,id:`request-${i}`,stage:"list_request",durationMs:10+i});
 m.record({...event,id:"end",stage:"list_visit_end",list:{...list,requests:3,refreshes:3}});
 const r=await report(m);expect(r.rows.find((r:any)=>r.stage==="list_visit").n).toBe(1);
 expect(r.rows.find((r:any)=>r.stage==="list_request").n).toBe(3);
 expect(r.rows.find((r:any)=>r.stage==="list_visit_end").measures.requests.total).toBe(3);
 expect(JSON.stringify(r)).not.toContain("ephemeral-visit");expect(JSON.stringify(r)).not.toContain("request-0");
 expect((await report(m,"other")).rows).toEqual([]);
});
it("retains legacy unknown dimensions and separates device, scenario, version, source and permission scopes",async()=>{
 const m=await fixture();m.record({...event,id:"phone"});
 m.record({...event,id:"pc",list:{...list,device:"pc",visitId:"pc-visit"}});
 m.record({...event,id:"resume",list:{...list,scenario:"background_resume",visitId:"resume-visit"}});
 m.record({...event,id:"version",version:"v2",list:{...list,visitId:"v2-visit"}});
 m.record({...event,id:"restricted",scope:{account:"owner",products:["restricted"]},list:{...list,dataset:"project_view"},stage:"list_view"});
 m.record({id:"old",scope:{account:"owner",products:[]},source:"server",version:"old",stage:"list_read",result:"success",durationMs:1});
 const r=await report(m,"owner",p=>!p.includes("restricted"));expect(r.rows).toHaveLength(5);
 expect(r.rows.find((r:any)=>r.stage==="list_read").dimensions.device).toBe("unknown");
 expect(r.rows.filter((r:any)=>r.stage==="list_visit").every((r:any)=>r.n===1)).toBe(true);
});
it("merges bounded load measures and withholds small-sample P95; persists and expires v2 independently of legacy schema",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"and528-"));dirs.push(dir);const path=join(dir,"metrics.sqlite"),m=await fixture(path);
 for(let i=0;i<100;i++)m.record({...event,id:`sample-${i}`,stage:"list_request",durationMs:i+1,list:{...list,responseBytes:4096,transferBytes:1024}});
 const r=await report(m),row=r.rows[0];expect(row.n).toBe(100);expect(row.measures.responseBytes.total).toBe(409600);expect(row.p95UpperBoundMs).toBe(256);
 await m.close();const next=await fixture(path);expect((await report(next)).rows[0].n).toBe(100);await next.close();
 const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(path);db.prepare("UPDATE list_samples SET bucket=?").run(Date.now()-8*86400000);db.close();
 const expired=await fixture(path);expect((await report(expired)).rows).toEqual([]);
});
it("rejects arbitrary data and numeric cardinality attacks before queueing",async()=>{
 for(const patch of [{userAgent:"full UA"},{device:"watch"},{rows:-1},{responseBytes:67108865},{requests:1.5},{visitId:"/private/path"}])expect(validListObservation({...list,...patch})).toBe(false);
 expect(validPerformanceEvent({id:"id",stage:"list_visit",result:"success"})).toBe(false);
 expect(validPerformanceEvent({id:"id",stage:"submit",result:"success",list})).toBe(false);
 const m=await fixture();expect(m.record({...event,list:{...list,rows:Infinity}})).toBe(false);
});
