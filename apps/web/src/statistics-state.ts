import type { InsightMetric, InsightQuery } from "@missiongo/domain";
import { INSIGHT_METRICS } from "@missiongo/domain";
import { ITEM_TYPES, ITEM_STATUSES, type WorkItemType, type WorkItemStatus } from "./types";

export const STATISTICS_PERIODS = ["today","yesterday","last7Days","thisMonth","custom"] as const;
export interface StatisticsFilters { product: string; period: typeof STATISTICS_PERIODS[number]; type: WorkItemType | "all"; start: string; end: string }
export interface StatisticsSelection { metric: InsightMetric; product?: string | undefined; day?: string | undefined; endDay?: string | undefined; status?: WorkItemStatus | undefined; offset: number }
export const statisticsIsOpen = (url = new URL(window.location.href)) => url.searchParams.get("statistics") === "1";
export function statisticsUrl(url = new URL(window.location.href)) {
  const next = new URL(url); next.searchParams.set("statistics","1"); next.searchParams.delete("item");
  next.searchParams.delete("console"); next.searchParams.delete("session"); next.searchParams.delete("consoleFilter");
  return `${next.pathname}${next.search}${next.hash}`;
}
export function statisticsExitUrl(url = new URL(window.location.href)) {
  const next = new URL(url);
  for (const key of Array.from(next.searchParams.keys())) if (key === "statistics" || key.startsWith("stats")) next.searchParams.delete(key);
  return `${next.pathname}${next.search}${next.hash}`;
}
export function statisticsState(url = new URL(window.location.href)): {filters: StatisticsFilters; selection: StatisticsSelection | null} {
  const get = (name:string) => url.searchParams.get(`stats${name}`) ?? "";
  const period = STATISTICS_PERIODS.find(p=>p===get("Period")) ?? "last7Days";
  const type = ITEM_TYPES.find(p=>p===get("Type")) ?? "all";
  const metric = INSIGHT_METRICS.find(p=>p===get("Metric"));
  const offset = Number(get("Offset"));
  return {filters:{product:get("Project") || "all",period,type,start:get("Start"),end:get("End")},
    selection: metric ? {metric,product:get("DetailProject") || undefined,day:get("Day") || undefined,
      ...(get("EndDay") ? {endDay: get("EndDay")} : {}),
      status: ITEM_STATUSES.find(s=>s===get("Status")),offset:Number.isSafeInteger(offset)&&offset>=0&&offset<=1000000 ? offset : 0} : null};
}
export function statisticsStateUrl(filters: StatisticsFilters, selection: StatisticsSelection | null, url = new URL(window.location.href)) {
  const next = new URL(statisticsUrl(url),url);
  for(const key of Array.from(next.searchParams.keys())) if(key.startsWith("stats")) next.searchParams.delete(key);
  const values = {Project:filters.product,Period:filters.period,Type:filters.type,
    Start:filters.period==="custom" ? filters.start : "",End:filters.period==="custom" ? filters.end : "",
    Metric:selection?.metric,DetailProject:selection?.product,Day:selection?.day,EndDay:selection?.endDay,Status:selection?.status,Offset:selection?.offset};
  for (const [key,value] of Object.entries(values)) if(value!==undefined && value!=="") next.searchParams.set(`stats${key}`,String(value));
  return `${next.pathname}${next.search}${next.hash}`;
}
export function statisticsToday(now = new Date()) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const get=(name:string)=>parts.find(p=>p.type===name)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function statisticsQuery(filters:StatisticsFilters,now=new Date()):InsightQuery & {productIds?:string[]} {
  const today=statisticsToday(now);
  return {...(filters.product!=="all" ? {productIds:[filters.product]} : {}),timezone:"Asia/Shanghai",
    ...(filters.type!=="all" ? {types:[filters.type]} : {}),
    ...(filters.period==="custom" ? {period:"custom",startDate:filters.start,endDate:filters.end}
      : filters.period==="thisMonth" ? {period:"custom",startDate:`${today.slice(0,7)}-01`,endDate:today} : {period:filters.period})};
}
export function statisticsDatesValid(filters:StatisticsFilters,now=new Date()):boolean {
  if(filters.period!=="custom") return true;
  const valid=(s:string)=> /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
  return valid(filters.start)&&valid(filters.end)&&filters.start<=filters.end&&filters.end<=statisticsToday(now)
    && Date.parse(filters.end)-Date.parse(filters.start)<=365*86400000;
}
