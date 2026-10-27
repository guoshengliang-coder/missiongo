import { z } from "zod";
import { INSIGHT_METRICS, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from "@missiongo/domain";

/** Shared filter validation at the MCP and browser entry points. */
export const insightInputSchema = z.object({
  productIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  period: z.enum(["yesterday", "today", "last7Days", "last30Days", "custom"]).default("yesterday"),
  startDate: z.string().optional(), endDate: z.string().optional(), timezone: z.string().max(100).default("Asia/Shanghai"),
  types: z.array(z.enum(WORK_ITEM_TYPES)).max(5).optional(), statuses: z.array(z.enum(WORK_ITEM_STATUSES)).max(8).optional(),
});
const csv = z.string().min(1).transform(s => s.split(","));
const browserFilters = z.object({
  productIds: csv.optional(), types: csv.optional(), statuses: csv.optional(),
  period: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), timezone: z.string().optional(),
});
export const browserInsightSchema = browserFilters.strict().pipe(insightInputSchema);
export const browserInsightDetailSchema = browserFilters.extend({
  metric: z.enum(INSIGHT_METRICS),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict().pipe(insightInputSchema.extend({metric:z.enum(INSIGHT_METRICS),limit:z.number().int().min(1).max(100),offset:z.number().int().min(0).max(1000000)}));
