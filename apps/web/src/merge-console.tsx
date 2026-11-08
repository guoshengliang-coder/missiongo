import { CloudUpload, GitMerge, Plus } from "lucide-react";
import { IntegrationProgress } from "./integration-details";
import { localizedErrorText } from "./error-text";
import type { MergeIntegration, MergeBatchPresentation } from "@missiongo/contracts";
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
  reconfirmation?:boolean;blocker?:string;evidence:{checkedAt:string;source:string};
}
export interface Batch {presentation?:MergeBatchPresentation;integration?:MergeIntegration;id:string;sessionId:string;state:string;deliveries:string[];publish:boolean;results:Record<string,{status:string;detail:string}>}
const post=<T,>(path:string,body:unknown)=>request<T>(path,{method:"POST",body:JSON.stringify(body)});
export const useDeliveries=(productId:string)=>useQuery({
  queryKey:["merge-deliveries",productId],
  queryFn:()=>request<{deliveries:Delivery[];batches:Batch[];attentionSessionIds?:string[];sessionProgress?:Record<string,MergeProgress>}>(`/api/v1/products/${encodeURIComponent(productId)}/merge-deliveries`),
  enabled:Boolean(productId),refetchInterval:15_000,
});

export function useMergeProgress(productId:string) {
  const query=useDeliveries(productId);
  const progress = deriveMergeProgress(productId,query.data?.deliveries??[],query.data?.batches??[]);
  return { ...progress, sessions: query.data?.sessionProgress ? new Map(Object.entries(query.data.sessionProgress)) : progress.sessions };
}
const stageLabels = {pending:"mergePending",merging:"mergeRunning",publishing:"sessionPublishing",publication_unknown:"sessionPublicationUnknown",publication_partial:"sessionPublicationPartial",merged:"sessionMerged",published:"sessionPublished",partial:"sessionMergePartial",blocked:"sessionMergeBlocked"} as const;
export function SessionDeliveryNotice({productId,sessionId}:{productId:string;sessionId:string}) {
  const {t}=useI18n(), progress=useMergeProgress(productId), state=progress.sessions.get(sessionId);
  if(!state)return null;
  return <section role="status" className="merge-delivery-notice confirmed" data-session-delivery={state}>
    <span className="merge-delivery-icon" aria-hidden="true">{state==="publishing"||state==="published"?<CloudUpload size={21}/>:<GitMerge size={21}/>}</span>
    <div className="merge-delivery-copy"><strong>{t(state==="pending"?"mergeConfirmed":stageLabels[state])}</strong>
      <p>{t(state==="pending"?"mergeAutoWithdraw":state==="merged"||state==="published"?"sessionCompletionHint":state==="merging"||state==="publishing"?"sessionIntegrationHint":"sessionDeliveryReviewHint")}</p>
    </div>
  </section>;
}
export function MergeProgressBadge({state}:{state:MergeProgress | undefined}) {
  const {t}=useI18n();
  return state?<span className="item-handler-badge" data-merge-progress={state}>{state==="published"||state==="publishing"?<CloudUpload size={12} aria-hidden="true"/>:<GitMerge size={12} aria-hidden="true"/>}{t(stageLabels[state])}</span>:null;
}
const checkLabel=(blocker?:string)=>blocker==="changed"?"mergeChanged":blocker==="pending"?"mergeCheckPending":blocker==="failed"?"mergeCheckFailed":blocker==="conflicting"?"mergeCheckConflict":blocker==="dependency"?"mergeCheckDependency":blocker?"mergeNeedsCheck":"mergeChecksPassed";

/** Only explicit, current offers replace generic completion attention. Approval and fault UI stays independent. */
export function useDeliveryAttention(productId:string,sessionId:string) {
  const query=useDeliveries(productId);
  return Boolean(query.data?.attentionSessionIds?.includes(sessionId)
    || query.data?.deliveries.some(d=>d.sessionId===sessionId && d.blocker!=="changed"
      && ["proposed","confirmed"].includes(d.state)));
}

/** Accepted sends invalidate the shared offer cache immediately, before polling catches up. */
export async function invalidateSessionDeliveries(client:ReturnType<typeof useQueryClient>,sessionId:string) {
  await client.cancelQueries({queryKey:["merge-deliveries"]});
  client.setQueriesData<{deliveries:Delivery[];attentionSessionIds?:string[];sessionProgress?:Record<string,MergeProgress>}>({queryKey:["merge-deliveries"]},current=>current?{
    ...current,...(current.sessionProgress?{sessionProgress:Object.fromEntries(Object.entries(current.sessionProgress).filter(([id])=>id!==sessionId))}:{}),attentionSessionIds:current.attentionSessionIds?.filter(id=>id!==sessionId)??[],
    deliveries:current.deliveries.map(d=>d.sessionId===sessionId && ["proposed","confirmed"].includes(d.state)
      ? {...d,blocker:"changed"} : d),
  }:current);
  return client.invalidateQueries({queryKey:["merge-deliveries"]});
}

