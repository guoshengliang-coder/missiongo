import { MergeReconciliation } from "./merge-reconciliation";
import type { MergeIntegration } from "@missiongo/contracts";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultAgentMode, type AgentKind } from "@missiongo/domain";
import { api, request, ApiError } from "./api";
import { Modal } from "./modal";
import { Select } from "./select";
import { AgentSettingsControls } from "./agent-session-settings";
import { agentModels, reconcileEffort } from "./agent-model-options";
import { useI18n } from "./i18n";
import type { FreeSessionConfig } from "./types";
import "./merge-console.css";
import { deriveMergeProgress, type MergeProgress } from "./merge-progress";

interface Delivery {
  id:string;productId:string;sessionId:string;revision:string;state:string;summary:string;validation:string;
  itemKeys:string[];head:string;requiredArtifacts:string[];noReleaseReason?:string;pullRequestUrl:string;
  blocker?:string;evidence:{checkedAt:string;source:string};
}
interface Batch {integration?:MergeIntegration;id:string;sessionId:string;state:string;deliveries:string[];publish:boolean;results:Record<string,{status:string;detail:string}>}
const post=<T,>(path:string,body:unknown)=>request<T>(path,{method:"POST",body:JSON.stringify(body)});
const useDeliveries=(productId:string)=>useQuery({
  queryKey:["merge-deliveries",productId],
  queryFn:()=>request<{deliveries:Delivery[];batches:Batch[]}>(`/api/v1/products/${encodeURIComponent(productId)}/merge-deliveries`),
  enabled:Boolean(productId),refetchInterval:15_000,
});

export function useMergeProgress(productId:string) {
  const query=useDeliveries(productId);
  return deriveMergeProgress(productId,query.data?.deliveries??[],query.data?.batches??[]);
}
export function MergeProgressBadge({state}:{state:MergeProgress | undefined}) {
  const {t}=useI18n();
  return state?<span className="item-handler-badge" data-merge-progress={state}>{t(state==="pending"?"mergePending":"mergeRunning")}</span>:null;
}
const checkLabel=(blocker?:string)=>blocker==="changed"?"mergeChanged":blocker==="pending"?"mergeCheckPending":blocker==="failed"?"mergeCheckFailed":blocker==="conflicting"?"mergeCheckConflict":blocker==="dependency"?"mergeCheckDependency":blocker?"mergeNeedsCheck":"mergeChecksPassed";

export function DeliveryCards({productId,sessionId}:{productId:string;sessionId:string}) {
  const {t,formatTime}=useI18n(),client=useQueryClient(),query=useDeliveries(productId);
  const mutation=useMutation({mutationFn:({d,decision}:{d:Delivery;decision:"confirm"|"withdraw"})=>
    post(`/api/v1/merge-deliveries/${d.id}/decision`,{revision:d.revision,decision}),
    onSuccess:()=>client.invalidateQueries({queryKey:["merge-deliveries",productId]})});
  const rows=query.data?.deliveries.filter(d=>d.sessionId===sessionId)??[];
  if(query.isError) return <p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>;
  const batches=query.data?.batches.filter(b=>b.sessionId===sessionId)??[];
  if(!rows.length&&!batches.length) return null;
  return <div className="merge-delivery-cards">{batches.map(b=><IntegrationProgress key={b.id} batch={b}/>)}{rows.map(d=><section className="merge-delivery-card" key={d.id}>
    <strong>{t(d.state==="proposed"?"mergeOffer":d.state==="confirmed"?"mergeConfirmed":"mergeInBatch")}</strong>
    <p>{d.summary}</p><small>{d.itemKeys.join(" · ")} · {d.requiredArtifacts.join(" / ") || d.noReleaseReason}</small>
    <details><summary>{t("mergeDetails")}</summary><p>{d.validation}</p>
      <a href={d.pullRequestUrl} target="_blank" rel="noreferrer">{d.pullRequestUrl}</a>
      <p>{t("mergeCommit")}: <code>{d.head}</code></p>
      <small>{t("mergeChecked")}: {formatTime(d.evidence.checkedAt)} · {d.evidence.source}</small>
    </details>
    {d.blocker && <p role="status">{t(d.blocker==="changed"?"mergeChanged":"mergeNeedsCheck")}</p>}
    {d.state!=="batched" && <div className="merge-actions">
      {d.state==="proposed" && <button type="button" className="secondary-button" disabled={mutation.isPending||d.blocker==="changed"}
        onClick={()=>mutation.mutate({d,decision:"confirm"})}>{t("mergeConfirm")}</button>}
      <button type="button" className="secondary-button" disabled={mutation.isPending}
        onClick={()=>mutation.mutate({d,decision:"withdraw"})}>{t("mergeContinue")}</button>
    </div>}
    {d.state!=="batched"&&<small>{t("mergeConfirmHelp")}</small>}
  </section>)}
  {mutation.isError&&<p role="alert" className="inline-error">{t("mergeChanged")}</p>}</div>;
}

