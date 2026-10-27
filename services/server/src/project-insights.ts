import type { InsightQuery, InsightDay, InsightMetrics, InsightProject, InsightSummary, InsightItem, InsightDetails, InsightDetailSelection } from "@missiongo/domain";
import type { WorkItemStatus, WorkItemType } from "@missiongo/domain";
import { WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from "@missiongo/domain";
import type { SQLInputValue } from "node:sqlite";
import { invalidInput } from "./errors.js";
import type { MissionGoStore } from "./store.js";

export type { InsightQuery, InsightMetric } from "@missiongo/domain";
interface ItemRow { id: string; item_key: string; product_id: string; title: string; type: WorkItemType; status: WorkItemStatus; created_at: string }
interface EventRow { id: string; item_id: string; event_type: string; actor_kind: string; from_status: WorkItemStatus | null; to_status: WorkItemStatus | null; payload_json: string; created_at: string; timeline_seq: number }
interface Event extends EventRow { at: string; reason?: string | undefined; timeEstimated: boolean }
const open = (status: string) => !["done", "cancelled"].includes(status);
const countBy = <T extends string>(values: readonly T[]) => Object.fromEntries(values.map(v => [v, 0])) as Record<T, number>;

function dayAt(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
}
function midnight(day: string, timezone: string): string {
  const target = Date.parse(`${day}T00:00:00Z`);
  let value = target;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(new Date(value));
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    const shown = Date.parse(`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}Z`);
    const difference = target - shown;
    if (!difference) return new Date(value).toISOString();
    value += difference;
  }
  throw invalidInput("This timezone has no unambiguous midnight on the requested date.");
}
export function insightPeriod(query: InsightQuery, now = new Date()) {
  const timezone = query.timezone ?? "Asia/Shanghai";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now); }
  catch { throw invalidInput("Unknown timezone."); }
  const today = dayAt(now, timezone);
  const preset = query.period ?? "yesterday";
  if (preset !== "custom" && (query.startDate || query.endDate)) throw invalidInput("Explicit dates require period custom.");
  const endDate = preset === "custom" ? query.endDate! : preset === "yesterday" ? shiftDay(today, -1) : today;
  const startDate = preset === "custom" ? query.startDate! : preset === "last7Days" ? shiftDay(today, -6)
    : preset === "last30Days" ? shiftDay(today, -29) : endDate;
  if (!startDate || !endDate || !validDay(startDate) || !validDay(endDate) || startDate > endDate || endDate > today
    || Date.parse(endDate) - Date.parse(startDate) > 365 * 86_400_000) throw invalidInput("Use a valid date range of at most 366 days, ending no later than today.");
  return { startDate, endDate, timezone, start: midnight(startDate, timezone), endExclusive: midnight(shiftDay(endDate, 1), timezone), dataAsOf: now.toISOString() };
}
function durationStats(values: number[], eligible: number) {
  values.sort((a, b) => a - b);
  const quantile = (p: number) => {
    const position = (values.length - 1) * p;
    const low = Math.floor(position);
    return values[low]! + (values[Math.ceil(position)]! - values[low]!) * (position - low);
  };
  return { sampleCount: values.length, eligibleCount: eligible, missingCount: eligible - values.length,
    medianHours: values.length ? quantile(0.5) / 3_600_000 : null,
    p90Hours: values.length >= 10 ? quantile(0.9) / 3_600_000 : null, p90MinimumSamples: 10 };
}

