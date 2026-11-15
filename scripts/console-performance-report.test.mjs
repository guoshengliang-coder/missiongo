import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPerformanceReport } from "./console-performance-report.mjs";
test("report preserves insufficient samples, production gaps and model/clock boundaries",()=>{
 const text=renderPerformanceReport({source:"synthetic",rows:[{stage:"submit",n:11,timed:11,source:"web",version:"fixture",result:"success"}],coverage:[],gapMinutes:1440});
 assert.match(text,/不足100/);assert.match(text,/synthetic/);assert.match(text,/不同设备时钟不相减/);assert.match(text,/尚未满足/);assert.match(text,/模型内部耗时不可观测/);
});
test("report rejects unbounded or malformed input",()=>assert.throws(()=>renderPerformanceReport({rows:[]})));
test("list report distinguishes visit, request and completed-visit distributions, and never fills unknown with zero",()=>{
 const dimensions={protocol:1,device:"phone",scenario:"cache_return",dataset:"account_feed",load:"51-200"};
 const text=renderPerformanceReport({source:"synthetic",coverage:[],rows:[{dimensions,stage:"list_visit",n:2,timed:0},{dimensions,stage:"list_request",n:5,timed:5},{dimensions,stage:"list_visit_end",n:1,timed:1,measures:{requests:{n:1,lo:3,hi:3}}}]});
 assert.match(text,/观测访问开始 2/);assert.match(text,/浏览器请求 5/);assert.match(text,/未知/);assert.match(text,/no_refresh/);assert.match(text,/不足100/);assert.match(text,/不能用差值声称精确丢失/);
});
