import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntegrationPrerequisite, IntegrationPrerequisites, IntegrationPrerequisiteGate, MergeIntegration } from "@missiongo/contracts";
import { conflict } from "./errors.js";

const text = z.string().trim().min(1).max(4000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const core = ["main", "installation_integrity", "required_capability", "authorization", "scope"] as const;
const minimum: Partial<Record<IntegrationPrerequisite["kind"], IntegrationPrerequisite["dependencies"]>> = {
  main: ["base", "heads"], installation_integrity: ["tools"], required_capability: ["tools", "capabilities"],
  authorization: ["scope", "tools", "capabilities"], scope: ["scope", "candidates"],
};
const condition = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/),
  kind: z.enum([...core, "investigation", "tool_difference", "version", "build", "artifact", "release_notes"]),
  category: z.enum(["blocker", "fact", "work", "notice"]), stage: z.enum(["pre_merge", "post_merge", "pre_publish"]),
  required: z.boolean(), state: z.enum(["satisfied", "pending", "unknown", "not_required"]),
  reason: text, owner: text, resumeWhen: text,
  dependencies: z.array(z.enum(["base", "heads", "scope", "candidates", "tools", "capabilities"])).min(1).max(6),
  dependsOnDeliveries: z.array(z.object({deliveryId:z.string().min(1).max(200),head:sha}).strict()).max(20).optional(),
  authorizationRef: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message:string) => ctx.addIssue({code:"custom",message});
  if (new Set(value.dependencies).size !== value.dependencies.length) invalid("Duplicate evidence dependencies");
  if (core.includes(value.kind as typeof core[number])) {
    if (!value.required || value.stage !== "pre_merge" || !["blocker","fact"].includes(value.category)) invalid("Necessary prerequisites cannot be downgraded");
    if (minimum[value.kind]!.some(key => !value.dependencies.includes(key))) invalid("Missing necessary evidence dependency");
    if (value.kind !== "authorization" && value.state === "not_required") invalid("Necessary evidence cannot be skipped");
  }
  if (value.required && value.stage === "pre_merge" && ["work","notice"].includes(value.category)) invalid("A required pre-merge fact must remain a gate");
  if (value.required && value.stage === "pre_merge" && value.kind !== "authorization" && value.state === "not_required") invalid("A necessary fact cannot be skipped");
  if (value.kind === "tool_difference" && value.required) invalid("Ordinary source differences are not necessary blockers");
  if (["version","build","artifact","release_notes"].includes(value.kind) && value.stage === "pre_merge") invalid("Post-merge work cannot become a first-merge prerequisite");
  if (value.kind === "authorization" && ["satisfied","not_required"].includes(value.state) && !value.authorizationRef) invalid("Reference the original permission evidence, or the verified reason no mutation requires it");
});
export const prerequisitesActionSchema = z.object({
  kind: z.literal("prerequisites"), checkedAt: z.string().datetime(), source: text,
  context: z.object({base:sha,candidates:digest,tools:digest,capabilities:digest}).strict(),
  // Partial refresh: omitted conditions retain their original evidence bindings.
  conditions: z.array(condition).min(1).max(50),
}).strict();
export type PrerequisitesAction = z.infer<typeof prerequisitesActionSchema>;
export interface PrerequisiteBatch {
  publish: boolean; state?:string; operation?: string; selection: {id:string;revision:string}[];
  publicationScope?: {digest:string} | undefined; references?: Record<string,unknown>;
  deliveries: string[]; integration?: MergeIntegration;
  results: Record<string,{status:string;head:string}>;
}
const denied = (message:string):never => { throw conflict("merge_prerequisites_changed",message); };
function bindings(batch:PrerequisiteBatch, context:IntegrationPrerequisites["context"]) {
  // No progress, event, timestamp or integration revision in the content scope.
  return {...context,scope:hash([batch.selection,batch.operation??null,batch.publish,batch.publicationScope?.digest??null]),
    heads:hash(batch.deliveries.map(id=>[id,batch.integration?.entries[id]?.head??batch.results[id]?.head]))};
}
export function recordPrerequisites(batch:PrerequisiteBatch, action:PrerequisitesAction) {
  const state=batch.integration!;
  const age=Date.now()-Date.parse(action.checkedAt);
  if(age < -30_000 || age > 300_000)denied("前置检查时间已过期，请读取实际结果。");
  const previous=state.prerequisites?.conditions??[], conditions=new Map(previous.map(c=>[c.id,c]));
  const values=bindings(batch,action.context);
  if(new Set(action.conditions.map(c=>c.id)).size!==action.conditions.length)denied("前置条件不能重复。");
  for(const c of action.conditions) {
    const old=conditions.get(c.id);
    if(old && old.kind!==c.kind)denied("不能用其他类别覆盖原等待原因。");
    if(c.dependsOnDeliveries?.some(d=>!batch.deliveries.includes(d.deliveryId)||state.entries[d.deliveryId]?.head!==d.head))denied("前置依赖的交付或提交已变化。");
    conditions.set(c.id,{...c,checkedAt:action.checkedAt,source:action.source,
      binding:Object.fromEntries(c.dependencies.map(key=>[key,values[key]]))});
  }
  if(conditions.size>50 || core.some(kind=>[...conditions.values()].filter(c=>c.kind===kind).length>1))denied("前置条件过多或必要条件重复。");
  state.prerequisites={context:action.context,conditions:[...conditions.values()]};
}
export function prerequisiteGate(batch:PrerequisiteBatch, hasRelease:boolean, base?:string, now=Date.now()):IntegrationPrerequisiteGate {
  const required=batch.state!=="finished" && batch.deliveries.some(id=>!batch.references?.[id]&&!batch.results[id])
    && batch.publish && batch.operation!=="merge_only" && batch.operation!=="publish_only" && hasRelease;
  const gate:IntegrationPrerequisiteGate={required,ready:true,blockers:[]};
  if(!required)return gate;
  const record=batch.integration?.prerequisites, conditions=record?.conditions??[];
  const names={main:"当前主线",installation_integrity:"工具安装完整性",required_capability:"必需能力",authorization:"原生授权依据",scope:"发布范围"};
  const missing=core.filter(kind=>!conditions.some(c=>c.kind===kind));
  if(missing.length)gate.blockers.push({id:"required_evidence",code:"missing",reason:`尚未核实：${missing.map(kind=>names[kind]).join("、")}`,owner:"集成执行者",resumeWhen:"在原批次核实并登记必要前置条件"});
  if(record) {
    const values=bindings(batch,{...record.context,...(base?{base}:{})});
    for(const c of conditions.filter(c=>c.stage==="pre_merge" && c.required)) {
      const age=now-Date.parse(c.checkedAt);
      const cycle=c.dependsOnDeliveries?.some(d=>batch.results[d.deliveryId]?.status!=="merged");
      const stale=!Number.isFinite(age)||age < -30_000||age>300_000||c.dependencies.some(key=>c.binding[key]!==values[key])
        || c.dependsOnDeliveries?.some(d=>batch.integration?.entries[d.deliveryId]?.head!==d.head);
      const code=cycle?"cycle":stale?"stale":!["satisfied","not_required"].includes(c.state)?"pending":undefined;
      if(code)gate.blockers.push({id:c.id,code,reason:c.reason,owner:c.owner,resumeWhen:c.resumeWhen});
    }
  }
  gate.ready=gate.blockers.length===0;
  return gate;
}
