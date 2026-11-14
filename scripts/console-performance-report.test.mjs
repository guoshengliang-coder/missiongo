import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPerformanceReport } from "./console-performance-report.mjs";
test("report preserves insufficient samples, production gaps and model/clock boundaries",()=>{
 const text=renderPerformanceReport({source:"synthetic",rows:[{stage:"submit",n:11,timed:11,source:"web",version:"fixture",result:"success"}],coverage:[],gapMinutes:1440});
 assert.match(text,/不足100/);assert.match(text,/synthetic/);assert.match(text,/不同设备时钟不相减/);assert.match(text,/尚未满足/);assert.match(text,/模型内部耗时不可观测/);
});
test("report rejects unbounded or malformed input",()=>assert.throws(()=>renderPerformanceReport({rows:[]})));
