import { CloudUpload, GitMerge, Plus, TriangleAlert, Files } from "lucide-react";
import { modeProblem } from "./agent-mode-options";
import { HelpHint } from "./help-hint";
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
const checkImpact=(blocker?:string)=>blocker==="changed"?"mergeChangedImpact":blocker==="pending"?"mergePendingImpact":blocker==="failed"?"mergeFailedImpact":blocker==="conflicting"?"mergeConflictImpact":blocker==="dependency"?"mergeDependencyImpact":blocker?"mergeUnknownImpact":"mergePassedImpact";


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
  const integrationDefaults=useQuery({queryKey:["integration-defaults"],queryFn:api.getIntegrationDefaults});
  const needsDispatchFallback=!integrationDefaults.data?.nodeId;
  const saved=needsDispatchFallback ? defaults.data : integrationDefaults.data;
  const defaultsReady=integrationDefaults.isSuccess&&(!needsDispatchFallback||defaults.isSuccess);
  const [saveDefaultsFor,setSaveDefaultsFor]=useState<string|null>(null);
  const [selected,setSelected]=useState<Record<string,string>>({});
  const [config,setConfig]=useState<FreeSessionConfig>();
  const [publish,setPublish]=useState(false);
  const [step,setStep]=useState<1|2>(1);
  const [detail,setDetail]=useState<Delivery>();
  const initialConfig=useRef<string | undefined>(undefined);
  const frozen=useRef<{requestKey:string;selection:{id:string;revision:string}[];config:FreeSessionConfig;publish:boolean;saveAsDefault:boolean} | undefined>(undefined);
  const initialized=useRef(false);
  useEffect(()=>{
    if(initialized.current || !nodes.data || !saved || !integrationDefaults.isSuccess) return;
    const node=nodes.data.nodes.find(n=>n.id===saved.nodeId)??nodes.data.nodes.find(n=>n.online&&n.supportsFreeSessions&&n.repos.some(r=>r.productId===productId));
    const kind=saved.agentKind??node?.agents[0]?.kind;
    if(!node||!kind)return;
    initialized.current=true;
    const preference=saved.agents[kind];
    setConfig({productId,nodeId:node.id,agentKind:kind,mode:defaultAgentMode(kind,preference?.mode,node.agents.find(a=>a.kind===kind)?.modes,preference?.model),
      ...(preference?.model?{model:preference.model}:{}),...(preference?.effort?{effort:preference.effort}:{})});
  },[nodes.data,saved,integrationDefaults.isSuccess,productId]);
  const node=nodes.data?.nodes.find(n=>n.id===config?.nodeId);
  const models=config?agentModels(node,config.agentKind):undefined;
  useEffect(()=>{if(config&&initialConfig.current===undefined)initialConfig.current=JSON.stringify(config);},[config]);
  const defaultsKey=JSON.stringify([config?.nodeId,config?.agentKind,config?.mode,config?.model??"",config?.effort??""]);
  useEffect(()=>setSaveDefaultsFor(null),[defaultsKey]);
  const preference=config?integrationDefaults.data?.agents[config.agentKind]:undefined;
  const differsFromDefaults=Boolean(config && integrationDefaults.isSuccess && (integrationDefaults.data?.nodeId!==config.nodeId || integrationDefaults.data?.agentKind!==config.agentKind
    || preference?.mode!==config.mode || (preference?.model??"")!==(config.model??"") || (preference?.effort??"")!==(config.effort??"")));
  const saveAsDefault=differsFromDefaults&&saveDefaultsFor===defaultsKey;
  const start=useMutation({mutationFn:async()=>{
    if(!config)throw new Error("Missing configuration");
    frozen.current??={requestKey:crypto.randomUUID(),selection:Object.entries(selected).map(([id,revision])=>({id,revision})),config,publish,saveAsDefault};
    const f=frozen.current;
    return post<Batch>(`/api/v1/products/${productId}/merge-batches`,{...f.config,requestKey:f.requestKey,selection:f.selection,publish:f.publish,saveAsDefault:f.saveAsDefault,integrationProtocol:1});
  },onSuccess:b=>{
    void client.invalidateQueries({queryKey:["integration-defaults"]});
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
  const modeIssue=config?modeProblem(config.agentKind,config.mode,node?.agents.find(a=>a.kind===config.agentKind)?.modes,config.model):undefined;
  const modelUnavailable=Boolean(config?.model && (!models || !models.some(m=>m.id===config.model)));
  const configValid=Boolean(!modeIssue&&!modelUnavailable&&config&&node?.online&&node.supportsFreeSessions&&node.repos.some(r=>r.productId===productId)&&node.agents.some(a=>a.kind===config.agentKind&&a.ready!==false));
  return <><Modal title={t("mergePending")} subtitle={t("mergeSelectHelp")} onClose={onClose} wide scrolls
    dirty={!createdBatch&&(Boolean(selectedCount)||publish||saveAsDefault||Boolean(initialConfig.current&&JSON.stringify(config)!==initialConfig.current))} pending={start.isPending||openSession.isPending}>
    {close=><div className="merge-dialog">
      <ol className="merge-steps" aria-label={t("mergeSteps")}><li aria-current={step===1?"step":undefined}>{t("mergeStepSelect")}</li><li aria-current={step===2?"step":undefined}>{t("mergeStepConfigure")}</li></ol>
      {query.isPending&&<p role="status">{t("mergeLoading")}</p>}
      {query.isError&&<p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>}
      {openSession.isPending&&<p role="status">{t("agentSessionLoading")}</p>}
      {openSession.isError&&<p role="alert" className="inline-error">{t("mergeSessionOpenError")} <button type="button" className="secondary-button" onClick={()=>openSession.mutate(openSession.variables!)}>{t("retry")}</button></p>}
      {active&&<section role="status" className="merge-active-notice"><TriangleAlert size={22} aria-hidden="true"/><div><strong>{t("mergeActiveTitle")}</strong><p>{t("mergeActiveShort")}</p><small>{t("mergeActiveTimeout")}</small></div><button type="button" className="secondary-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(active.sessionId)}>{t("mergeOpenSession")}</button></section>}
      <div hidden={step!==1} className="merge-selection-step">
      <div className="merge-selection-toolbar"><span className="help-label"><strong>{t("mergeContentTitle")}</strong>{step===1&&<HelpHint title={t("mergeContentTitle")}><p>{t("mergeSelectionHelp")}</p><p>{t("mergeNeedsCheckHelp")}</p></HelpHint>}</span><button type="button" className="secondary-button" disabled={locked||!selectable.length} onClick={()=>setSelected(allSelected?{}:Object.fromEntries(selectable.map(d=>[d.id,d.revision])))}>{t(allSelected?"mergeDeselectAll":"mergeSelectAll")}</button></div>
      {query.isSuccess&&!candidates.length&&<section className="merge-empty"><Files size={28} aria-hidden="true"/><strong>{t("mergeEmptyTitle")}</strong><p>{t(active?"mergeEmptyActive":"mergeEmpty")}</p></section>}
      <div className="merge-list">{candidates.map(d=><div className="merge-row" key={d.id}>
        <label><input type="checkbox" checked={Boolean(selected[d.id])} disabled={locked||(d.blocker==="changed"&&!selected[d.id])}
          onChange={e=>setSelected(prev=>{const next={...prev};if(e.target.checked)next[d.id]=d.revision;else delete next[d.id];return next;})}/>
          <span><strong>{d.summary}</strong><small>{d.itemKeys.join(" · ") || `PR #${d.pullRequestUrl.split("/").at(-1)}`}</small><small>{t("mergeAffected")}: {d.requiredArtifacts.map(a=>a==="web"?"Web":a==="macosApp"?"macOS":a==="androidApp"?"Android":a).join(" / ") || d.noReleaseReason}</small><span className="merge-check" data-check={d.blocker??"passed"}><strong>{t(checkLabel(d.blocker))}</strong><small>{t(checkImpact(d.blocker))}</small></span></span></label>
        <button type="button" className="text-button merge-detail-button" onClick={()=>setDetail(d)}>{t("mergeDetails")}</button>
      </div>)}</div>
      </div>
      {!createdBatch&&!selectedValid&&<div role="alert" className="inline-error">{t("mergeSelectionChanged")} <button type="button" className="secondary-button" disabled={locked} onClick={()=>{setSelected(prev=>Object.fromEntries(Object.entries(prev).filter(([id,revision])=>selectable.some(d=>d.id===id&&d.revision===revision))));setStep(1);}}>{t("mergeReviewSelection")}</button></div>}
      {step===2&&<div className="merge-configuration-step">
      <p>{t(itemCount ? "mergeSelected" : "mergeSelectedGroups",{count:selectedCount,items:itemCount})}</p>
      <p className="integration-note">{t("mergeAuthorizationShort")}</p>
      <section className="merge-config"><div className="help-label"><strong>{t("mergeExecutor")}</strong><HelpHint title={t("mergeExecutor")}><p>{t("mergeExecutorHelp")}</p><p>{t("integrationAuthorization")}</p></HelpHint></div>
        <div className="merge-config-fields">
          <label>{t("mergeDevice")}<Select value={config?.nodeId??""} disabled={locked||!defaultsReady} onChange={e=>{
            const n=nodes.data?.nodes.find(n=>n.id===e.target.value);
            if(n){const kind=n.agents.find(a=>a.ready!==false)?.kind;if(kind)setConfig({productId,nodeId:n.id,agentKind:kind,mode:defaultAgentMode(kind,saved?.agents[kind]?.mode,n.agents.find(a=>a.kind===kind)?.modes)});}}}>
            <option value="">{t("mergeChoose")}</option>
            {nodes.data?.nodes.map(n=><option key={n.id} value={n.id} disabled={!n.online||!n.supportsFreeSessions||!n.repos.some(r=>r.productId===productId)}>{n.name}{!n.online?` · ${t("mergeOffline")}`:""}</option>)}
          </Select></label>
          <label>Agent<Select value={config?.agentKind??""} disabled={locked||!config} onChange={e=>{
            if(!config)return;const kind=e.target.value as AgentKind,a=node?.agents.find(a=>a.kind===kind);
            setConfig({productId,nodeId:config.nodeId,agentKind:kind,mode:defaultAgentMode(kind,saved?.agents[kind]?.mode,a?.modes)});
          }}><option value="">{t("mergeChoose")}</option>{node?.agents.map(a=><option key={a.kind} value={a.kind} disabled={a.ready===false}>{a.kind}</option>)}</Select></label>
        </div>
        {config&&<div className="merge-agent-settings agent-session-quick-settings"><AgentSettingsControls agentKind={config.agentKind} modes={node?.agents.find(a=>a.kind===config.agentKind)?.modes} models={models}
          mode={config.mode} model={config.model??""} effort={config.effort??""} allowLocalDefaults busy={locked} canChange={()=>!locked}
          onChange={change=>{const next={...config,...change};const reconciled=reconcileEffort(models,next);const {model:_m,effort:_e,...base}=next;setConfig({...base,...reconciled});}}/></div>}
      </section>
      {modeIssue&&<p role="status" className="inline-error">{t(modeIssue)}</p>}
      {modelUnavailable&&<p role="status" className="inline-error">{t("dispatchModelUnavailable",{model:config?.model??""})}</p>}
      {needsDispatchFallback&&defaults.isError&&<p role="alert" className="inline-error">{t("dispatchDefaultsUnavailable")} <button type="button" className="secondary-button" onClick={()=>void defaults.refetch()}>{t("retry")}</button></p>}
      {integrationDefaults.isError&&<p role="alert" className="inline-error">{t("mergeDefaultsUnavailable")} <button type="button" className="secondary-button" onClick={()=>void integrationDefaults.refetch()}>{t("retry")}</button></p>}
      {differsFromDefaults&&<div className="help-option"><label><input type="checkbox" checked={saveAsDefault} disabled={locked} onChange={e=>setSaveDefaultsFor(e.target.checked?defaultsKey:null)}/><span>{t("mergeDefault")}</span></label><HelpHint title={t("mergeDefault")}><p>{t("mergeDefaultHelp")}</p></HelpHint></div>}
      <div className="help-option"><label><input type="checkbox" checked={publish} disabled={locked} onChange={e=>setPublish(e.target.checked)}/><span>{t("mergePublish")}</span></label><HelpHint title={t("mergePublish")}><p>{t("mergePublishHelp")}</p></HelpHint><small className="integration-note">{t(publish?"mergeAndPublish":"mergeOnly")}</small></div>
      </div>}
      {start.isError&&<p role="alert" className="inline-error">{start.error instanceof ApiError && start.error.status<500 ? start.error.message : t("mergeStartError")}</p>}
      {active&&<p className="merge-next-blocked">{t("mergeBlockedNext")}</p>}
      <div className="form-footer merge-footer"><span>{t(itemCount ? "mergeSelected" : "mergeSelectedGroups",{count:selectedCount,items:itemCount})}</span>
        <button type="button" className="secondary-button" disabled={start.isPending||openSession.isPending} onClick={close}>{t("cancel")}</button>
        {step===2&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>setStep(1)}>{t("mergePrevious")}</button>}
        {step===1?<button type="button" className="primary-button" disabled={locked||Boolean(active)||!selectedCount||!selectedValid||query.isError} onClick={()=>setStep(2)}>{t("mergeNext")}</button>:
        <button type="button" className="primary-button" disabled={start.isPending||openSession.isPending||Boolean(active)||(!frozen.current&&(!configValid||!defaultsReady||!selectedCount||!selectedValid||query.isError))}
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
        <div className="help-label"><strong>{t(checkLabel((detailCurrent??detail).blocker))}</strong><HelpHint title={t("mergeNeedsCheck")}><p>{t("mergeNeedsCheckHelp")}</p></HelpHint></div><p>{t(checkImpact((detailCurrent??detail).blocker))}</p>
        <p>{t("mergeCommit")}: <code>{(detailCurrent??detail).head}</code></p>
        <p>{t("mergeChecked")}: {formatTime((detailCurrent??detail).evidence.checkedAt)} · {(detailCurrent??detail).evidence.source}</p>
        <a href={(detailCurrent??detail).pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a>
        <button type="button" className="secondary-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(detail.sessionId)}>{t("mergeOpenSource")}</button>
      </div>
    </Modal>}
  </>;
}
