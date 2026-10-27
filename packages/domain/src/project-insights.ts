import type { WorkItemStatus, WorkItemType } from "./work-item.js";

export interface InsightQuery {
  period?: "yesterday" | "today" | "last7Days" | "last30Days" | "custom";
  startDate?: string | undefined;
  endDate?: string | undefined;
  timezone?: string;
  types?: WorkItemType[] | undefined;
  statuses?: WorkItemStatus[] | undefined;
  includeTrend?: boolean;
}
export const INSIGHT_METRICS = ["created", "completed", "development_complete", "pending_verification", "returned", "backlog", "stalled", "period_end_backlog", "repeat_returned"] as const;
export type InsightMetric = typeof INSIGHT_METRICS[number];
export interface InsightPeriod {
  startDate: string; endDate: string; timezone: string; start: string; endExclusive: string; dataAsOf: string;
}
export interface InsightDuration {
  sampleCount: number; eligibleCount: number; missingCount: number; medianHours: number | null;
  p90Hours: number | null; p90MinimumSamples: number;
}
export interface InsightDay {
  date: string; created: number; completed: number; backlog: number; unknownStatusCount: number;
}
export interface InsightMetrics {
  counts: Record<InsightMetric | "reopened", number>;
  createdByType: Record<WorkItemType, number>;
  currentByStatus: Record<WorkItemStatus, number>;
  periodEndByStatus: Record<WorkItemStatus, number>;
  verificationReturnRate: { failedRounds: number; passedRounds: number; decidedRounds: number; rate: number | null };
  deliveryCycle: InsightDuration; developmentCycle: InsightDuration;
  quality: { missingCreationEvents: number; unknownPeriodEnd: number; estimatedEventTimes: number };
  trend?: InsightDay[];
}
export interface InsightProject extends InsightMetrics { productId: string; productName: string }
export interface InsightSummary {
  period: InsightPeriod; definitions: Record<string, string>; invalidEventCount: number;
  projects: InsightProject[]; aggregate: InsightMetrics;
}
export interface InsightItem {
  productId: string; productName: string; itemKey: string; title: string; type: WorkItemType;
  currentStatus: WorkItemStatus; periodEndStatus: WorkItemStatus | null; createdAt: string; completedAt: string | null;
  deliveryHours: number | null; developmentHours: number | null; stageSince: string | null; stageHours: number | null;
  verificationFailuresInPeriod: number; verificationFailuresTotal: number;
  flags: Record<InsightMetric | "reopened", boolean>;
}
export interface InsightDetails {
  period: InsightPeriod; definitions: Record<string, string>; invalidEventCount: number;
  metric: InsightMetric; total: number; items: InsightItem[]; nextOffset?: number;
}
export interface InsightDetailSelection { metric: InsightMetric; limit?: number; offset?: number }
