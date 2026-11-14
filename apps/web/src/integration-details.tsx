import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, GitMerge, CloudUpload } from "lucide-react";
import type { Batch } from "./merge-console";
import { useI18n } from "./i18n";
import { useOverlay } from "./overlay";
import { MergeReconciliation } from "./merge-reconciliation";
import { integrationOrder, integrationStage, integrationPublication, integrationStageLabels, integrationPublicationLabels } from "./integration-presentation";

type Screen="overview"|"detail"|"history"|"evidence"|"recovery";
/** Same reading surface in both the pending-merge dialog and integration session. */
export function IntegrationProgress({batch}:{batch:Batch}) {
  const {t,formatTime}=useI18n(),[screen,setScreen]=useState<Screen>("overview"),[selected,setSelected]=useState<string>();
  const root=useRef<HTMLElement>(null),focusReturn=useRef<HTMLElement[]>([]),previous=useRef<Screen>("overview");
  const order=integrationOrder(batch),state=batch.integration,plan=state?.plans.at(-1);
  const back=()=>setScreen(screen==="history"||screen==="evidence"?"detail":"overview");
  // Register each reading level with the shared Back/Escape coordinator.
  useOverlay(screen!=="overview",()=>setScreen("overview"));
  useOverlay(screen==="history"||screen==="evidence",()=>setScreen("detail"));
  useLayoutEffect(()=>{
    if(previous.current===screen)return;
    const goingBack=screen==="overview"||(screen==="detail"&&(previous.current==="history"||previous.current==="evidence"));
    const target=goingBack?focusReturn.current.pop():root.current?.querySelector<HTMLButtonElement>(`[data-screen="${screen}"] button`);
    target?.focus({preventScroll:true});
    // Hidden overflow containers can still be scrolled by browser focus/scroll
    // anchoring. Reading position belongs to each screen, never the modal chrome.
    for(let parent=root.current?.parentElement;parent;parent=parent.parentElement) {
      if(parent.matches(".modal-fields, .modal-content, .modal"))parent.scrollTop=0;
      if(parent.matches(".modal"))break;
    }
    previous.current=screen;
  },[screen]);
  function enter(next:Screen,id?:string) {
    if(document.activeElement instanceof HTMLElement)focusReturn.current.push(document.activeElement);
    if(id)setSelected(id);setScreen(next);
  }
  const merged=order.filter(id=>integrationStage(batch,id)==="merged").length;
  const blocked=order.some(id=>integrationStage(batch,id)==="blocked"),publication=integrationPublication(batch);
  const entry=selected?state?.entries[selected]:undefined,presentation=selected?batch.presentation?.entries[selected]:undefined;
  const step=plan?.entries.find(row=>row.deliveryId===selected),stage=selected?integrationStage(batch,selected):"queued";
  const title=presentation?.title||entry?.itemKeys.join(" · ")||t("integrationUnknownGroup");
  const check=entry?.check;
  const checkKeys={passed:"integrationCheckPassed",failed:"integrationCheckFailed",pending:"integrationCheckPending",unknown:"integrationCheckUnknown"} as const;
  const events=state?.events.filter(e=>e.deliveryId===selected)??[];
  return <section ref={root} className="integration-progress" aria-label={t("integrationTitle")}>
    <div className="integration-screen" data-screen="overview" hidden={screen!=="overview"}>
      <div className="integration-outcomes" aria-live="polite">
        <div data-outcome="merge" data-complete={order.length>0&&merged===order.length}><span className="integration-outcome-label"><GitMerge size={16} aria-hidden="true"/>{t("integrationMergeOutcome")}</span><strong>{t(order.length>0&&merged===order.length?"integrationAllMerged":blocked?"integrationMergeBlocked":merged?"integrationSomeMerged":"integrationMergePending")}</strong></div>
        <div data-outcome="publication" data-complete={publication==="published"}><span className="integration-outcome-label"><CloudUpload size={16} aria-hidden="true"/>{t("integrationPublicationOutcome")}</span><strong>{t(publication==="published"?"integrationPublicationDone":integrationPublicationLabels[publication])}</strong></div>
      </div>
      {publication==="published"&&merged===order.length&&batch.state==="finished"&&<p className="integration-note">{t("integrationCompleteHelp")}</p>}
      {!batch.publish&&publication!=="published"&&publication!=="not_required"&&<p className="integration-note">{t("integrationPublicationNotSelected")}</p>}
      {blocked&&<p className="integration-attention" role="status">{t(batch.publish?"integrationPublishHeld":"integrationBlockedHelp")}</p>}
      {!state&&<p className="integration-note">{t("integrationLegacy")}</p>}
      {batch.state==="active"&&batch.prerequisiteGate?.required&&!batch.prerequisiteGate.ready&&<section className="integration-attention" aria-label={t("integrationPrerequisites")} role="status">
        <h3>{t("integrationPrerequisites")}</h3>
        <p>{t("integrationPrerequisitesHelp")}</p>
        <ul>{batch.prerequisiteGate.blockers.map(b=><li key={b.id}>
          <strong>{t(b.code==="cycle"?"integrationPrerequisiteCycle":b.code==="stale"?"integrationPrerequisiteStale":b.code==="missing"?"integrationPrerequisiteMissing":"integrationPrerequisitePending")}</strong>
          <p>{b.reason}</p><p>{t("integrationPrerequisiteOwner")}: {b.owner}</p><p>{t("integrationPrerequisiteResume")}: {b.resumeWhen}</p>
        </li>)}</ul>
      </section>}
      <h3>{t("integrationGroups",{count:order.length})}</h3>
      <div className="integration-groups">{order.map(id=>{
        const e=state?.entries[id],p=batch.presentation?.entries[id],phase=integrationStage(batch,id),pub=integrationPublication(batch,id);
        return <button type="button" className="integration-group" key={id} onClick={()=>enter("detail",id)}>
          <span className="integration-group-copy">{batch.references?.[id]&&<small>{t(batch.verifiedReferences?.[id]?"queueReferenceVerified":"queueReferencePending")}</small>}<strong>{p?.title||e?.itemKeys.join(" · ")||t("integrationUnknownGroup")}</strong><small>{(e?.itemKeys??p?.itemKeys)?.join(" · ")}</small></span>
          <span className="integration-group-state"><span data-outcome="merge" data-complete={phase==="merged"}>{t(integrationStageLabels[phase])}</span><span data-outcome="publication" data-complete={pub==="published"}>{t(integrationPublicationLabels[pub])}</span></span><ChevronRight size={18} aria-hidden="true"/>
        </button>;
      })}</div>
      {!order.length&&<p>{t("integrationPlanning")}</p>}
      <button type="button" className="integration-drill" onClick={()=>enter("recovery")}>{t("recoveryOpen")}<ChevronRight size={18} aria-hidden="true"/></button>
    </div>
    <div className="integration-screen" data-screen="detail" hidden={screen!=="detail"}>
      <button type="button" className="secondary-button integration-back" onClick={back}><ArrowLeft size={16}/>{t("integrationBackOverview")}</button>
      <h3 className="integration-group-title">{step?.group||t("integrationGroup")}</h3><p className="integration-note">{(entry?.itemKeys??presentation?.itemKeys)?.join(" · ")}</p>
      <div className="integration-statuses"><span data-outcome="merge" data-complete={stage==="merged"}>{t(integrationStageLabels[stage])}</span><span data-outcome="publication" data-complete={integrationPublication(batch,selected)==="published"}>{t(integrationPublicationLabels[integrationPublication(batch,selected)])}</span></div>
      {selected&&batch.references?.[selected]&&<p className="integration-note">{t(batch.verifiedReferences?.[selected]?"queueReferenceVerified":"queueReferencePending")}</p>}
      <section><h4>{t("integrationChangeDescription")}</h4><p>{title}</p></section>
      <dl className="integration-facts">
        <dt>{t("integrationRepairOutcome")}</dt><dd>{t(entry?.repair?"integrationRepairPending":entry?.repairs.length?"integrationRepairsRecorded":"integrationNoRepairs")}</dd>
        <dt>{t("integrationChecksOutcome")}</dt><dd>{check?<ul><li>{t("integrationLocalChecks")}: {t(checkKeys[check.local])}</li><li>{t("integrationRemoteChecks")}: {t(checkKeys[check.checks])}</li><li>{t("integrationConflictChecks")}: {t(check.mergeable==="clean"?"integrationNoConflict":check.mergeable==="conflicting"?"integrationHasConflict":"integrationCheckUnknown")}</li></ul>:t("integrationCheckUnknown")}</dd>
        <dt>{t("integrationMergeOutcome")}</dt><dd>{t(integrationStageLabels[stage])}</dd>
        <dt>{t("integrationPublicationOutcome")}</dt><dd>{t(integrationPublicationLabels[integrationPublication(batch,selected)])}</dd>
        {step?.dependsOn.length? <><dt>{t("integrationDependencies")}</dt><dd>{step.dependsOn.map(id=>state?.entries[id]?.itemKeys.join(" / ")??t("integrationUnknownGroup")).join(" · ")}</dd></>:null}
      </dl>
      {(stage==="blocked"||entry?.repair)&&<p className="integration-attention">{t("integrationReadEvidenceHelp")}</p>}
      <button type="button" className="integration-drill" onClick={()=>enter("history")}>{t("integrationProcess")}<ChevronRight size={18} aria-hidden="true"/></button>
      <button type="button" className="integration-drill" onClick={()=>enter("evidence")}>{t("integrationTechnical")}<ChevronRight size={18} aria-hidden="true"/></button>
    </div>
    <div className="integration-screen" data-screen="history" hidden={screen!=="history"}>
      <button type="button" className="secondary-button integration-back" onClick={back}><ArrowLeft size={16}/>{t("integrationBackGroup")}</button><h3>{t("integrationProcess")}</h3>
      <p className="integration-note">{t("integrationHistoricalHelp")}</p>
      <ol className="integration-events">{events.filter(e=>e.action!=="progress"&&e.action!=="prepare_repair").map(e=><li key={e.id}><strong>{t(e.action==="repair"?"integrationHistoryRepair":e.action==="check"?"integrationHistoryCheck":e.action==="cancel_repair"?"integrationHistoryCancel":"integrationHistoryPrepare")}</strong><small>{formatTime(e.at)}</small>{e.action==="repair"&&<p className="integration-event-summary">{entry?.repairs.find(r=>r.at===e.at)?.reason??t("integrationRepairsRecorded")}</p>}</li>)}
        {batch.results[selected??""]&&<li><strong>{t(stage==="merged"?"integrationHistoryMerged":"integrationBlocked")}</strong></li>}
        {integrationPublication(batch,selected)==="published"&&<li><strong>{t("integrationPublicationDone")}</strong></li>}
      </ol>
      {!events.length&&!batch.results[selected??""]&&<p>{t("integrationNoHistory")}</p>}
    </div>
    <div className="integration-screen" data-screen="evidence" hidden={screen!=="evidence"}>
      <button type="button" className="secondary-button integration-back" onClick={back}><ArrowLeft size={16}/>{t("integrationBackGroup")}</button><h3>{t("integrationTechnical")}</h3>
      <p className="integration-note">{t("integrationHistoricalHelp")}</p>
      {presentation&&<section><h4>{t("integrationOriginalDescription")}</h4><p>{presentation.summary}</p><a href={presentation.pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a><p>{t("recoveryScope")}: {presentation.requiredArtifacts.join(" / ")||presentation.noReleaseReason}</p></section>}
      {entry&&<section><h4>{t("integrationCommitEvidence")}</h4><p>{t("integrationOriginal")}: <code>{entry.originalHead}</code></p><p>{t("integrationCurrent")}: <code>{entry.head}</code></p></section>}
      {check&&<section><h4>{t("integrationChecksOutcome")}</h4><p>{check.validation}</p><small>{formatTime(check.checkedAt)} · {check.source}</small></section>}
      {step&&<section><h4>{t("integrationValidation")}</h4><p>{step.validation}</p></section>}
      {entry?.repairs.map(r=><section key={r.id}><h4>{t("integrationHistoryRepair")} · {formatTime(r.at)}</h4><p>{r.reason}</p><p>{r.validation}</p><code>{r.fromHead} → {r.head}</code></section>)}
      {presentation?.releases.map(r=><section key={`${r.artifact}-${r.sourceCommit}`}><h4>{r.artifact} · {r.version}</h4><p>{formatTime(r.checkedAt)}</p><code>{r.sourceCommit}</code></section>)}
      <section><h4>{t("integrationOriginalRecords")}</h4>{events.map(e=><p key={e.id}>{formatTime(e.at)} · {e.detail}</p>)}{batch.results[selected??""]&&<p>{batch.results[selected??""]!.detail}</p>}</section>
      {(state?.finalValidation||plan)&&<section><h4>{t("integrationBatchEvidence")}</h4>{plan&&<><p>{plan.summary}</p><p>{t("integrationValidation")}: {plan.validation}</p></>}{state?.finalValidation&&<p>{t("integrationCombined")}: {state.finalValidation.validation}</p>}</section>}
      {state?.prerequisites&&<section><h4>{t("integrationPrerequisites")}</h4>{state.prerequisites.conditions.map(c=><div key={c.id}><p>{c.reason}</p><small>{formatTime(c.checkedAt)} · {c.source}</small><p>{t("integrationPrerequisiteOwner")}: {c.owner}</p><p>{t("integrationPrerequisiteResume")}: {c.resumeWhen}</p></div>)}</section>}
    </div>
    <div className="integration-screen" data-screen="recovery" hidden={screen!=="recovery"}>
      <button type="button" className="secondary-button integration-back" onClick={back}><ArrowLeft size={16}/>{t("integrationBackOverview")}</button>
      {screen==="recovery"&&<MergeReconciliation batchId={batch.id} initiallyOpen/>}
    </div>
  </section>;
}
