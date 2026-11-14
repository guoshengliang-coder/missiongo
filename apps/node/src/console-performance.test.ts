import { expect, it, vi } from "vitest";
import { NativePerformance, NativePerformanceUploader } from "./console-performance.js";
it("only the exact bound turn completes output, and completed snapshots do not repeat",()=>{
 const p=new NativePerformance();p.begin("command");p.delivered("command","new");
 expect(p.reports({messages:[{sourceId:"old",role:"agent",text:"secret",turnId:"old"}]}).flatMap(r=>r.events).some(e=>e.stage==="agent_first_output")).toBe(false);
 const reports=p.reports({messages:[{sourceId:"new",role:"agent",text:"secret",turnId:"new"}]});
 expect(reports.flatMap(r=>r.events).some(e=>e.stage==="agent_first_output")).toBe(true);
 expect(JSON.stringify(reports)).not.toContain("secret");expect(p.reports({messages:[]})).toEqual([]);
});
it("a missing turn binding reports missing instead of guessing from text",()=>{
 const p=new NativePerformance();p.begin("command");p.delivered("command");
 expect(p.reports({messages:[{sourceId:"new",role:"agent",text:"same text"}]})[0]?.events).toContainEqual({id:"command:binding",stage:"missing",result:"uncorrelated"});
});
it("upload requests run on one bounded lane and retries have a fixed limit",async()=>{
 const send=vi.fn().mockRejectedValue(new Error("offline")),uploader=new NativePerformanceUploader(send);
 uploader.enqueue("session",{commandId:"command",events:[]});
 await new Promise(r=>setTimeout(r,10));expect(send).toHaveBeenCalledTimes(3);
});
it("a delivered command awaiting output emits its delivery sample only once",()=>{
 const p=new NativePerformance();p.begin("command");p.delivered("command","turn");
 expect(p.reports({messages:[]})[0]?.events).toHaveLength(1);
 expect(p.reports({messages:[]})).toEqual([]);
});
it("native delivery failures release bounded tracking capacity immediately",()=>{
 const p=new NativePerformance();let reports=0;
 for(let i=0;i<300;i++){p.begin(`failed-${i}`);p.failed(`failed-${i}`);reports+=p.reports({messages:[]}).length;}
 expect(reports).toBe(300);
});