export function DeliveryCards({productId,sessionId,blocked=false}:{productId:string;sessionId:string;blocked?:boolean}) {
  const {t}=useI18n(),client=useQueryClient(),query=useDeliveries(productId);
  const locks=useRef(new Set<string>());
  const mutation=useMutation({mutationFn:({d,decision}:{d:Delivery;decision:"confirm"|"withdraw"})=>
    post(`/api/v1/merge-deliveries/${d.id}/decision`,{revision:d.revision,decision}),
    onSettled:async(_data,_error,input)=>{
      await Promise.all([client.invalidateQueries({queryKey:["merge-deliveries",productId]}),
        client.invalidateQueries({queryKey:["agent-sessions"]})]);
      locks.current.delete(input.d.id);
    }});
  const choose=(d:Delivery,decision:"confirm"|"withdraw")=>{
    if(locks.current.has(d.id))return;
    locks.current.add(d.id);mutation.mutate({d,decision});
  };
  const rows=query.data?.deliveries.filter(d=>d.sessionId===sessionId && d.blocker!=="changed"
    && d.state==="proposed")??[];
  if(query.isError) return <p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>;
  if(!rows.length) return <SessionDeliveryNotice productId={productId} sessionId={sessionId}/>;
  return <div className="merge-delivery-notices">{rows.map(d=><section role="status" className={`merge-delivery-notice ${d.state==="confirmed"?"confirmed":"proposed"}`} key={d.id}>
    <span className="merge-delivery-icon" aria-hidden="true">{d.state==="confirmed"?<GitMerge size={21}/>:<Plus size={18}/>}</span>
    <div className="merge-delivery-copy"><strong>{t(d.state==="confirmed"?"mergeConfirmed":d.reconfirmation?"mergeReoffer":"mergeOffer")}</strong>
      {d.state==="confirmed"&&<p>{t("mergeAutoWithdraw")}</p>}
    </div>
    {d.state==="proposed"&&<div className="merge-delivery-choices">
      <button type="button" className="secondary-button" disabled={blocked||mutation.isPending}
        onClick={()=>choose(d,"withdraw")}>{t("mergeDecline")}</button>
      <button type="button" className="primary-button" disabled={blocked||mutation.isPending}
        onClick={()=>choose(d,"confirm")}>{t(d.reconfirmation?"mergeReconfirm":"mergeConfirm")}</button>
    </div>}
  </section>)}
  <SessionDeliveryNotice productId={productId} sessionId={sessionId}/>
  {mutation.isError&&<p role="alert" className="inline-error">{localizedErrorText(mutation.error,t)}</p>}</div>;
}

/** Batch bookkeeping is deliberately outside the native transcript. */
export function IntegrationDetails({productId,sessionId}:{productId:string;sessionId:string}) {
  const {t}=useI18n(),query=useDeliveries(productId);
  const [open,setOpen]=useState(false);
  useEffect(()=>setOpen(false),[productId,sessionId]);
  const batches=query.data?.batches.filter(batch=>batch.sessionId===sessionId)??[];
  if(!batches.length)return null;
  return <>
    <button type="button" className="secondary-button" onClick={()=>setOpen(true)}>{t("integrationDetails")}</button>
    {open&&<Modal title={t("integrationDetails")} subtitle="" onClose={()=>setOpen(false)} wide scrolls className="integration-modal">
      {batches.map(batch=><IntegrationProgress key={batch.id} batch={batch}/>)}
    </Modal>}
  </>;
}

export function PendingMergeButton({productId,onSession}:{productId:string;onSession:(id:string)=>Promise<void>}) {
  const {t}=useI18n(),query=useDeliveries(productId);
  const [open,setOpen]=useState(false);
  useEffect(()=>setOpen(false),[productId]);
  const count=query.data?.deliveries.filter(d=>d.state==="confirmed"&&d.blocker!=="changed").length??0;
  return <>
    <button type="button" className="secondary-button merge-entry" onClick={()=>setOpen(true)}>
      {t("mergePending")} {query.isSuccess&&<span className="agent-unread-badge">{count}</span>}
    </button>
    {open&&<MergeDialog key={productId} productId={productId} onClose={()=>setOpen(false)}
      onSession={async id=>{await onSession(id);setOpen(false);}}/>}
  </>;
}

