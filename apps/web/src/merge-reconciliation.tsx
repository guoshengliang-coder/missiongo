import { integrationArtifactName, type MergeContinuation, type MergeReconciliationPreview } from "@missiongo/contracts";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "./api";
import { useI18n } from "./i18n";

// Shared by observers of the same query and survives component remounts; never compare per-instance clocks.
let continuationReadSequence=0;

type ReconciliationProps={batchId:string;initiallyOpen?:boolean;compact?:boolean};
export function MergeReconciliation(props:ReconciliationProps) {
  return <MergeReconciliationContent key={props.batchId} {...props}/>;
}
function MergeReconciliationContent({batchId,initiallyOpen=false,compact=false}:ReconciliationProps) {
  const {t,formatTime,statusLabel}=useI18n(),[open,setOpen]=useState(initiallyOpen),[confirmed,setConfirmed]=useState(false);
  const ackReads=useRef(new Map<string,number>());
  const [receipt,setReceipt]=useState<{id:string;continuation:MergeContinuation}|undefined>();
  const query=useQuery({refetchInterval:q=>Object.values(q.state.data?.continuations??{}).some(c=>["queued","delivering"].includes(c.state))?5000:false,queryKey:["merge-reconciliation",batchId],enabled:open,
    queryFn:async()=>{
      const sequence=++continuationReadSequence;
      const result=await request<MergeReconciliationPreview>(`/api/v1/merge-batches/${encodeURIComponent(batchId)}/reconciliation`);
      return {...result,readSequence:sequence};
    }});
  const [sendUnknown,setSendUnknown]=useState(false);
  const decide=useMutation({mutationFn:({id,snapshot,decision}:{id:string;snapshot:string;decision:"approved"|"rejected"})=>{
    const publicationScope=query.data?.reconciliation?.requests.find(row=>row.id===id)?.publicationScope;
    return request<{batchId:string;continuation?:MergeContinuation & {queued:boolean}}>(`/api/v1/merge-batches/${encodeURIComponent(batchId)}/reconciliation/${encodeURIComponent(id)}/decision`,{
      method:"POST",body:JSON.stringify({snapshot,decision,...(compact?{reviewConfirmed:true,continueInSession:true}:{noExecutionRemaining:confirmed}),...(publicationScope?{publicationScopeDigest:publicationScope.digest}:{})})});},
    onSuccess:(result,variables)=>{
      if(result.continuation)ackReads.current.set(variables.id,continuationReadSequence);
      if(result.continuation)setReceipt({id:variables.id,continuation:result.continuation});
    },
    onError:()=>setSendUnknown(true),
    onSettled:()=>{setConfirmed(false);void query.refetch().then(result=>{if(result.isSuccess){setSendUnknown(false);setReceipt(current=>current&&result.data&&result.data.readSequence>(ackReads.current.get(current.id)??Infinity)&&result.data.continuations?.[current.id]?undefined:current);}});}});
  // Only reads STARTED after acknowledgement may replace it; old successful reads are still stale.
  useEffect(()=>{
    if(!query.isSuccess)return;
    setReceipt(current=>current&&query.data.readSequence>(ackReads.current.get(current.id)??Infinity)&&query.data.continuations?.[current.id]?undefined:current);
  },[query.dataUpdatedAt,query.data,query.isSuccess]);
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
  const approvedRequests=query.data?.reconciliation?.requests.filter(r=>r.decision==="approved"&&!r.appliedAt)??[];
  const approved=approvedRequests.slice().reverse().find(row=>row.snapshot===query.data?.snapshot)??approvedRequests.at(-1);
  const continuation=approved?(receipt?.id===approved.id?receipt.continuation:undefined)??query.data?.continuations?.[approved.id]??
    (decide.data?.batchId===batchId?decide.data.continuation:undefined):undefined;
  const state=continuation?.state??(decide.data?.batchId===batchId&&decide.data.continuation?.queued?"queued":"not_sent");
  const statusKeys={not_sent:"recoveryApprovedSaved",queued:"recoveryContinueQueued",delivering:"recoveryContinueDelivering",
    delivery_unknown:"recoveryContinueUnknown",delivered:"recoveryContinueDelivered",failed:"recoveryContinueFailed",cancelled:"recoveryContinueCancelled"} as const;
  const reasonKeys={pending:"recoveryContinuePending",archived:"recoveryContinueArchived",revoked:"recoveryContinueRevoked",
    finished:"recoveryContinueFinished",managed:"recoveryContinueManaged",unavailable:"recoveryContinueUnavailable",
    send_failed:"recoveryContinueFailureHelp",delivery_failed:"recoveryContinueDeliveryFailed",not_ready:"recoveryContinueNotReady",scope_changed:"recoveryContinueStale"} as const;
  if(compact&&query.data&&!pending.length)return approved?<section role="status" className="merge-delivery-notice confirmed" data-continuation>
    <div className="merge-delivery-copy">
      <strong>{t(decide.isPending?"recoveryContinueSending":sendUnknown?"recoveryContinueUnknown":statusKeys[state])}</strong>
      {continuation?.reason&&<p role="alert">{t(reasonKeys[continuation.reason])}</p>}
      {query.isRefetchError&&<p role="alert">{t("recoveryContinueReadFailed")}</p>}
    </div>
    <div className="merge-actions">
    {!sendUnknown&&!continuation?.commandId&&["not_sent","failed"].includes(state)&&continuation?.reason!=="scope_changed"&&<button type="button" className="secondary-button" disabled={decide.isPending||query.isFetching||query.isRefetchError} onClick={()=>decide.mutate({id:approved.id,snapshot:approved.snapshot,decision:"approved"})}>{t("recoveryContinue")}</button>}
    {!decide.isPending&&<button type="button" className="text-button" disabled={query.isFetching} onClick={()=>void query.refetch().then(result=>{if(result.isSuccess){setSendUnknown(false);setReceipt(current=>current&&result.data&&result.data.readSequence>(ackReads.current.get(current.id)??Infinity)&&result.data.continuations?.[current.id]?undefined:current);}})}>{t("recoveryContinueCheck")}</button>}
    </div>
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
            {!candidate.historicalGapPreviouslyReviewed&&<p>{candidate.requiredArtifacts?.map(integrationArtifactName).join(" / ")||t("recoveryMissing")}</p>}
            {candidate.historicalGapReason&&<p>{t(candidate.historicalGapPreviouslyReviewed?"queueHistoricalGapReviewed":"recoveryHistoricalGap")}: {candidate.historicalGapReason}</p>}
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
