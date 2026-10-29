import {describe,it,expect} from "vitest";
import {backDepthFromState,STATISTICS_HISTORY_MARKER,ITEM_HISTORY_MARKER,itemDetailUrl} from "./navigation";
import {statisticsState,statisticsStateUrl,statisticsUrl,statisticsExitUrl,statisticsQuery,statisticsDatesValid} from "./statistics-state";
const now=new Date("2026-10-31T17:00:00Z");
describe("statistics navigation and filters",()=>{
 it("retains an explicitly selected batch when report filters change and removes it on exit",()=>{
  const base=new URL("https://example.test/?statistics=1&statsBatch=batch-one");
  const filters={product:"all",period:"thisMonth" as const,type:"all" as const,start:"",end:""};
  const next=new URL(statisticsStateUrl(filters,null,base),base);
  expect(next.searchParams.get("statsBatch")).toBe("batch-one");
  expect(statisticsExitUrl(next)).toBe("/");
 });
 it("preserves list context, filters and metric detail across item visits and reloads",()=>{
  const base=new URL("https://example.test/?product=one&status=all&type=bug&q=slow#workspace");
  const filters={product:"two",period:"custom" as const,type:"task" as const,start:"2026-10-01",end:"2026-10-26"};
  const selection={metric:"period_end_backlog" as const,product:"two",day:"2026-10-23",offset:25};
  const stats=new URL(statisticsStateUrl(filters,selection,base),base);
  expect(statisticsState(stats)).toEqual({filters,selection:{...selection,status:undefined}});
  const detail=new URL(itemDetailUrl("TWO-42",stats),base);detail.searchParams.delete("item");
  expect(statisticsState(detail)).toEqual(statisticsState(stats));
  expect(statisticsExitUrl(stats)).toBe("/?product=one&status=all&type=bug&q=slow#workspace");
  expect(backDepthFromState({[STATISTICS_HISTORY_MARKER]:true,[ITEM_HISTORY_MARKER]:true})).toBe(2);
 });
 it("drops other full-page parameters on entry and removes every adjacent stats key on exit",()=>{
  const base=new URL("https://example.test/?console=agent&session=x&item=ONE-1&statsProject=two&statsPeriod=custom&statsStart=2026-01-01&statsEnd=2026-01-31");
  expect(statisticsUrl(base)).not.toMatch(/console=|session=|item=/);
  expect(statisticsExitUrl(base)).toBe("/?console=agent&session=x&item=ONE-1");
 });
 it("restores a weekly delivery range and the first-delivery cycle detail",()=>{
  const base=new URL("https://example.test/?statistics=1");
  const filters={product:"all",period:"thisMonth" as const,type:"all" as const,start:"",end:""};
  const selection={metric:"pending_verification" as const,day:"2026-10-19",endDay:"2026-10-25",offset:0};
  const restored=statisticsState(new URL(statisticsStateUrl(filters,selection,base),base));
  expect(restored.selection).toMatchObject(selection);
  expect(statisticsState(new URL("https://example.test/?statistics=1&statsMetric=started_to_delivery")).selection?.metric).toBe("started_to_delivery");
 });
 it("uses the Beijing calendar for this month and validates custom dates without silent normalization",()=>{
  const base={product:"all",period:"thisMonth" as const,type:"all" as const,start:"",end:""};
  expect(statisticsQuery(base,now)).toMatchObject({period:"custom",startDate:"2026-11-01",endDate:"2026-11-01",timezone:"Asia/Shanghai"});
  for(const [start,end] of [["2026-02-30","2026-03-01"],["2026-10-28","2026-10-27"],["2026-01-01","2026-11-02"],["2024-01-01","2026-11-01"]])expect(statisticsDatesValid({...base,period:"custom",start:start!,end:end!},now)).toBe(false);
  expect(statisticsDatesValid({...base,period:"custom",start:"2026-10-01",end:"2026-10-31"},now)).toBe(true);
 });
});