export function PendingMergeButton({productId,onSession}:{productId:string;onSession:(id:string)=>void}) {
  const {t}=useI18n(),query=useDeliveries(productId);
  const [open,setOpen]=useState(false);
  useEffect(()=>setOpen(false),[productId]);
  const count=query.data?.deliveries.filter(d=>d.state==="confirmed"&&d.blocker!=="changed").length??0;
  return <>
    <button type="button" className="secondary-button merge-entry" onClick={()=>setOpen(true)}>
      {t("mergePending")} {query.isSuccess&&<span className="agent-unread-badge">{count}</span>}
    </button>
    {open&&<MergeDialog key={productId} productId={productId} onClose={()=>setOpen(false)}
      onSession={id=>{setOpen(false);onSession(id);}}/>}
  </>;
}

function MergeDialog({productId,onClose,onSession}:{productId:string;onClose:()=>void;onSession:(id:string)=>void}) {
  const {t,formatTime}=useI18n(),query=useDeliveries(productId);
  const nodes=useQuery({queryKey:["nodes"],queryFn:api.listNodes});
  const defaults=useQuery({queryKey:["dispatch-defaults"],queryFn:api.getDispatchDefaults});
  const [selected,setSelected]=useState<Record<string,string>>({});
  const [config,setConfig]=useState<FreeSessionConfig>();
  const [publish,setPublish]=useState(false);
  const frozen=useRef<{requestKey:string;selection:{id:string;revision:string}[];config:FreeSessionConfig;publish:boolean} | undefined>(undefined);
  const initialized=useRef(false);
  useEffect(()=>{
    if(initialized.current || !nodes.data || !defaults.data) return;
    initialized.current=true;
    const saved=defaults.data;
    const node=nodes.data.nodes.find(n=>n.id===saved.nodeId)??nodes.data.nodes.find(n=>n.online&&n.supportsFreeSessions&&n.repos.some(r=>r.productId===productId));
    const kind=saved.agentKind??node?.agents[0]?.kind;
    if(!node||!kind)return;
    const preference=saved.agents[kind];
    setConfig({productId,nodeId:node.id,agentKind:kind,mode:defaultAgentMode(kind,preference?.mode,node.agents.find(a=>a.kind===kind)?.modes,preference?.model),
      ...(preference?.model?{model:preference.model}:{}),...(preference?.effort?{effort:preference.effort}:{})});
  },[nodes.data,defaults.data,productId]);
  const node=nodes.data?.nodes.find(n=>n.id===config?.nodeId);
  const models=config?agentModels(node,config.agentKind):undefined;
  const start=useMutation({mutationFn:async()=>{
    if(!config)throw new Error("Missing configuration");
    frozen.current??={requestKey:crypto.randomUUID(),selection:Object.entries(selected).map(([id,revision])=>({id,revision})),config,publish};
    const f=frozen.current;
    return post<Batch>(`/api/v1/products/${productId}/merge-batches`,{...f.config,requestKey:f.requestKey,selection:f.selection,publish:f.publish,integrationProtocol:1});
  },onSuccess:b=>onSession(b.sessionId),onError:error=>{
    if(error instanceof ApiError && error.status>=400 && error.status<500) frozen.current=undefined;
    void query.refetch();
  }});
  const locked=start.isPending||Boolean(frozen.current);
  const active=query.data?.batches.find(b=>b.state==="active");
  const candidates=query.data?.deliveries.filter(d=>d.state==="confirmed")??[];
  const selectedValid=Object.entries(selected).every(([id,revision])=>candidates.some(d=>d.id===id&&d.revision===revision&&d.blocker!=="changed"));
  return <Modal title={t("mergePending")} subtitle={t("mergeSelectHelp")} onClose={onClose} wide scrolls
    dirty={Boolean(Object.keys(selected).length)||publish} pending={start.isPending}>
    {close=><div className="merge-dialog">
      {query.isPending&&<p role="status">{t("mergeLoading")}</p>}
      {query.isError&&<p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>}
      {active&&<section className="merge-delivery-card"><strong>{t("mergeActive")}</strong>
        <p>{t("mergeActiveHelp")}</p><IntegrationProgress batch={active}/><button type="button" className="secondary-button" onClick={()=>onSession(active.sessionId)}>{t("mergeOpenSession")}</button></section>}
      {query.isSuccess&&!candidates.length&&!active&&<p>{t("mergeEmpty")}</p>}
      <div className="merge-list">{candidates.map(d=><div className="merge-row" key={d.id}>
        <label><input type="checkbox" checked={Boolean(selected[d.id])} disabled={locked||Boolean(active)||(d.blocker==="changed"&&!selected[d.id])}
          onChange={e=>setSelected(prev=>{const next={...prev};if(e.target.checked)next[d.id]=d.revision;else delete next[d.id];return next;})}/>
          <span><strong>{d.itemKeys.join(" · ")} · {d.summary}</strong><small>{d.requiredArtifacts.join(" / ") || d.noReleaseReason} · {t(checkLabel(d.blocker))}</small></span></label>
        <details><summary>{t("mergeDetails")}</summary><p>{d.validation}</p><p><code>{d.head}</code></p>
          <p>{formatTime(d.evidence.checkedAt)} · {d.evidence.source}</p>
          <a href={d.pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a>{" · "}
          <button type="button" className="text-button" onClick={()=>onSession(d.sessionId)}>{t("mergeOpenSource")}</button>
          {d.blocker&&<p>{t(d.blocker==="changed"?"mergeChanged":"mergeNeedsCheckHelp")}</p>}
        </details>
      </div>)}</div>
      <p>{t("integrationAuthorization")}</p>
      <section className="merge-config"><strong>{t("mergeExecutor")}</strong><p>{t("mergeExecutorHelp")}</p>
        <div className="merge-config-fields">
          <label>{t("mergeDevice")}<Select value={config?.nodeId??""} disabled={locked} onChange={e=>{
            const n=nodes.data?.nodes.find(n=>n.id===e.target.value);
            if(n){const kind=n.agents.find(a=>a.ready!==false)?.kind;if(kind)setConfig({productId,nodeId:n.id,agentKind:kind,mode:defaultAgentMode(kind,defaults.data?.agents[kind]?.mode,n.agents.find(a=>a.kind===kind)?.modes)});}}}>
            <option value="">{t("mergeChoose")}</option>
            {nodes.data?.nodes.map(n=><option key={n.id} value={n.id} disabled={!n.online||!n.supportsFreeSessions||!n.repos.some(r=>r.productId===productId)}>{n.name}{!n.online?` · ${t("mergeOffline")}`:""}</option>)}
          </Select></label>
          <label>Agent<Select value={config?.agentKind??""} disabled={locked||!config} onChange={e=>{
            if(!config)return;const kind=e.target.value as AgentKind,a=node?.agents.find(a=>a.kind===kind);
            setConfig({productId,nodeId:config.nodeId,agentKind:kind,mode:defaultAgentMode(kind,defaults.data?.agents[kind]?.mode,a?.modes)});
          }}><option value="">{t("mergeChoose")}</option>{node?.agents.map(a=><option key={a.kind} value={a.kind} disabled={a.ready===false}>{a.kind}</option>)}</Select></label>
        </div>
        {config&&<AgentSettingsControls agentKind={config.agentKind} modes={node?.agents.find(a=>a.kind===config.agentKind)?.modes} models={models}
          mode={config.mode} model={config.model??""} effort={config.effort??""} allowLocalDefaults busy={locked} canChange={()=>!locked}
          onChange={change=>{const next={...config,...change};const reconciled=reconcileEffort(models,next);const {model:_m,effort:_e,...base}=next;setConfig({...base,...reconciled});}}/>}
      </section>
      <label className="merge-publish"><input type="checkbox" checked={publish} disabled={locked} onChange={e=>setPublish(e.target.checked)}/><span>{t("mergePublish")}<small>{t("mergePublishHelp")}</small></span></label>
      {start.isError&&<p role="alert" className="inline-error">{start.error instanceof ApiError && start.error.status<500 ? start.error.message : t("mergeStartError")}</p>}
      <div className="form-footer merge-footer"><span>{t("mergeSelected",{count:Object.keys(selected).length})}</span>
        <button type="button" className="secondary-button" disabled={start.isPending} onClick={close}>{t("cancel")}</button>
        <button type="button" className="primary-button" disabled={start.isPending||Boolean(active)||!config||!node?.online||!node.supportsFreeSessions||!Object.keys(selected).length||(!frozen.current&&!selectedValid)}
          onClick={()=>start.mutate()}>{t(start.isError&&frozen.current?"mergeRetry":"mergeStart",{count:Object.keys(selected).length})}</button>
      </div>
    </div>}
  </Modal>;
}

function IntegrationProgress({batch}:{batch:Batch}) {
  const {t,formatTime}=useI18n(),state=batch.integration;
  if(!state)return <section className="merge-delivery-card"><p>{t("integrationLegacy")}</p><MergeReconciliation batchId={batch.id}/></section>;
  const plan=state.plans.at(-1);
  const order=plan?.entries.map(e=>e.deliveryId)??Object.keys(state.entries);
  const labels={queued:"integrationQueued",investigating:"integrationInvestigating",repairing:"integrationRepairing",waiting_ci:"integrationWaiting",ready:"integrationReady",merged:"integrationMerged",blocked:"integrationBlocked"} as const;
  return <section className="merge-delivery-card integration-progress" aria-label={t("integrationTitle")}>
    <MergeReconciliation batchId={batch.id}/>
    <strong>{t(batch.state==="finished"?"integrationFinished":"integrationTitle")}</strong>
    {plan?<><p>{plan.summary}</p><p>{t("integrationValidation")}: {plan.validation}</p></>:<p>{t("integrationPlanning")}</p>}
    <ol>{order.map(id=>{const e=state.entries[id];if(!e)return null;const result=batch.results[id],step=plan?.entries.find(row=>row.deliveryId===id);
      const status=result?.status==="merged"?"merged":result?.status==="blocked"?"blocked":e.progress;
      return <li key={id}><strong>{e.itemKeys.join(" · ")}</strong>{" · "}<span>{t(labels[status])}</span>
        <p>{result?.detail||e.detail||step?.reason||t("integrationPlanning")}</p>
        {step&&<small>{t("integrationGroup")}: {step.group}{step.dependsOn.length?` · ${t("integrationDependencies")}: ${step.dependsOn.map(dep=>state.entries[dep]?.itemKeys.join(" / ")).join(" · ")}`:""}</small>}
        <details><summary>{t("integrationEvidence")}</summary>
          <p>{t("integrationOriginal")}: <code>{e.originalHead}</code></p><p>{t("integrationCurrent")}: <code>{e.head}</code></p>
          {e.repair&&<p>{t("integrationRepairPending")}: {e.repair.reason}</p>}
          {e.repairs.map(r=><div key={r.id}><p>{r.reason}</p><p><code>{r.fromHead}</code> → <code>{r.head}</code></p><p>{r.validation}</p><small>{formatTime(r.at)}</small></div>)}
          {e.check&&<p>{e.check.validation} · {formatTime(e.check.checkedAt)}</p>}
          {step&&<p>{t("integrationValidation")}: {step.validation}</p>}
        </details>
      </li>;
    })}</ol>
    {state.finalValidation&&<p>{t("integrationCombined")}: {state.finalValidation.validation}</p>}
    {batch.publish&&Object.values(batch.results).some(r=>r.status==="blocked")&&<p role="status">{t("integrationPublishHeld")}</p>}
    <details><summary>{t("integrationHistory")}</summary>
      {state.plans.map((p,i)=><p key={i}>{i+1}. {p.summary} · {formatTime(p.at)}</p>)}
      {state.events.map(e=><p key={e.id}>{e.detail} · {formatTime(e.at)}</p>)}
    </details>
  </section>;
}
