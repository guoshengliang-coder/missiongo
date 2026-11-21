import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntegrationPrerequisite, IntegrationPrerequisites, IntegrationPrerequisiteGate, MergeIntegration } from "@missiongo/contracts";
import { conflict } from "./errors.js";
import { batchPublicationDeferred } from "./merge-reconciliation.js";
import type { MergeReconciliationState } from "@missiongo/contracts";

const text = z.string().trim().min(1).max(4000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const core = ["main", "installation_integrity", "required_capability", "authorization", "scope"] as const;
const minimum: Partial<Record<IntegrationPrerequisite["kind"], IntegrationPrerequisite["dependencies"]>> = {
  main: ["base", "heads"], installation_integrity: ["tools"], required_capability: ["tools", "capabilities"],
  authorization: ["scope", "tools", "capabilities"], scope: ["scope", "candidates"],
};
const conditionShape = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/),
  kind: z.enum([...core, "investigation", "tool_difference", "version", "build", "artifact", "release_notes"]),
  category: z.enum(["blocker", "fact", "work", "notice"]), stage: z.enum(["pre_merge", "post_merge", "pre_publish"]),
  required: z.boolean(), state: z.enum(["satisfied", "pending", "unknown", "not_required"]),
  reason: text, owner: text, resumeWhen: text,
  dependencies: z.array(z.enum(["base", "heads", "scope", "candidates", "tools", "capabilities"])).min(1).max(6),
  dependsOnDeliveries: z.array(z.object({deliveryId:z.string().min(1).max(200),head:sha}).strict()).max(20).optional(),
  authorizationRef: z.string().trim().min(1).max(1000).optional(),
};
const condition = z.object(conditionShape).strict().superRefine((value, ctx) => {
  const invalid = (message:string) => ctx.addIssue({code:"custom",message});
  if (new Set(value.dependencies).size !== value.dependencies.length) invalid("Duplicate evidence dependencies");
  if (new Set(value.dependsOnDeliveries?.map(d=>d.deliveryId)).size !== (value.dependsOnDeliveries?.length??0)) invalid("Duplicate prerequisite deliveries");
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
  observation:z.object({batchId:z.string().min(1).max(200),heads:z.array(z.object({deliveryId:z.string().min(1).max(200),head:sha}).strict()).min(1).max(20),scope:digest}).strict(),
  context: z.object({base:sha,candidates:digest,tools:digest.optional(),capabilities:digest.optional()}).strict(),
  workflow: z.object({tools:z.enum(["project_native","missiongo"]),repositories:z.array(z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)).min(1).max(20),source:text,digest}).strict().optional(),
  dependencyResolutions:z.array(z.object({conditionId:z.string().min(1).max(200),deliveryId:z.string().min(1).max(200),head:sha,
    via:z.enum(["base","tools","capabilities"]),before:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),after:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),source:text}).strict()).max(20).default([]),
  // Partial refresh: omitted conditions retain their original evidence bindings.
  conditions: z.array(z.object(conditionShape).strict()).min(1).max(50),
}).strict().superRefine((action,ctx)=>{
  for(const c of action.conditions) {
    const native=action.workflow?.tools==="project_native";
    const tool=["installation_integrity","required_capability"].includes(c.kind);
    if(!native) {
      const parsed=condition.safeParse(c);
      if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue({code:"custom",message:issue.message});
    } else {
      if(core.includes(c.kind as typeof core[number])&&!tool&&(!c.required||c.stage!=="pre_merge"||!["blocker","fact"].includes(c.category)))ctx.addIssue({code:"custom",message:"Necessary project facts remain required"});
      const minimumKeys=c.kind==="authorization"?["scope"]:tool?[]:minimum[c.kind]??[];
      if(minimumKeys.some(key=>!c.dependencies.includes(key as typeof c.dependencies[number])))ctx.addIssue({code:"custom",message:"Missing project evidence binding"});
      if(!tool&&c.kind!=="authorization"&&c.state==="not_required"&&c.required)ctx.addIssue({code:"custom",message:"Necessary project facts cannot be skipped"});
      if(c.kind==="authorization"&&["satisfied","not_required"].includes(c.state)&&!c.authorizationRef)ctx.addIssue({code:"custom",message:"Original authorization reference required"});
      if(tool&&c.state==="not_required"&&(c.required||!c.dependencies.includes("scope")))ctx.addIssue({code:"custom",message:"Unused tools require scoped applicability evidence"});
      if(["version","build","artifact","release_notes"].includes(c.kind)&&c.stage==="pre_merge")ctx.addIssue({code:"custom",message:"Publication work is not a first-merge prerequisite"});
      if(c.kind==="tool_difference"&&c.required)ctx.addIssue({code:"custom",message:"Ordinary differences are not blockers"});
    }
    for(const key of c.dependencies)if(["tools","capabilities"].includes(key)&&!action.context[key as "tools"|"capabilities"])ctx.addIssue({code:"custom",message:"Missing actual tool evidence"});
    if(new Set(c.dependencies).size!==c.dependencies.length||new Set(c.dependsOnDeliveries?.map(d=>d.deliveryId)).size!==(c.dependsOnDeliveries?.length??0))ctx.addIssue({code:"custom",message:"Duplicate project evidence dependencies"});
  }
});
export type PrerequisitesAction = z.infer<typeof prerequisitesActionSchema>;
export interface PrerequisiteBatch {
  id:string;
  publish: boolean; state?:string; operation?: string; selection: {id:string;revision:string}[];
  publicationScope?: {digest:string} | undefined; references?: Record<string,unknown>;
  deliveries: string[]; integration?: MergeIntegration;
  results: Record<string,{status:string;head:string}>;
  entries?:{id:string;head:string;executionHead?:string}[];
  reconciliation?:MergeReconciliationState;
}
function denied(message:string):never { throw conflict("merge_prerequisites_changed",message); }
export function prerequisiteObservation(batch:PrerequisiteBatch) {
  return {batchId:batch.id,heads:batch.deliveries.map(id=>{
    const head=batch.integration?.entries[id]?.head??batch.entries?.find(e=>e.id===id)?.executionHead
      ??batch.results[id]?.head??batch.entries?.find(e=>e.id===id)?.head;
    if(!head||!/^[a-f0-9]{40}$/.test(head))denied("缺少实际观察的交付版本，请重新读取完整批次。");
    return {deliveryId:id,head};
  }),
    scope:hash([batch.selection,batch.operation??null,batch.publish,batch.publicationScope?.digest??null])};
}
function bindings(batch:PrerequisiteBatch, context:IntegrationPrerequisites["context"] & {workflowDigest?:string|undefined}) {
  // No progress, event, timestamp or integration revision in the content scope.
  return {...context,scope:context.workflowDigest?hash([prerequisiteObservation(batch).scope,context.workflowDigest]):prerequisiteObservation(batch).scope,
    heads:hash(batch.deliveries.map(id=>[id,batch.integration?.entries[id]?.head??batch.results[id]?.head]))};
}
export function recordPrerequisites(batch:PrerequisiteBatch, action:PrerequisitesAction) {
  const state=batch.integration!;
  const age=Date.now()-Date.parse(action.checkedAt);
  if(age < -30_000 || age > 300_000)denied("前置检查时间已过期，请读取实际结果。");
  const previous=state.prerequisites?.conditions??[], conditions=new Map(previous.map(c=>[c.id,c]));
  const workflow=action.workflow??state.prerequisites?.workflow;
  const values=bindings(batch,{...action.context,workflowDigest:workflow?hash(workflow):undefined});
  if(hash(action.observation)!==hash(prerequisiteObservation(batch)))denied("前置证据观察的批次、交付版本或发布范围已变化，请重新核实。");
  if(new Set(action.conditions.map(c=>c.id)).size!==action.conditions.length)denied("前置条件不能重复。");
  const resolved:typeof action.dependencyResolutions=[];
  for(const c of action.conditions) {
    const old=conditions.get(c.id);
    if(old && old.kind!==c.kind)denied("不能用其他类别覆盖原等待原因。");
    if(c.dependsOnDeliveries?.some(d=>!batch.deliveries.includes(d.deliveryId)||state.entries[d.deliveryId]?.head!==d.head))denied("前置依赖的交付或提交已变化。");
    for(const d of old?.dependsOnDeliveries??[])if(batch.results[d.deliveryId]?.status!=="merged"
      &&(!c.dependsOnDeliveries?.some(next=>next.deliveryId===d.deliveryId)||old!.required&&old!.stage==="pre_merge"&&(!c.required||c.stage!=="pre_merge"))) {
      const proof=action.dependencyResolutions.find(r=>r.conditionId===c.id&&r.deliveryId===d.deliveryId&&r.head===d.head);
      if(!proof||c.state!=="satisfied"||proof.before===proof.after||proof.before!==old!.binding[proof.via]
        ||proof.after!==values[proof.via]||!c.dependencies.includes(proof.via))denied("不能清除未解除的循环依赖；需记录独立前置修复的实际变化与来源。");
      resolved.push(proof);
    }
    conditions.set(c.id,{...c,checkedAt:action.checkedAt,source:action.source,
      binding:Object.fromEntries(c.dependencies.map(key=>[key,values[key]!]))});
  }
  if(conditions.size>50 || core.some(kind=>[...conditions.values()].filter(c=>c.kind===kind).length>1))denied("前置条件过多或必要条件重复。");
  if(resolved.length!==action.dependencyResolutions.length)denied("解除证据必须逐项匹配原循环依赖，不能重复或用于无关条件。");
  const resolutions=[...(state.prerequisites?.resolutions??[]),...resolved];
  if(resolutions.length>100)denied("前置依赖解除记录过多，请保留原批次核对。");
  const history=[...(state.prerequisites?.history??[]),...(previous.length?[{checkedAt:action.checkedAt,source:action.source,conditions:previous}]:[])];
  if(history.length>50)denied("前置适配历史已达上限，保留原批次核对，不覆盖历史。");
  state.prerequisites={observation:action.observation,context:action.context,workflow,conditions:[...conditions.values()],resolutions,history};
}
export function prerequisiteGate(batch:PrerequisiteBatch, hasRelease:boolean, base?:string, now=Date.now(), stage:"pre_merge"|"pre_publish"="pre_merge"):IntegrationPrerequisiteGate {
  const required=batch.state!=="finished" && batch.publish && hasRelease && !batchPublicationDeferred(batch)
    && (stage==="pre_publish" ? Boolean(batch.integration?.prerequisites?.workflow) : batch.deliveries.some(id=>!batch.references?.[id]&&!batch.results[id]) && batch.operation!=="merge_only" && batch.operation!=="publish_only");
  const gate:IntegrationPrerequisiteGate={required,ready:true,blockers:[]};
  if(!required)return gate;
  const record=batch.integration?.prerequisites, conditions=record?.conditions??[];
  if(record&&!record.observation)gate.blockers.push({id:"observation",code:"missing",reason:"旧前置记录缺少实际观察的版本",owner:"集成执行者",resumeWhen:"重新读取并核实原批次版本，不复用旧快照"});
  const names={main:"当前主线",installation_integrity:"工具安装完整性",required_capability:"必需能力",authorization:"原生授权依据",scope:"发布范围"};
  const necessary=record?.workflow?.tools==="project_native"?core.filter(kind=>!["installation_integrity","required_capability"].includes(kind)):core;
  const missing=necessary.filter(kind=>!conditions.some(c=>c.kind===kind));
  if(missing.length)gate.blockers.push({id:"required_evidence",code:"missing",reason:`尚未核实：${missing.map(kind=>names[kind]).join("、")}`,owner:"集成执行者",resumeWhen:"在原批次核实并登记必要前置条件"});
  if(record) {
    const values=bindings(batch,{...record.context,workflowDigest:record.workflow?hash(record.workflow):undefined,...(base?{base}:{})});
    const newerChecks=batch.deliveries.filter(id=>!batch.results[id]&&!batch.references?.[id]).flatMap(id=>{
      const check=batch.integration?.entries[id]?.check;return check?[check]:[];
    });
    for(const c of conditions.filter(c=>c.required && (c.stage===stage || stage==="pre_publish"&&["main","authorization","scope"].includes(c.kind)))) {
      const age=now-Date.parse(c.checkedAt);
      const cycle=c.dependsOnDeliveries?.some(d=>batch.results[d.deliveryId]?.status!=="merged");
      const stale=!Number.isFinite(age)||age < -30_000||age>300_000||c.dependencies.some(key=>c.binding[key]!==values[key])
        || !base&&c.dependencies.includes("base")&&newerChecks.some(check=>Date.parse(check.checkedAt)>=Date.parse(c.checkedAt)&&check.base!==c.binding.base)
        || c.dependsOnDeliveries?.some(d=>batch.integration?.entries[d.deliveryId]?.head!==d.head);
      const code=cycle?"cycle":stale?"stale":!["satisfied","not_required"].includes(c.state)?"pending":undefined;
      if(code)gate.blockers.push({id:c.id,code,reason:c.reason,owner:c.owner,resumeWhen:c.resumeWhen});
    }
  }
  gate.ready=gate.blockers.length===0;
  return gate;
}
