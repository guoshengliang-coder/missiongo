import { integrationArtifactName, type MergeReconciliationPreview } from "@missiongo/contracts";

/** Human-facing content is separate from the exact signed technical binding. */
export function mergeReviewSummary(preview:MergeReconciliationPreview,requestId:string):string {
  const row=preview.reconciliation?.requests.find(r=>r.id===requestId);
  if(!row)throw new Error("Recovery request missing");
  const labels={accept_merge:"核实并登记已有合并",retry_handover:"重试交接",retry_blocked:"继续处理受阻交付",
    defer_publication:"暂缓本批发布",allow_partial_publication:"按本次范围继续发布"};
  const lines=[`本次决定：${labels[row.action.kind]}`,"已有的有效批准继续保留；本次只批准下述动作与范围。",
    "reason"in row.action?row.action.reason:"", "执行前仍须核实没有未结束或结果不明的操作；批准不会自动执行 Git 或生产发布。"];
  const scope=row.publicationScope;
  if(scope){
    lines.push(`发布产物：${scope.requiredArtifacts.map(integrationArtifactName).join(" / ")}`);
    for(const c of scope.candidates)lines.push(`${c.historicalGapReason?"历史缺证：":!c.selected?"额外包含：":""}${c.title} · ${c.requiredArtifacts?.map(integrationArtifactName).join(" / ")||"历史范围缺证"}${c.historicalGapReason?`；保留缺口：${c.historicalGapReason}`:""}`);
    for(const blocker of scope.blockers)lines.push(`仍需核实：${blocker}`);
    for(const e of scope.exclusions??[])lines.push(`未纳入：${e.title}；${e.reason}`);
  }else for(const e of preview.entries.filter(e=>!("deliveryId"in row.action)||row.action.deliveryId===e.deliveryId))
    lines.push(`${e.itemKeys.join(" / ")||`PR #${e.pullRequest}`}：${e.requiredArtifacts.map(integrationArtifactName).join(" / ")||e.noReleaseReason||"范围待核实"}`);
  if(row.action.kind==="accept_merge"){
    const action=row.action,entry=preview.entries.find(e=>e.deliveryId===action.deliveryId);
    lines.push(`目标：${entry?.repository??"仓库待核实"} → ${entry?.targetBranch??"分支待核实"}`,`实际 head：${row.action.evidence.head}`,`合并提交：${row.action.evidence.commit}`,`目标分支提交：${row.action.evidence.targetHead}`);
    lines.push(`合并核验：${row.action.evidence.validation}`,`依据：${row.action.evidence.source}`);
  }
  return lines.filter(Boolean).join("\n\n");
}
