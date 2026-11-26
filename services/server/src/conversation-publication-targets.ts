import { z } from "zod";
import { conflict } from "./errors.js";

/** Human-reviewed constraints, never proof of a repository or deployed version. */
export const publicationTargetsSchema=z.array(z.object({
  artifact:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/),
  version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/).optional(),
}).strict()).max(20).refine(rows=>new Set(rows.map(r=>r.artifact)).size===rows.length,"Repeated publication target.");
export type PublicationTarget=z.infer<typeof publicationTargetsSchema>[number];
export interface ConversationPublicationBounds {requiredArtifacts:readonly string[];declaredArtifacts:readonly string[];targets?:readonly PublicationTarget[]|undefined}
export const scopeConflict=(reason:string,message:string)=>conflict(`conversation_integration_${reason}`,message);
const aliases:Record<string,string[]>={web:["Web/Server"],androidApp:["Android"],androidSdk:["Android SDK"],
  macosApp:["macOS"],linuxCli:["Linux CLI"],windowsApp:["Windows"]};
const separators=new Set(["and","pr","please","now","this","these","the","only","except","without","ignore","skip","not","do","if","when","after"]);
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Remove only uniquely resolved artifacts and their checked version constraints.
 * Unknown qualifiers are left for the conservative action grammar to reject. */
export function publicationActionBounds(text:string,bounds:ConversationPublicationBounds, requirePinnedVersions=false):{text:string;artifacts:string[]} {
  const names = new Map<string, Set<string>>();
  for (const artifact of bounds.declaredArtifacts) {
    const key = artifact.toLowerCase();
    if (!names.has(key)) names.set(key, new Set());
    names.get(key)!.add(artifact);
  }
  const exactNames = new Set(names.keys());
  for (const artifact of bounds.declaredArtifacts) {
    for (const alias of aliases[artifact] ?? []) {
      const key = alias.toLowerCase();
      if (exactNames.has(key)) continue;
      if (!names.has(key)) names.set(key, new Set());
      names.get(key)!.add(artifact);
    }
  }
  const tokens=[...names.keys()].sort((a,b)=>b.length-a.length).map(escaped);
  if(!tokens.length)return {text,artifacts:[]};
  const seen=new Set<string>();
  const namedVersions=new Set<string>();
  const pattern=new RegExp(`\\b(${tokens.join("|")})\\b(?:\\s+([A-Za-z0-9][A-Za-z0-9._+-]{0,79})(?=$|[\\s,，;；。!！、]))?`,"ig");
  const remaining=text.replace(pattern,(_raw:string,name:string,version:string|undefined)=>{
    const matches=names.get(name.toLowerCase())!;
    if(matches.size!==1)throw scopeConflict("artifact_ambiguous",`产物名称 ${name} 对应多个声明，请使用明确的产物标识并核对原范围。`);
    const artifact=[...matches][0]!;
    if(!bounds.requiredArtifacts.includes(artifact))throw scopeConflict("artifact_mismatch",`产物 ${artifact} 不在已审阅发布范围内，请核对当前范围，不自动扩大授权。`);
    const target=bounds.targets?.find(t=>t.artifact===artifact);
    let separator="";
    if(version && separators.has(version.toLowerCase()) && version!==target?.version){separator=version;version=undefined;}
    // An ASCII sentence period may follow a version. Do not reinterpret an
    // unrecognized adjacent numeric/string token as a bare Git SHA later.
    if(version && version.endsWith(".") && version.slice(0,-1)===target?.version)version=version.slice(0,-1);
    if(version) {
      if(!target?.version)throw scopeConflict("version_evidence_missing",`产物 ${artifact} 缺少已审阅的目标版本约束；请先核实仓库版本并展示绑定版本的完整范围，保留原明确指令。`);
      namedVersions.add(artifact);
      if(version!==target.version)throw scopeConflict("version_mismatch",`产物 ${artifact} 的指令版本 ${version} 与已审阅目标 ${target.version} 不一致，请核对版本，不自动沿用旧范围。`);
    }
    if(seen.has(artifact))throw scopeConflict("artifact_ambiguous",`产物 ${artifact} 重复出现，请核对是否存在冲突限定。`);
    seen.add(artifact);return ` ${separator} `;
  });
  if(seen.size && bounds.requiredArtifacts.some(a=>!seen.has(a)))throw scopeConflict("artifact_subset","指令仅覆盖部分发布产物，不能授权完整范围；请准备实际限定范围，不自动补齐或排除其他产物。");
  if (requirePinnedVersions && bounds.targets?.some(target => target.version && !namedVersions.has(target.artifact)))
    throw scopeConflict("version_evidence_missing","指令未明确所有固定版本。");
  return {text:remaining,artifacts:[...seen]};
}

/** Executing endpoint must report a fresh repository/manifest observation before
 * publication, and retain normal release evidence gates. This is not a receipt. */
export function assertPublicationVersions(targets:readonly PublicationTarget[]|undefined,versions:readonly PublicationTarget[]|undefined) {
  const constrained=targets?.filter(t=>t.version)??[];
  if(!constrained.length)return;
  if(!versions || new Set(versions.map(v=>v.artifact)).size!==versions.length || constrained.some(t=>!versions.some(v=>v.artifact===t.artifact&&v.version===t.version)))
    throw scopeConflict("version_mismatch","发布前实际版本尚未核对或与原会话目标版本不符；请核实仓库/manifest 并提供 publicationVersions，不能按未知版本发布。");
}