/** Two bounded-by-permission queries, no comments/attachments or per-item API calls. */
export function projectInsights(store: MissionGoStore, productIds: string[], query?: InsightQuery, now?: Date): InsightSummary;
export function projectInsights(store: MissionGoStore, productIds: string[], query: InsightQuery, now: Date, detail: InsightDetailSelection): InsightDetails;
export function projectInsights(store: MissionGoStore, productIds: string[], query: InsightQuery = {}, now = new Date(), detail?: InsightDetailSelection): InsightSummary | InsightDetails {
  const period = insightPeriod(query, now);
  const products = [...new Set(productIds)].map(id => store.getProduct(id));
  const uniqueIds = [...new Set(products.map(p => p.id))];
  const marks = uniqueIds.map(() => "?").join(",");
  const parameters: SQLInputValue[] = [...uniqueIds];
  const items = uniqueIds.length ? store.database.connection.prepare(`SELECT id,item_key,product_id,title,type,status,created_at FROM work_items
    WHERE product_id IN (${marks}) AND NOT EXISTS (SELECT 1 FROM item_transfers t WHERE t.source_item_id = work_items.id) ORDER BY product_id,sequence DESC`).all(...parameters) as unknown as ItemRow[] : [];
  const events = uniqueIds.length ? store.database.connection.prepare(`SELECT e.* FROM work_item_events e JOIN work_items w ON w.id=e.item_id
    WHERE w.product_id IN (${marks}) AND e.history_source_key IS NULL AND e.event_type IN ('item_created','status_changed') ORDER BY e.item_id,e.timeline_seq`).all(...parameters) as unknown as EventRow[] : [];
  const byItem = new Map<string, Event[]>();
  let invalidEventCount = 0;
  for (const row of events) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json); if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(); }
    catch { invalidEventCount++; continue; }
    const occurredAt = payload.occurredAt;
    const valid = typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= Date.parse(row.created_at);
    const event: Event = { ...row, at: valid ? new Date(occurredAt).toISOString() : row.created_at,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      timeEstimated: row.event_type === "status_changed" && ["resolution_submitted", "release_verified"].includes(String(payload.reason)) && !valid };
    const list = byItem.get(row.item_id) ?? [];
    list.push(event); byItem.set(row.item_id, list);
  }
  const inPeriod = (at: string) => at >= period.start && at < period.endExclusive && at <= period.dataAsOf;
  const days: Array<{date: string; cutoff: string}> = [];
  if (query.includeTrend && !detail) {
    for (let date = period.startDate; date <= period.endDate; date = shiftDay(date, 1)) {
      days.push({date, cutoff: midnight(shiftDay(date, 1), period.timezone)});
    }
  }
  const allDelivery: number[] = [], allDevelopment: number[] = [];
  const result = products.map(product => {
    const createdByType = countBy(WORK_ITEM_TYPES);
    const currentByStatus = countBy(WORK_ITEM_STATUSES);
    const periodEndByStatus = countBy(WORK_ITEM_STATUSES);
    const counts = { created: 0, completed: 0, development_complete: 0, pending_verification: 0, returned: 0, reopened: 0, backlog: 0, stalled: 0, period_end_backlog: 0, repeat_returned: 0 };
    const delivery: number[] = []; const development: number[] = [];
    let developmentEligible = 0, passedRounds = 0, failedRounds = 0, unknownPeriodEnd = 0, estimatedEventTimes = 0, missingCreationEvents = 0;
    const trend: InsightDay[] = days.map(day => ({date: day.date, created: 0, completed: 0, backlog: 0, unknownStatusCount: 0}));
    const rows: InsightItem[] = [];
    for (const item of items.filter(i => i.product_id === product.id && (!query.types?.length || query.types.includes(i.type)) && (!query.statuses?.length || query.statuses.includes(i.status)))) {
      if (item.created_at > period.dataAsOf) continue;
      const history = (byItem.get(item.id) ?? []).filter(e => e.at <= period.dataAsOf)
        .sort((a,b) => a.at.localeCompare(b.at) || a.timeline_seq - b.timeline_seq);
      const statusEvents = history.filter(e => e.event_type === "status_changed");
      const creation = history.find(e => e.event_type === "item_created");
      if (!creation) missingCreationEvents++;
      currentByStatus[item.status]++;
      const beforeEnd = history.filter(e => e.at < period.endExclusive && e.at <= period.dataAsOf)
        .sort((a,b) => a.at.localeCompare(b.at) || a.timeline_seq - b.timeline_seq);
      const historical = beforeEnd.at(-1)?.to_status;
      if (item.created_at < period.endExclusive) {
        if (historical) periodEndByStatus[historical]++; else unknownPeriodEnd++;
      }
      const inWindow = statusEvents.filter(e => inPeriod(e.at));
      estimatedEventTimes += inWindow.filter(e => e.timeEstimated).length;
      const completed = inWindow.filter(e => e.to_status === "done" && e.actor_kind === "human");
      const dev = inWindow.filter(e => e.to_status === "development_complete");
      const verification = inWindow.filter(e => e.to_status === "pending_verification");
      const failed = inWindow.filter(e => e.from_status === "pending_verification" && e.to_status === "ready" && e.reason === "verification_failed" && e.actor_kind === "human");
      passedRounds += inWindow.filter(e => e.from_status === "pending_verification" && e.to_status === "done" && e.reason === "verification_passed" && e.actor_kind === "human").length;
      failedRounds += failed.length;
      const allReturns = statusEvents.filter(e => e.from_status === "pending_verification" && e.to_status === "ready" && e.reason === "verification_failed" && e.actor_kind === "human");
      const latest = statusEvents.at(-1) ?? creation;
      const ageHours = latest ? Math.max(0, (now.getTime() - Date.parse(latest.at)) / 3_600_000) : null;
      const flags = { created: inPeriod(item.created_at), completed: completed.length > 0, development_complete: dev.length > 0,
        pending_verification: verification.length > 0, returned: failed.length > 0,
        period_end_backlog: item.created_at < period.endExclusive && Boolean(historical && open(historical)),
        repeat_returned: failed.length >= 2,
        reopened: inWindow.some(e => e.from_status === "done" && e.to_status !== "done"),
        backlog: open(item.status), stalled: open(item.status) && ageHours !== null && ageHours >= 7 * 24 };
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) if (flags[key]) counts[key]++;
      if (flags.created) createdByType[item.type]++;
      const completedAt = completed.at(-1)?.at;
      if (completedAt && creation && Date.parse(completedAt) >= Date.parse(item.created_at)) delivery.push(Date.parse(completedAt) - Date.parse(item.created_at));
      let developmentHours: number | null = null;
      const devEnd = dev.at(-1);
      if (devEnd) {
        developmentEligible++;
        const before = statusEvents.filter(e => e.timeline_seq < devEnd.timeline_seq).sort((a,b) => a.timeline_seq - b.timeline_seq);
        const boundary = [...before].reverse().find(e => e.to_status === "ready" || e.to_status === "done" || e.to_status === "cancelled");
        const started = before.find(e => e.timeline_seq > (boundary?.timeline_seq ?? -1) && e.to_status === "in_progress");
        if (started && Date.parse(devEnd.at) >= Date.parse(started.at)) {
          developmentHours = (Date.parse(devEnd.at) - Date.parse(started.at)) / 3_600_000;
          development.push(developmentHours * 3_600_000);
        }
      }
      // A single traversal per item/day; no repeated database queries for charts.
      let historyIndex = 0;
      const completionDays = new Set(statusEvents.filter(e => e.to_status === "done" && e.actor_kind === "human" && inPeriod(e.at))
        .map(e => dayAt(new Date(e.at), period.timezone)));
      const creationDay = inPeriod(item.created_at) ? dayAt(new Date(item.created_at), period.timezone) : null;
      let dayStatus: WorkItemStatus | null = null;
      for (let index = 0; index < days.length; index++) {
        const day = days[index]!, point = trend[index]!;
        while (historyIndex < history.length && history[historyIndex]!.at < day.cutoff) dayStatus = history[historyIndex++]!.to_status;
        if (creationDay === day.date) point.created++;
        if (completionDays.has(day.date)) point.completed++;
        if (item.created_at < day.cutoff) {
          if (dayStatus) { if (open(dayStatus)) point.backlog++; }
          else point.unknownStatusCount++;
        }
      }
      if (!detail || flags[detail.metric]) rows.push({ productId: product.id, productName: product.name, itemKey: item.item_key, title: item.title, type: item.type, currentStatus: item.status,
        periodEndStatus: historical ?? null, createdAt: item.created_at, completedAt: completedAt ?? null,
        deliveryHours: completedAt && creation && completedAt >= item.created_at ? (Date.parse(completedAt) - Date.parse(item.created_at)) / 3_600_000 : null, developmentHours,
        stageSince: latest?.at ?? null, stageHours: ageHours, verificationFailuresInPeriod: failed.length,
        verificationFailuresTotal: allReturns.length, flags });
    }
    for (const value of delivery) allDelivery.push(value);
    for (const value of development) allDevelopment.push(value);
    return { productId: product.id, productName: product.name, counts, createdByType, currentByStatus, periodEndByStatus,
      ...(query.includeTrend && !detail ? {trend} : {}),
      verificationReturnRate: { failedRounds, passedRounds, decidedRounds: failedRounds + passedRounds,
        rate: failedRounds + passedRounds ? failedRounds / (failedRounds + passedRounds) : null },
      deliveryCycle: durationStats(delivery, counts.completed), developmentCycle: durationStats(development, developmentEligible),
      quality: { missingCreationEvents, unknownPeriodEnd, estimatedEventTimes }, rows };
  });
  const definitions = { completion: "Distinct items entering done by a human in the period; repeated completion counts once per item. Latest completion supplies cycle time.",
    cycle: "Calendar duration; queue/release/verification waiting included. Development cycle starts at the first in_progress of that processing round.",
    returnRate: "Failed / (passed + failed) human verification rounds decided in the period; pending and manual overrides excluded.",
    statusFilter: "Filters current status. periodEndByStatus is reconstructed separately from events.",
    stalled: "Open items in the same stage for at least 7 calendar days; unknown stage entry times are excluded.",
    trend: "Daily created/completed count distinct items within each day. An item completed on different days appears on each day; period completion totals deduplicate across the entire period. Backlog uses reconstructed day-end status, or dataAsOf for an unfinished day; unknown statuses are excluded and reported.",
    repeatReturns: "Items with at least two failed human verification rounds in the selected period; total historical failures are shown separately.",
    history: "Transferred source items and copied history excluded to avoid double counting; dimensions use current product/type. Missing historical times are not inferred from comments." };
  if (detail) {
    const rows = result.flatMap(p => p.rows);
    if (detail.metric === "stalled" || detail.metric === "backlog") rows.sort((a,b) => Number(b.stageHours ?? -1) - Number(a.stageHours ?? -1) || a.itemKey.localeCompare(b.itemKey));
    if (detail.metric === "repeat_returned" || detail.metric === "returned") rows.sort((a,b) => b.verificationFailuresInPeriod - a.verificationFailuresInPeriod || a.itemKey.localeCompare(b.itemKey));
    const limit = Math.max(1, Math.min(detail.limit ?? 50, 100)); const offset = Math.max(0, detail.offset ?? 0);
    return { period, definitions, metric: detail.metric, total: rows.length, items: rows.slice(offset, offset + limit),
      ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}), invalidEventCount };
  }
  const projects: InsightProject[] = result.map(({rows: _rows, ...summary}) => summary);
  const counts = {created:0,completed:0,development_complete:0,pending_verification:0,returned:0,reopened:0,backlog:0,stalled:0,period_end_backlog:0,repeat_returned:0};
  const aggregate: InsightMetrics = { counts, createdByType: countBy(WORK_ITEM_TYPES), currentByStatus: countBy(WORK_ITEM_STATUSES), periodEndByStatus: countBy(WORK_ITEM_STATUSES),
    verificationReturnRate: {failedRounds:0,passedRounds:0,decidedRounds:0,rate:null},
    deliveryCycle: durationStats(allDelivery, projects.reduce((n,p)=>n+p.counts.completed,0)),
    developmentCycle: durationStats(allDevelopment, projects.reduce((n,p)=>n+p.developmentCycle.eligibleCount,0)),
    quality: {missingCreationEvents:0,unknownPeriodEnd:0,estimatedEventTimes:0},
    ...(query.includeTrend ? {trend: days.map(day=>({date:day.date,created:0,completed:0,backlog:0,unknownStatusCount:0}))} : {}) };
  for (const project of projects) {
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += project.counts[key];
    for (const type of WORK_ITEM_TYPES) aggregate.createdByType[type] += project.createdByType[type];
    for (const status of WORK_ITEM_STATUSES) { aggregate.currentByStatus[status] += project.currentByStatus[status]; aggregate.periodEndByStatus[status] += project.periodEndByStatus[status]; }
    for (const key of ["missingCreationEvents","unknownPeriodEnd","estimatedEventTimes"] as const) aggregate.quality[key] += project.quality[key];
    aggregate.verificationReturnRate.failedRounds += project.verificationReturnRate.failedRounds;
    aggregate.verificationReturnRate.passedRounds += project.verificationReturnRate.passedRounds;
    project.trend?.forEach((point,index)=>{ const target=aggregate.trend![index]!; target.created+=point.created; target.completed+=point.completed; target.backlog+=point.backlog; target.unknownStatusCount+=point.unknownStatusCount; });
  }
  const rate=aggregate.verificationReturnRate;
  rate.decidedRounds=rate.failedRounds+rate.passedRounds; rate.rate=rate.decidedRounds ? rate.failedRounds/rate.decidedRounds : null;
  return { period, definitions, invalidEventCount, projects, aggregate };
}
