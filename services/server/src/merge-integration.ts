import { z } from "zod";
import { createHash } from "node:crypto";
import type { MergeIntegration } from "@missiongo/contracts";
import { conflict } from "./errors.js";
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const text=z.string().trim().min(1).max(4000);
const id=z.string().min(1).max(200);
const entry={deliveryId:id,expectedHead:sha};
export const integrationActionSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("plan"),base:sha,summary:text,validation:text,entries:z.array(z.object({deliveryId:id,head:sha,
    dependsOn:z.array(id).max(20),group:z.string().trim().min(1).max(100),reason:text,validation:text})).min(1).max(20)}),
  z.object({kind:z.literal("prepare_repair"),...entry,base:sha,reason:text}),
  z.object({kind:z.literal("cancel_repair"),...entry,repairId:id,observedHead:sha,noExecutionRemaining:z.literal(true),reason:text,source:text}),
  z.object({kind:z.literal("repair"),...entry,repairId:id,head:sha,commits:z.array(sha).min(1).max(100),validation:text,source:text}),
  z.object({kind:z.literal("check"),...entry,base:sha,checkedAt:z.string().datetime(),source:text,
    checks:z.enum(["passed","pending","failed","unknown"]),mergeable:z.enum(["clean","conflicting","unknown"]),local:z.enum(["passed","failed","pending"]),validation:text}),
  z.object({kind:z.literal("progress"),...entry,phase:z.enum(["queued","investigating","waiting_ci"]),detail:text}),
  z.object({kind:z.literal("final_validation"),head:sha,checkedAt:z.string().datetime(),validation:text,source:text}),
]);
export type IntegrationAction=z.infer<typeof integrationActionSchema>;
export const integrationDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function integrationDenied(message:string):never {throw conflict("merge_integration_changed",message);}
export function freshIntegrationCheck(checkedAt:string) {const age=Date.now()-Date.parse(checkedAt);return age>=-30_000&&age<=300_000;}
export function applyIntegrationAction(state:MergeIntegration, action:IntegrationAction, key:string,
  results:Record<string,{status:string;head:string;commit?:string}>) {
  const at=new Date().toISOString();
  if(state.events.length>=1000)integrationDenied("集成记录已达上限，请保留原批次并联系维护者。");
  if(action.kind==="plan") {
    if(state.plans.length>=50)integrationDenied("计划修订过多，请先核对已有记录。");
    const ids=action.entries.map(e=>e.deliveryId);
    if(ids.length!==Object.keys(state.entries).length||new Set(ids).size!==ids.length||ids.some(id=>!state.entries[id]))integrationDenied("计划必须包含批次全部交付且不能重复。");
    for(const [index,e] of action.entries.entries()) {
      if(e.head!==state.entries[e.deliveryId]!.head||new Set(e.dependsOn).size!==e.dependsOn.length||e.dependsOn.some(id=>!ids.slice(0,index).includes(id)))integrationDenied("计划提交已变化或依赖顺序无效。");
    }
    const {kind:_kind,...plan}=action;state.plans.push({...plan,at});
    for(const e of Object.values(state.entries)){delete e.check;if(e.progress==="ready")e.progress="queued";}
    delete state.finalValidation;
  } else if(action.kind==="final_validation") {
    if(!state.plans.length||Object.keys(state.entries).some(id=>!results[id]))integrationDenied("先核实每项合并结果，再登记组合验证。");
    if(!freshIntegrationCheck(action.checkedAt))integrationDenied("组合验证证据已过期。");
    state.finalValidation={head:action.head,checkedAt:action.checkedAt,validation:action.validation,source:action.source,selectionDigest:integrationDigest(results)};
  } else {
    const e=state.entries[action.deliveryId];
    if(!e||results[action.deliveryId]||e.head!==action.expectedHead)integrationDenied("交付、提交或结果已变化。");
    if(action.kind!=="progress"&&!state.plans.length)integrationDenied("请先登记整批集成计划。");
    if(action.kind==="prepare_repair") {
      if(e.repair)integrationDenied("已有未核实的修复，请恢复原修复记录。");
      e.repair={id:key,fromHead:e.head,base:action.base,reason:action.reason};e.progress="repairing";e.detail=action.reason;delete e.check;
    } else if(action.kind==="cancel_repair") {
      if(!e.repair||e.repair.id!==action.repairId||action.observedHead!==e.head)integrationDenied("修复结果未知或远端已变化，不能撤销预留。");
      delete e.repair;delete e.check;e.progress="investigating";e.detail=action.reason;
    } else if(action.kind==="repair") {
      if(!e.repair||e.repair.id!==action.repairId||e.repair.fromHead!==action.expectedHead||action.head===e.head||
        action.commits.at(-1)!==action.head||new Set(action.commits).size!==action.commits.length||action.commits.includes(e.head))integrationDenied("修复必须对应原预留和完整的新提交链。");
      e.repairs.push({...e.repair,head:action.head,commits:action.commits,validation:action.validation,source:action.source,at});
      e.head=action.head;delete e.repair;delete e.check;e.progress="investigating";e.detail=action.validation;
    } else if(action.kind==="check") {
      if(e.repair)integrationDenied("先核实进行中的修复。");
      if(!freshIntegrationCheck(action.checkedAt))integrationDenied("请读取实时检查结果。");
      e.check={head:e.head,base:action.base,checkedAt:action.checkedAt,source:action.source,checks:action.checks,mergeable:action.mergeable,local:action.local,validation:action.validation};
      e.progress=action.checks==="passed"&&action.local==="passed"&&action.mergeable==="clean"?"ready":action.checks==="pending"?"waiting_ci":"investigating";e.detail=action.validation;
    } else {e.progress=action.phase;e.detail=action.detail;delete e.check;}
    delete state.finalValidation;
  }
  state.revision++;
  state.events.push({id:key,digest:integrationDigest(action),action:action.kind,at,
    ...("deliveryId" in action?{deliveryId:action.deliveryId}:{}),detail:"detail" in action?action.detail:"reason" in action?action.reason:"summary" in action?action.summary:action.validation});
}
export function assertIntegrationMerge(state:MergeIntegration,id:string,results:Record<string,{status:string}>) {
  const plan=state.plans.at(-1),e=state.entries[id],check=e?.check;
  if(!plan||!e||e.repair||!check||check.head!==e.head||!freshIntegrationCheck(check.checkedAt)||check.checks!=="passed"||check.mergeable!=="clean"||check.local!=="passed")integrationDenied("必须完成整批规划，并核验最终提交的本地检查、CI 与冲突结果。");
  if(plan.entries.find(entry=>entry.deliveryId===id)!.dependsOn.some(dep=>results[dep]?.status!=="merged"))integrationDenied("计划依赖尚未合并。");
}
