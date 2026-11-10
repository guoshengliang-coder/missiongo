import { expect,it } from "vitest";
import { mergeProgressReports } from "./agent-progress-history";
const report=(n:number)=>({id:`report-${n}`,text:`Report ${n}`,occurredAt:"2026-11-10T00:00:00.000Z"});
const range=(start:number,end:number)=>Array.from({length:end-start+1},(_,n)=>report(start+n));
it("keeps cached older prefixes in place after live overlap and repeated older-page reads",()=>{
  let reports=mergeProgressReports(range(90,99),range(80,89),"report-90");
  reports=mergeProgressReports(reports,range(91,100));
  reports=mergeProgressReports(reports,range(81,90),"report-91");
  expect(reports).toEqual(range(80,100));
});
it("inserts missing ranges before their server anchor, including partial overlaps and gaps",()=>{
  expect(mergeProgressReports(range(94,100),range(80,93),"report-94")).toEqual(range(80,100));
  expect(mergeProgressReports(range(90,100),range(80,94),"report-95")).toEqual(range(80,100));
  const gap=[...range(70,79),...range(90,100)];
  expect(mergeProgressReports(gap,range(80,94),"report-95")).toEqual(range(70,100));
});
it("updates incoming content once without replacing tie order with a fabricated timestamp sort",()=>{
  const update={...report(2),text:"Source update"};
  expect(mergeProgressReports(range(1,3),[update,report(3),report(4)])).toEqual([report(1),update,report(3),report(4)]);
  expect(mergeProgressReports([],range(1,3))).toEqual(range(1,3));
});
