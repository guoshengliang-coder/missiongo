import { integrationArtifactName, type MergeReconciliationPreview } from "@missiongo/contracts";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "./api";
import { useI18n } from "./i18n";

export function MergeReconciliation({batchId,initiallyOpen=false,compact=false}:{batchId:string;initiallyOpen?:boolean;compact?:boolean}) {
  const {t,formatTime,statusLabel}=useI18n(),[open,setOpen]=useState(initiallyOpen),[confirmed,setConfirmed]=useState(false);
  const query=useQuery({queryKey:["merge-reconciliation",batchId],enabled:open,
    queryFn:()=>request<MergeReconciliationPreview>(`/api/v1/merge-batches/${encodeURIComponent(batchId)}/reconciliation`)});
  const decide=useMutation({mutationFn:({id,snapshot,decision}:{id:string;snapshot:string;decision:"approved"|"rejected"})=>{
    const publicationScope=query.data?.reconciliation?.requests.find(row=>row.id===id)?.publicationScope;
    return request<{continuation?:{queued:boolean}}>(`/api/v1/merge-batches/${encodeURIComponent(batchId)}/reconciliation/${encodeURIComponent(id)}/decision`,{
      method:"POST",body:JSON.stringify({snapshot,decision,...(compact?{reviewConfirmed:true,continueInSession:true}:{noExecutionRemaining:confirmed}),...(publicationScope?{publicationScopeDigest:publicationScope.digest}:{})})});},
    onSettled:()=>{setConfirmed(false);void query.refetch();}});
  const pending=query.data?.reconciliation?.requests.filter(r=>!r.decision&&!r.appliedAt&&r.snapshot===query.data?.snapshot)??[];
  const visible=compact?pending:query.data?.reconciliation?.requests;
  const [reviewFailed,setReviewFailed]=useState(false);
  const reviewId=pending.length===1?pending[0]?.id:undefined;
  const snapshot=query.data?.snapshot;
  useEffect(()=>{
    if(!compact||!reviewId||!snapshot)return;
    let current=true;setReviewFailed(false);
    void request(`/api/v1/merge-batches/${encodeURIComponent(batchId)}/reconciliation/${encodeURIComponent(reviewId)}/review`,{
      method:"POST",body:JSON.stringify({snapshot})}).catch(()=>{if(current)setReviewFailed(true);});
    return ()=>{current=false;};
  },[batchId,compact,reviewId,snapshot,query.dataUpdatedAt]);
  const approved=query.data?.reconciliation?.requests.find(r=>r.decision==="approved"&&!r.appliedAt);
  if(compact&&query.isSuccess&&!pending.length)return approved?<section role="status" className="merge-delivery-notice confirmed">
    <p>{t(decide.data?.continuation?.queued?"recoveryContinueQueued":"recoveryApprovedSaved")}</p>
    {!decide.data?.continuation?.queued&&<button type="button" className="secondary-button" disabled={decide.isPending} onClick={()=>decide.mutate({id:approved.id,snapshot:approved.snapshot,decision:"approved"})}>{t("recoveryContinue")}</button>}
    {decide.isError&&<p role="alert">{t("recoveryError")}</p>}
  </section>:null;
  const label=(entry:MergeReconciliationPreview["entries"][number]|undefined)=>entry ? entry.itemKeys.join(" · ") || `PR #${entry.pullRequest}` : "";
  const labels={accept_merge:"recoveryAcceptMerge",retry_handover:"recoveryRetryHandover",retry_blocked:"recoveryRetryBlocked",
    defer_publication:"recoveryDefer",allow_partial_publication:"recoveryPartial"} as const;
  return <details className="merge-reconciliation" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{t(compact?"recoveryConversationTitle":"recoveryOpen")}</summary>
    {open&&<section aria-label={t("recoveryTitle")}>
      <p>{t(compact?"recoveryConversationHelp":"recoveryHelp")}</p>
      {reviewFailed&&<p role="alert" className="inline-error">{t("recoveryConversationReviewError")}</p>}
      <button type="button" className="secondary-button" disabled={query.isFetching||decide.isPending} onClick={()=>{setConfirmed(false);void query.refetch();}}>{t("refresh")}</button>
      {(query.isError||decide.isError)&&<p role="alert" className="inline-error">{decide.error instanceof Error?decide.error.message:t("recoveryError")}</p>}
      {!compact&&query.data?.entries.map(entry=><div className="merge-delivery-card" key={entry.deliveryId}>
        <strong>{label(entry)}</strong>
        <p><a href={`${entry.repository}/pull/${entry.pullRequest}`} target="_blank" rel="noreferrer">PR #{entry.pullRequest}</a> → {entry.targetBranch}</p>
        <p>{t("integrationOriginal")}: <code>{entry.originalHead}</code></p>
        <p>{t("integrationCurrent")}: <code>{entry.executionHead}</code></p>
        <p>{t("recoveryActual")}: {entry.result?.detail??t("recoveryUnknown")}</p>
        {entry.result&&<p><code>{entry.result.head}</code> · <code>{entry.result.commit}</code></p>}
        <p>{t("recoveryScope")}: {entry.requiredArtifacts.join(" / ")||entry.noReleaseReason}</p>
        {entry.repair&&<p>{t("integrationRepairPending")}: {entry.repair.reason}</p>}
        <ul>{entry.items.map(item=><li key={item.itemKey}><strong>{item.itemKey}</strong> · {statusLabel(item.status)}
          <p>{item.blocker??item.handoff?.detail??item.next}</p>{item.missingEvidence&&<p>{t("recoveryMissing")}</p>}
        </li>)}</ul>
      </div>)}
      {compact&&query.data?.entries.map(entry=><p key={entry.deliveryId}><strong>{label(entry)}</strong> · {entry.requiredArtifacts.map(integrationArtifactName).join(" / ")||entry.noReleaseReason}</p>)}
      {query.isSuccess&&!query.data.reconciliation?.requests.length&&<p>{t("recoveryEmpty")}</p>}
      {visible?.map(row=><div className="merge-delivery-card" key={row.id}>
        <strong>{t(compact&&row.action.kind==="allow_partial_publication"?"recoveryContinuePublication":labels[row.action.kind])}</strong><small>{formatTime(row.at)}</small>
        {"deliveryId" in row.action&&<p>{label(query.data?.entries.find(e=>e.deliveryId===("deliveryId" in row.action?row.action.deliveryId:undefined)))}</p>}
        {"reason" in row.action&&<p>{row.action.reason}</p>}
        {row.publicationScope&&<div>
          <p>{t("recoveryRefreshScope")}</p>{!compact&&<code>{row.publicationScope.digest}</code>}
          <p>{t("recoveryScope")}: {row.publicationScope.requiredArtifacts.map(integrationArtifactName).join(" / ")}</p>
          <ul>{row.publicationScope.candidates.map(candidate=><li key={candidate.identity}>
            <strong>{candidate.title}</strong>{!compact&&<p><code>{candidate.identity}</code></p>}
            <p>{candidate.requiredArtifacts?.map(integrationArtifactName).join(" / ")||t("recoveryMissing")}</p>
            {candidate.historicalGapReason&&<p>{t("recoveryHistoricalGap")}: {candidate.historicalGapReason}</p>}
            <details><summary>{t("mergeDetails")}</summary><p><code>{JSON.stringify(candidate)}</code></p></details>
          </li>)}</ul>
          {row.publicationScope.exclusions?.map(candidate=><p key={candidate.identity}>{candidate.title} · {candidate.identity} · {candidate.reason}</p>)}
        </div>}
        {row.action.kind==="accept_merge"&&<><p>{row.action.evidence.validation}</p>
          <p>{t("recoveryActual")}: <code>{row.action.evidence.head}</code></p><p><code>{row.action.evidence.commit}</code> → <code>{row.action.evidence.targetHead}</code></p>
          <small>{formatTime(row.action.evidence.checkedAt)} · {row.action.evidence.source}</small></>}
        {row.appliedAt?<p role="status">{t("recoveryApplied")}</p>:row.decision?<p role="status">{t(row.decision==="approved"?"recoveryApproved":"recoveryRejected")}</p>:(row.snapshot!==query.data?.snapshot || row.action.kind==="allow_partial_publication" && row.action.publicationRefresh && row.action.publicationRefresh.scopeDigest!==query.data?.publicationRefresh?.digest)?<p>{t("recoveryStale")}</p>:<>
          {!compact&&<label className="merge-publish"><input type="checkbox" checked={confirmed} disabled={decide.isPending} onChange={e=>setConfirmed(e.target.checked)}/>{t("recoveryNoExecution")}</label>}
          <div className="merge-actions"><button type="button" className="primary-button" disabled={(!compact&&!confirmed)||decide.isPending} onClick={()=>decide.mutate({id:row.id,snapshot:row.snapshot,decision:"approved"})}>{t("recoveryApprove")}</button>
          <button type="button" className="secondary-button" disabled={(!compact&&!confirmed)||decide.isPending} onClick={()=>decide.mutate({id:row.id,snapshot:row.snapshot,decision:"rejected"})}>{t("recoveryReject")}</button></div>
        </>}
      </div>)}
      {!compact&&query.data?.reconciliation?.history.map((row,index)=><p key={index}>{formatTime(row.at)} · {row.detail}</p>)}
      {!compact&&query.data?.reconciliation?.finalValidation&&<p>{t("integrationCombined")}: {query.data.reconciliation.finalValidation.validation}</p>}
    </section>}
  </details>;
}