function MergeDialog({productId,onClose,onSession}:{productId:string;onClose:()=>void;onSession:(id:string)=>Promise<void>}) {
  const {t,formatTime}=useI18n(),query=useDeliveries(productId);
  const client=useQueryClient();
  const [createdBatch,setCreatedBatch]=useState<Batch>();
  const openSession=useMutation({mutationFn:onSession});
  const nodes=useQuery({queryKey:["nodes"],queryFn:api.listNodes});
  const defaults=useQuery({queryKey:["dispatch-defaults"],queryFn:api.getDispatchDefaults});
  const [selected,setSelected]=useState<Record<string,string>>({});
  const [config,setConfig]=useState<FreeSessionConfig>();
  const [publish,setPublish]=useState(false);
  const [step,setStep]=useState<1|2>(1);
  const [detail,setDetail]=useState<Delivery>();
  const initialConfig=useRef<string | undefined>(undefined);
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
  useEffect(()=>{if(config&&initialConfig.current===undefined)initialConfig.current=JSON.stringify(config);},[config]);
  const start=useMutation({mutationFn:async()=>{
    if(!config)throw new Error("Missing configuration");
    frozen.current??={requestKey:crypto.randomUUID(),selection:Object.entries(selected).map(([id,revision])=>({id,revision})),config,publish};
    const f=frozen.current;
    return post<Batch>(`/api/v1/products/${productId}/merge-batches`,{...f.config,requestKey:f.requestKey,selection:f.selection,publish:f.publish,integrationProtocol:1});
  },onSuccess:b=>{
    setCreatedBatch(b);
    openSession.mutate(b.sessionId);
    void client.invalidateQueries({queryKey:["merge-deliveries",productId]});
  },onError:error=>{
    if(error instanceof ApiError && error.status>=400 && error.status<500) frozen.current=undefined;
    void query.refetch();
  }});
  const locked=start.isPending||openSession.isPending||Boolean(frozen.current);
  const active=createdBatch??query.data?.batches.find(b=>b.state==="active");
  const candidates=query.data?.deliveries.filter(d=>d.state==="confirmed")??[];
  const selectable=candidates.filter(d=>d.blocker!=="changed");
  const allSelected=selectable.length>0&&selectable.every(d=>selected[d.id]===d.revision);
  const selectedCount=Object.keys(selected).length;
  const itemCount=new Set(candidates.filter(d=>selected[d.id]).flatMap(d=>d.itemKeys)).size;
  const selectedValid=Object.entries(selected).every(([id,revision])=>candidates.some(d=>d.id===id&&d.revision===revision&&d.blocker!=="changed"));
  const detailCurrent=detail?query.data?.deliveries.find(d=>d.id===detail.id):undefined;
  const configValid=Boolean(config&&node?.online&&node.supportsFreeSessions&&node.repos.some(r=>r.productId===productId)&&node.agents.some(a=>a.kind===config.agentKind&&a.ready!==false));
  return <><Modal title={t("mergePending")} subtitle={t("mergeSelectHelp")} onClose={onClose} wide scrolls
    dirty={!createdBatch&&(Boolean(selectedCount)||publish||Boolean(initialConfig.current&&JSON.stringify(config)!==initialConfig.current))} pending={start.isPending||openSession.isPending}>
    {close=><div className="merge-dialog">
      <ol className="merge-steps" aria-label={t("mergeSteps")}><li aria-current={step===1?"step":undefined}>{t("mergeStepSelect")}</li><li aria-current={step===2?"step":undefined}>{t("mergeStepConfigure")}</li></ol>
      {query.isPending&&<p role="status">{t("mergeLoading")}</p>}
      {query.isError&&<p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>}
      {openSession.isPending&&<p role="status">{t("agentSessionLoading")}</p>}
      {openSession.isError&&<p role="alert" className="inline-error">{t("mergeSessionOpenError")} <button type="button" className="secondary-button" onClick={()=>openSession.mutate(openSession.variables!)}>{t("retry")}</button></p>}
      {active&&<p role="status" className="merge-active-notice">{t("mergeActive")} · {t("mergeActiveHelp")} <button type="button" className="text-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(active.sessionId)}>{t("mergeOpenSession")}</button></p>}
      <div hidden={step!==1} className="merge-selection-step">
      {query.isSuccess&&!candidates.length&&<p>{t("mergeEmpty")}</p>}
      {candidates.length>0&&<div className="merge-selection-toolbar"><button type="button" className="secondary-button" disabled={locked||!selectable.length} onClick={()=>setSelected(allSelected?{}:Object.fromEntries(selectable.map(d=>[d.id,d.revision])))}>{t(allSelected?"mergeDeselectAll":"mergeSelectAll")}</button><span>{t("mergeSelectionHelp")}</span></div>}
      <div className="merge-list">{candidates.map(d=><div className="merge-row" key={d.id}>
        <label><input type="checkbox" checked={Boolean(selected[d.id])} disabled={locked||(d.blocker==="changed"&&!selected[d.id])}
          onChange={e=>setSelected(prev=>{const next={...prev};if(e.target.checked)next[d.id]=d.revision;else delete next[d.id];return next;})}/>
          <span><strong>{d.summary}</strong><small>{d.itemKeys.join(" · ") || `PR #${d.pullRequestUrl.split("/").at(-1)}`}</small><small>{t("mergeAffected")}: {d.requiredArtifacts.map(a=>a==="web"?"Web":a==="macosApp"?"macOS":a==="androidApp"?"Android":a).join(" / ") || d.noReleaseReason} · {t(checkLabel(d.blocker))}</small></span></label>
        <button type="button" className="text-button merge-detail-button" onClick={()=>setDetail(d)}>{t("mergeDetails")}</button>
      </div>)}</div>
      </div>
      {!createdBatch&&!selectedValid&&<div role="alert" className="inline-error">{t("mergeSelectionChanged")} <button type="button" className="secondary-button" disabled={locked} onClick={()=>{setSelected(prev=>Object.fromEntries(Object.entries(prev).filter(([id,revision])=>selectable.some(d=>d.id===id&&d.revision===revision))));setStep(1);}}>{t("mergeReviewSelection")}</button></div>}
      {step===2&&<div className="merge-configuration-step">
      <p>{t(itemCount ? "mergeSelected" : "mergeSelectedGroups",{count:selectedCount,items:itemCount})}</p>
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
        {config&&<div className="merge-agent-settings agent-session-quick-settings"><AgentSettingsControls agentKind={config.agentKind} modes={node?.agents.find(a=>a.kind===config.agentKind)?.modes} models={models}
          mode={config.mode} model={config.model??""} effort={config.effort??""} allowLocalDefaults busy={locked} canChange={()=>!locked}
          onChange={change=>{const next={...config,...change};const reconciled=reconcileEffort(models,next);const {model:_m,effort:_e,...base}=next;setConfig({...base,...reconciled});}}/></div>}
      </section>
      <label className="merge-publish"><input type="checkbox" checked={publish} disabled={locked} onChange={e=>setPublish(e.target.checked)}/><span>{t("mergePublish")}<small>{t("mergePublishHelp")}</small></span></label>
      </div>}
      {start.isError&&<p role="alert" className="inline-error">{start.error instanceof ApiError && start.error.status<500 ? start.error.message : t("mergeStartError")}</p>}
      <div className="form-footer merge-footer"><span>{t(itemCount ? "mergeSelected" : "mergeSelectedGroups",{count:selectedCount,items:itemCount})}</span>
        <button type="button" className="secondary-button" disabled={start.isPending||openSession.isPending} onClick={close}>{t("cancel")}</button>
        {step===2&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>setStep(1)}>{t("mergePrevious")}</button>}
        {step===1?<button type="button" className="primary-button" disabled={locked||!selectedCount||!selectedValid||query.isError} onClick={()=>setStep(2)}>{t("mergeNext")}</button>:
        <button type="button" className="primary-button" disabled={start.isPending||openSession.isPending||Boolean(active)||(!frozen.current&&(!configValid||!selectedCount||!selectedValid||query.isError))}
          onClick={()=>start.mutate()}>{t(start.isError&&frozen.current?"mergeRetry":"mergeStart",{count:selectedCount})}</button>}

      </div>
    </div>}
  </Modal>
    {detail&&<Modal title={t("mergeDetails")} subtitle={detail.itemKeys.join(" · ") || `PR #${detail.pullRequestUrl.split("/").at(-1)}`} onClose={()=>setDetail(undefined)} pending={openSession.isPending} wide scrolls>
      <div className="merge-delivery-detail">
        <button type="button" className="secondary-button" data-initial-focus onClick={()=>setDetail(undefined)}>{t("mergeBackToSelection")}</button>
        <h3>{(detailCurrent??detail).summary}</h3>
        {openSession.isError&&<p role="alert" className="inline-error">{t("mergeSessionOpenError")} <button type="button" className="secondary-button" onClick={()=>openSession.mutate(openSession.variables!)}>{t("retry")}</button></p>}
        {(!detailCurrent||detailCurrent.revision!==detail.revision)&&<p role="alert" className="inline-error">{t("mergeSelectionChanged")}</p>}
        <p>{(detailCurrent??detail).validation}</p>
        <p>{t(checkLabel((detailCurrent??detail).blocker))}</p><p>{t("mergeNeedsCheckHelp")}</p>
        <p>{t("mergeCommit")}: <code>{(detailCurrent??detail).head}</code></p>
        <p>{t("mergeChecked")}: {formatTime((detailCurrent??detail).evidence.checkedAt)} · {(detailCurrent??detail).evidence.source}</p>
        <a href={(detailCurrent??detail).pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a>
        <button type="button" className="secondary-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(detail.sessionId)}>{t("mergeOpenSource")}</button>
      </div>
    </Modal>}
  </>;
}
