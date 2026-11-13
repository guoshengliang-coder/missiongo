import { CloudUpload, GitMerge, Plus, TriangleAlert, Files, History, ArrowRight } from "lucide-react";
import { modeProblem } from "./agent-mode-options";
import { HelpHint } from "./help-hint";
import { IntegrationProgress } from "./integration-details";
import { localizedErrorText } from "./error-text";
import type { MergeIntegration, MergeBatchPresentation, IntegrationQueueFacts, IntegrationActionMode, PublicationScope } from "@missiongo/contracts";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { defaultAgentMode, type AgentKind } from "@missiongo/domain";
import { api, request, ApiError } from "./api";
import { DispatchDialog } from "./dispatch-dialog";
import { MarkdownText } from "./markdown-text";
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
interface QueueDelivery extends Delivery {queue:IntegrationQueueFacts;latestInputAt?:string;previousReviews?:{caseId:string;sessionId:string;createdAt:string;closedAt?:string;closeNote?:string}[]}
const artifactName=(a:string)=>({web:"Web",macosApp:"macOS",androidApp:"Android",androidSdk:"Android SDK",linuxCli:"Linux CLI"}[a]??a);
function useIntegrationQueue(productId:string,stage="all") {
  return useInfiniteQuery({queryKey:["merge-deliveries",productId,"queue",stage],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam,signal})=>request<{deliveries:QueueDelivery[];counts:Record<string,number>;nextBeforeSequence?:number}>(`/api/v1/products/${encodeURIComponent(productId)}/integration-queue?stage=${stage}${pageParam?`&beforeSequence=${pageParam}`:""}`,{signal}),
    getNextPageParam:last=>last.nextBeforeSequence,enabled:Boolean(productId)});
}
function QueueFacts({d}:{d:Delivery}) {
  const {t}=useI18n(),q=(d as QueueDelivery).queue;if(!q)return null;
  return <><span className="item-handler-badge" data-merge-progress={q.stage==="merge"?"pending":q.stage==="history"?"published":"merged"}>{t(q.review?.closedAt?"reviewClosed":q.stage==="merge"?"queueMerge":q.stage==="review"?"queueReview":q.stage==="history"?(q.resolution==="historical"?"queueHistorical":q.resolution==="not_required"?"queueNotRequired":"queuePublished"):"queueRelease")}</span>
    {q.publishedArtifacts.length>0&&<small>{t("queuePublishedArtifacts")}: {q.publishedArtifacts.map(artifactName).join(" / ")}</small>}
    {q.stage!=="history"&&!q.review?.closedAt&&q.pendingArtifacts.length>0&&<small>{t("queuePendingArtifacts")}: {q.pendingArtifacts.map(artifactName).join(" / ")}</small>}
    {q.blocker&&<small className="integration-attention">{q.blocker}</small>}</>;
}
function QueueHistory({productId,onClose,onSession}:{productId:string;onClose:()=>void;onSession:(id:string)=>Promise<void>}) {
  const {t}=useI18n(),q=useIntegrationQueue(productId,"history"),reviews=useIntegrationQueue(productId,"reviewed"),open=useMutation({mutationFn:onSession});
  return <Modal title={t("queueHistory")} subtitle="" headerActions={<HelpHint title={t("queueHistory")}><p>{t("queueHistoryHelp")}</p></HelpHint>} onClose={onClose} wide scrolls>
    {[q,reviews].map((query,index)=><section key={index}>
      {index===1&&(!query.isSuccess||query.data.pages.some(p=>p.deliveries.length))&&<h3>{t("reviewPrevious")}</h3>}
      {query.isPending?<p role="status">{t("mergeLoading")}</p>:query.isError?<p role="alert">{t("mergeLoadError")} <button className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p>:<div className="merge-list">{query.data.pages.flatMap(p=>p.deliveries).map(d=><div className="merge-row" key={d.id}><div><strong>{d.summary}</strong><small>{d.itemKeys.join(" · ")||`PR #${d.pullRequestUrl.split("/").at(-1)}`}</small><QueueFacts d={d}/><details><summary>{t("mergeDetails")}</summary><p>{d.validation}</p><p>{d.noReleaseReason}</p>{d.queue.merge&&<p>{t("mergeCommit")}: <code>{d.queue.merge.commit}</code></p>}{d.queue.review?.closeNote&&<p>{t("reviewConclusion")}: {d.queue.review.closeNote}</p>}{d.queue.review?.sessionId&&<button type="button" className="secondary-button" disabled={open.isPending} onClick={()=>open.mutate(d.queue.review!.sessionId!)}>{t("reviewOpenSession")}</button>}{d.queue.releases?.map((r,i)=><p key={i}>{artifactName(r.artifact)} · {r.version}<br/><code>{r.sourceCommit}</code></p>)}<a href={d.pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a></details></div></div>)}</div>}
      {query.hasNextPage&&<button className="secondary-button" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{t("queueLoadMore")}</button>}
    </section>)}
    {open.isError&&<p role="alert" className="inline-error">{localizedErrorText(open.error,t)}</p>}
    {q.isSuccess&&reviews.isSuccess&&![...q.data.pages,...reviews.data.pages].some(p=>p.deliveries.length)&&<p>{t("queueHistoryEmpty")}</p>}
  </Modal>;
}
export interface Batch {operation?:IntegrationActionMode;references?:Record<string,{batchId:string;head:string;commit:string}>;verifiedReferences?:Record<string,{checkedAt:string;source:string}>;presentation?:MergeBatchPresentation;integration?:MergeIntegration;id:string;sessionId:string;state:string;deliveries:string[];publish:boolean;results:Record<string,{status:string;detail:string}>}
const post=<T,>(path:string,body:unknown)=>request<T>(path,{method:"POST",body:JSON.stringify(body)});
export const useDeliveries=(productId:string,sessionId?:string)=>useQuery({
  queryKey:sessionId ? ["merge-deliveries",productId,sessionId] : ["merge-deliveries",productId],
  queryFn:({signal})=>request<{deliveries:Delivery[];batches:Batch[];attentionSessionIds?:string[];sessionProgress?:Record<string,MergeProgress>}>(`/api/v1/products/${encodeURIComponent(productId)}/merge-deliveries${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,{signal}),
  enabled:Boolean(productId),
});

export function useMergeProgress(productId:string,sessionId?:string) {
  const query=useDeliveries(productId,sessionId);
  const progress = deriveMergeProgress(productId,query.data?.deliveries??[],query.data?.batches??[]);
  return { ...progress, sessions: query.data?.sessionProgress ? new Map(Object.entries(query.data.sessionProgress)) : progress.sessions };
}
const stageLabels = {pending:"mergePending",merging:"mergeRunning",publishing:"sessionPublishing",publication_unknown:"sessionPublicationUnknown",publication_partial:"sessionPublicationPartial",merged:"sessionMerged",published:"sessionPublished",partial:"sessionMergePartial",blocked:"sessionMergeBlocked"} as const;
export function SessionDeliveryNotice({productId,sessionId}:{productId:string;sessionId:string}) {
  const {t}=useI18n(), progress=useMergeProgress(productId,sessionId), state=progress.sessions.get(sessionId);
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
  const query=useDeliveries(productId,sessionId);
  return Boolean(query.data?.attentionSessionIds?.includes(sessionId)
    || query.data?.deliveries.some(d=>d.sessionId===sessionId && d.blocker!=="changed"
      && ["proposed","confirmed"].includes(d.state)));
}

/** Accepted sends invalidate the shared offer cache immediately, before polling catches up. */
export async function invalidateSessionDeliveries(client:ReturnType<typeof useQueryClient>,sessionId:string) {
  await client.cancelQueries({queryKey:["merge-deliveries"]});
  client.setQueriesData<{deliveries:Delivery[];attentionSessionIds?:string[];sessionProgress?:Record<string,MergeProgress>}>({queryKey:["merge-deliveries"],predicate:q=>!["queue","preview"].includes(String(q.queryKey[2]))},current=>current?{
    ...current,...(current.sessionProgress?{sessionProgress:Object.fromEntries(Object.entries(current.sessionProgress).filter(([id])=>id!==sessionId))}:{}),attentionSessionIds:current.attentionSessionIds?.filter(id=>id!==sessionId)??[],
    deliveries:current.deliveries.map(d=>d.sessionId===sessionId && ["proposed","confirmed"].includes(d.state)
      ? {...d,blocker:"changed"} : d),
  }:current);
  return client.invalidateQueries({queryKey:["merge-deliveries"]});
}

export function DeliveryCards({productId,sessionId,blocked=false}:{productId:string;sessionId:string;blocked?:boolean}) {
  const {t}=useI18n(),client=useQueryClient(),query=useDeliveries(productId,sessionId);
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
  const readError=query.isError ? <p role="alert" className="inline-error">{t("sessionDeliveryLoadError")} <button type="button" className="secondary-button" onClick={()=>void query.refetch()}>{t("retry")}</button></p> : null;
  if(!rows.length) return <>{readError}<SessionDeliveryNotice productId={productId} sessionId={sessionId}/></>;
  return <div className="merge-delivery-notices">{readError}{rows.map(d=><section role="status" className={`merge-delivery-notice ${d.state==="confirmed"?"confirmed":"proposed"}`} key={d.id}>
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
  const {t}=useI18n(),query=useDeliveries(productId,sessionId);
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
  const {t}=useI18n(),query=useIntegrationQueue(productId);
  const [open,setOpen]=useState(false);
  useEffect(()=>setOpen(false),[productId]);
  const counts=query.data?.pages[0]?.counts;
  const count=(counts?.merge??0)+(counts?.release??0);
  return <>
    <button type="button" className="secondary-button merge-entry" onClick={()=>setOpen(true)}>
      {t("integrationQueueTitle")} {query.isSuccess&&<span className="agent-unread-badge">{count}</span>}
    </button>
    {open&&<MergeDialog key={productId} productId={productId} onClose={()=>setOpen(false)}
      onSession={async id=>{await onSession(id);setOpen(false);}}/>}
  </>;
}

function MergeDialog({productId,onClose,onSession}:{productId:string;onClose:()=>void;onSession:(id:string)=>Promise<void>}) {
  const {t,formatTime}=useI18n(),query=useDeliveries(productId);
  const [stage,setStage]=useState("all"),[history,setHistory]=useState(false),[exceptions,setExceptions]=useState(false);
  const queue=useIntegrationQueue(productId,stage);
  const catalog=useRef(new Map<string,QueueDelivery>());
  for(const page of queue.data?.pages??[])for(const d of page.deliveries)catalog.current.set(d.id,d);
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
  const frozen=useRef<{requestKey:string;selection:{id:string;revision:string}[];config:FreeSessionConfig;publish:boolean;saveAsDefault:boolean;operation:IntegrationActionMode;scopeDigest?:string} | undefined>(undefined);
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
  if(stage==="all"&&queue.isSuccess&&!queue.hasNextPage) {
    const visible=new Set(queue.data.pages.flatMap(p=>p.deliveries.map(d=>d.id)));
    for(const id of Object.keys(selected))if(!visible.has(id))catalog.current.delete(id);
  }
  const chosen=Object.keys(selected).flatMap(id=>catalog.current.get(id)?[catalog.current.get(id)!]:[]);
  const hasMerge=chosen.some(d=>d.queue.stage==="merge");
  const hasArtifacts=chosen.some(d=>d.requiredArtifacts.length>0);
  const effectivePublish=hasArtifacts&&(publish||!hasMerge);
  const operation:IntegrationActionMode=effectivePublish?(hasMerge?"merge_and_publish":"publish_only"):"merge_only";
  const selection=Object.entries(selected).filter(([id])=>!hasMerge||effectivePublish||catalog.current.get(id)?.queue.stage==="merge").map(([id,revision])=>({id,revision}));
  const scope=useQuery({queryKey:["merge-deliveries",productId,"preview",selection],
    queryFn:()=>post<PublicationScope>(`/api/v1/products/${encodeURIComponent(productId)}/integration-preview`,{selection}),
    enabled:step===2&&effectivePublish&&selection.length>0,staleTime:0});
  const start=useMutation({mutationFn:async()=>{
    if(!config)throw new Error("Missing configuration");
    frozen.current??={requestKey:crypto.randomUUID(),selection,config,publish:effectivePublish,saveAsDefault,operation,...(effectivePublish&&scope.data?{scopeDigest:scope.data.digest}:{})};
    const f=frozen.current;
    return post<Batch>(`/api/v1/products/${productId}/merge-batches`,{...f.config,requestKey:f.requestKey,selection:f.selection,publish:f.publish,saveAsDefault:f.saveAsDefault,operation:f.operation,...(f.scopeDigest?{scopeDigest:f.scopeDigest}:{}),integrationProtocol:1});
  },onSuccess:b=>{
    void client.invalidateQueries({queryKey:["integration-defaults"]});
    setCreatedBatch(b);
    openSession.mutate(b.sessionId);
    void client.invalidateQueries({queryKey:["merge-deliveries",productId]});
  },onError:error=>{
    if(error instanceof ApiError && error.status>=400 && error.status<500) frozen.current=undefined;
    void query.refetch();void queue.refetch();if(effectivePublish)void scope.refetch();
  }});
  const locked=start.isPending||openSession.isPending||Boolean(frozen.current);
  const active=createdBatch??query.data?.batches.find(b=>b.state==="active");
  const candidates=queue.data?.pages.flatMap(p=>p.deliveries)??[];
  const selectable=candidates.filter(d=>d.blocker!=="changed"&&!d.queue.blocker&&d.queue.stage!=="review");
  const allSelected=selectable.length>0&&selectable.every(d=>selected[d.id]===d.revision);
  const selectedCount=Object.keys(selected).length;
  const mergeCount=chosen.filter(d=>d.queue.stage==="merge").length;
  const releaseCount=chosen.length-mergeCount;
  const extraScope=scope.data?.candidates.filter(c=>!c.selected)??[];
  const extraGroups=new Set(extraScope.map(c=>JSON.stringify(c.completion??c.identity))).size;
  const selectedValid=selection.every(({id,revision})=>chosen.some(d=>d.id===id&&d.revision===revision&&d.blocker!=="changed"&&!d.queue.blocker&&d.queue.stage!=="review"));
  const detailCurrent=detail?catalog.current.get(detail.id):undefined;
  const modeIssue=config?modeProblem(config.agentKind,config.mode,node?.agents.find(a=>a.kind===config.agentKind)?.modes,config.model):undefined;
  const modelUnavailable=Boolean(config?.model && (!models || !models.some(m=>m.id===config.model)));
  const configValid=Boolean(!modeIssue&&!modelUnavailable&&config&&node?.online&&node.supportsFreeSessions&&node.repos.some(r=>r.productId===productId)&&node.agents.some(a=>a.kind===config.agentKind&&a.ready!==false));
  return <><Modal title={t("integrationQueueTitle")} subtitle="" headerActions={<button type="button" className="icon-button" aria-label={t("queueHistory")} title={t("queueHistory")} disabled={locked} onClick={()=>setHistory(true)}><History size={20} aria-hidden="true"/></button>} onClose={onClose} wide scrolls
    dirty={!createdBatch&&(Boolean(selectedCount)||publish||saveAsDefault||Boolean(initialConfig.current&&JSON.stringify(config)!==initialConfig.current))} pending={start.isPending||openSession.isPending}>
    {()=><div className="merge-dialog">
      <ol className="merge-steps" aria-label={t("mergeSteps")}>{([1,2] as const).map(number=><li key={number} aria-current={step===number?"step":undefined} data-complete={step>number}><span className="merge-step-number">{number}</span><span>{t(number===1?"mergeStepSelect":"mergeStepConfigure")}</span>{number===1&&<ArrowRight className="merge-step-arrow" size={16} aria-hidden="true"/>}</li>)}</ol>
      {queue.isPending&&<p role="status">{t("mergeLoading")}</p>}
      {queue.isError&&<p role="alert" className="inline-error">{t("mergeLoadError")} <button type="button" className="secondary-button" onClick={()=>void queue.refetch()}>{t("retry")}</button></p>}
      {openSession.isPending&&<p role="status">{t("agentSessionLoading")}</p>}
      {openSession.isError&&<p role="alert" className="inline-error">{t("mergeSessionOpenError")} <button type="button" className="secondary-button" onClick={()=>openSession.mutate(openSession.variables!)}>{t("retry")}</button></p>}
      {active&&<section role="status" className="merge-active-notice"><TriangleAlert size={22} aria-hidden="true"/><div><strong>{t("mergeActiveTitle")}</strong><p>{t("mergeActiveShort")}</p><small>{t("mergeActiveTimeout")}</small></div><button type="button" className="secondary-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(active.sessionId)}>{t("mergeOpenSession")}</button></section>}
      <div hidden={step!==1} className="merge-selection-step">
      <div className="merge-queue-tabs"><div className="merge-actions" role="group" aria-label={t("queueStages")}>
        {(["all","merge","release"] as const).map(value=><button type="button" className="secondary-button" aria-pressed={stage===value} disabled={locked} key={value} onClick={()=>setStage(value)}>{t(value==="all"?"queueAll":value==="merge"?"queueMerge":"queueRelease")} {value==="all"?(queue.data?.pages[0]?.counts.merge??0)+(queue.data?.pages[0]?.counts.release??0):queue.data?.pages[0]?.counts[value]??0}</button>)}
      </div><button type="button" className="text-button" disabled={locked} onClick={()=>setExceptions(true)}>{t("reviewExceptions")} {queue.data?.pages[0]?.counts.review??0}</button></div>
      <div className="merge-selection-toolbar"><span className="help-label"><strong>{t(selectedCount?"mergeSelectedGroups":"mergeContentTitle",{count:selectedCount})}</strong>{step===1&&<HelpHint title={t("mergeContentTitle")}><p>{t("mergeSelectionHelp")}</p><p>{t("mergeNeedsCheckHelp")}</p></HelpHint>}</span><button type="button" className="secondary-button" disabled={locked||!selectable.length} onClick={()=>setSelected(prev=>{const next={...prev};for(const d of selectable)if(allSelected)delete next[d.id];else next[d.id]=d.revision;return next;})}>{t(allSelected?"mergeDeselectAll":"mergeSelectAll")}</button></div>
      {queue.isSuccess&&!candidates.length&&<section className="merge-empty"><Files size={28} aria-hidden="true"/><strong>{t("mergeEmptyTitle")}</strong><p>{t(active?"mergeEmptyActive":"mergeEmpty")}</p></section>}
      <div className="merge-list">{candidates.map(d=><div className="merge-row" key={d.id}>
        <label><input type="checkbox" checked={Boolean(selected[d.id])} disabled={locked||((d.blocker==="changed"||Boolean(d.queue.blocker)||d.queue.stage==="review")&&!selected[d.id])}
          onChange={e=>setSelected(prev=>{const next={...prev};if(e.target.checked)next[d.id]=d.revision;else delete next[d.id];return next;})}/>
          <span><strong>{d.summary}</strong><small>{d.itemKeys.join(" · ") || `PR #${d.pullRequestUrl.split("/").at(-1)}`}</small><small>{t("mergeAffected")}: {d.requiredArtifacts.map(a=>a==="web"?"Web":a==="macosApp"?"macOS":a==="androidApp"?"Android":a).join(" / ") || d.noReleaseReason}</small><QueueFacts d={d}/>{["failed","conflicting","dependency","changed"].includes(d.blocker??"")&&<span className="merge-check" data-check={d.blocker}><strong>{t(checkLabel(d.blocker))}</strong><small>{t(checkImpact(d.blocker))}</small></span>}</span></label>
        <button type="button" className="text-button merge-detail-button" onClick={()=>setDetail(d)}>{t("mergeDetails")}</button>
      </div>)}</div>
      {queue.hasNextPage&&<button type="button" className="secondary-button" disabled={queue.isFetchingNextPage} onClick={()=>void queue.fetchNextPage()}>{t("queueLoadMore")}</button>}
      </div>
      {!createdBatch&&!selectedValid&&<div role="alert" className="inline-error">{t("mergeSelectionChanged")} <button type="button" className="secondary-button" disabled={locked} onClick={()=>{setSelected(prev=>Object.fromEntries(Object.entries(prev).filter(([id,revision])=>selectable.some(d=>d.id===id&&d.revision===revision))));setStep(1);}}>{t("mergeReviewSelection")}</button></div>}
      {step===2&&<div className="merge-configuration-step">
      <section className="merge-config"><div className="help-label"><strong>{t("mergeExecutor")}</strong><HelpHint title={t("mergeExecutor")}><p>{t("mergeExecutorHelp")}</p><p>{t("integrationAuthorization")}</p><p>{t(operation==="publish_only"?"queuePublishOnlyHelp":"mergeAuthorizationShort")}</p></HelpHint></div>
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
      {hasMerge&&<div className="help-option"><label><input type="checkbox" checked={publish} disabled={locked} onChange={e=>setPublish(e.target.checked)}/><span>{t("mergePublish")}</span></label><HelpHint title={t("mergePublish")}><p>{t("mergePublishHelp")}</p></HelpHint></div>}
      {!hasMerge&&<p>{t(hasArtifacts?"queuePublishOnly":"queueNonRelease")}</p>}
      <section className="merge-scope merge-processing-scope"><div className="help-label"><h3>{t("queueProcessingScope")}</h3><HelpHint title={t("queueProcessingScope")}><p>{t("queueProcessingScopeHelp")}</p>{effectivePublish&&<p>{t("queueScopeHelp")}</p>}</HelpHint></div>
        {hasMerge&&!effectivePublish?<p className="merge-stage-summary">{t("queueSelectedMerge",{count:mergeCount})}</p>:<><details className="merge-selection-summary"><summary><span>{t("queueSelectedCount",{count:selectedCount})}</span><span>{t("queueView")}</span></summary>
          {chosen.map(d=><p key={d.id}><strong>{d.summary}</strong><br/>{d.itemKeys.join(" · ")||`PR #${d.pullRequestUrl.split("/").at(-1)}`} · {t(d.queue.stage==="merge"?"queueMerge":"queueRelease")}</p>)}
        </details>
        <p className="integration-note merge-stage-summary">{mergeCount>0&&<span>{t("queueMergeCount",{count:mergeCount})}</span>}{mergeCount>0&&releaseCount>0&&" · "}{releaseCount>0&&<span>{t("queueMergedCount",{count:releaseCount})}</span>}</p></>}
        {effectivePublish&&<><h4>{t("queuePublicationScope")}</h4>
        {scope.isPending?<p role="status">{t("queueScopeLoading")}</p>:scope.isError?<p role="alert" className="inline-error">{t("queueScopeError")} <button type="button" className="secondary-button" onClick={()=>void scope.refetch()}>{t("retry")}</button></p>:scope.data&&<>
          <p>{scope.data.requiredArtifacts.map(artifactName).join(" / ")}</p>
          {extraScope.length>0&&<details className="integration-attention merge-extra-scope"><summary><TriangleAlert size={16} aria-hidden="true"/><span>{t("queueExtraScopeCompact",{count:extraGroups})}</span><span>{t("queueView")}</span></summary><p>{t("queueExtraScopeHelp")}</p>{extraScope.map(c=><p key={c.identity}>{c.title} · {c.requiredArtifacts?.map(artifactName).join(" / ")}</p>)}</details>}
          {scope.data.exclusions?.map(e=><p className="integration-note" key={e.identity}>{e.title} · {e.reason}</p>)}
          {scope.data.blockers.map(b=><p className="inline-error" role="alert" key={b}>{b}</p>)}
          <details><summary>{t("queueScopeDetails")}</summary>{scope.data.candidates.map(c=><p key={c.identity}>{c.title} · {c.requiredArtifacts?.map(artifactName).join(" / ")}</p>)}</details>
        </>}
        </>}
      </section>
      </div>}
      {start.isError&&<p role="alert" className="inline-error">{start.error instanceof ApiError && start.error.status<500 ? start.error.message : t("mergeStartError")}</p>}
      {active&&<p className="merge-next-blocked">{t("mergeBlockedNext")}</p>}
      <div className="form-footer merge-footer">
        {step===2&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>setStep(1)}>{t("mergePrevious")}</button>}
        {step===1?<button type="button" className="primary-button" disabled={locked||Boolean(active)||!selectedCount||!selectedValid||queue.isError} onClick={()=>setStep(2)}>{t("mergeNext")}</button>:
        <button type="button" className="primary-button" disabled={start.isPending||openSession.isPending||Boolean(active)||(!frozen.current&&(!configValid||!defaultsReady||!selectedCount||!selectedValid||queue.isError||(effectivePublish&&(!scope.isSuccess||scope.isFetching||scope.data.blockers.length>0))))}
          onClick={()=>start.mutate()}>{t(start.isError&&frozen.current?"mergeRetry":"mergeStart",{count:selectedCount})}</button>}

      </div>
    </div>}
  </Modal>
    {exceptions&&<DeliveryExceptions productId={productId} onClose={()=>setExceptions(false)} onSession={onSession}/>}
    {history&&<QueueHistory productId={productId} onClose={()=>setHistory(false)} onSession={onSession}/>}
    {detail&&<Modal title={t("mergeDetails")} subtitle={detail.itemKeys.join(" · ") || `PR #${detail.pullRequestUrl.split("/").at(-1)}`} onClose={()=>setDetail(undefined)} pending={openSession.isPending} wide scrolls>
      <div className="merge-delivery-detail">
        <button type="button" className="secondary-button" data-initial-focus onClick={()=>setDetail(undefined)}>{t("mergeBackToSelection")}</button>
        <h3>{(detailCurrent??detail).summary}</h3>
        {openSession.isError&&<p role="alert" className="inline-error">{t("mergeSessionOpenError")} <button type="button" className="secondary-button" onClick={()=>openSession.mutate(openSession.variables!)}>{t("retry")}</button></p>}
        {(!detailCurrent||detailCurrent.revision!==detail.revision)&&<p role="alert" className="inline-error">{t("mergeSelectionChanged")}</p>}
        <p>{(detailCurrent??detail).validation}</p><QueueFacts d={detailCurrent??detail}/>
        <div className="help-label"><strong>{t(checkLabel((detailCurrent??detail).blocker))}</strong><HelpHint title={t("mergeNeedsCheck")}><p>{t("mergeNeedsCheckHelp")}</p></HelpHint></div><p>{t(checkImpact((detailCurrent??detail).blocker))}</p>
        <p>{t("mergeCommit")}: <code>{(detailCurrent??detail).head}</code></p>
        <p>{t("mergeChecked")}: {formatTime((detailCurrent??detail).evidence.checkedAt)} · {(detailCurrent??detail).evidence.source}</p>
        <a href={(detailCurrent??detail).pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a>
        <button type="button" className="secondary-button" disabled={openSession.isPending} onClick={()=>openSession.mutate(detail.sessionId)}>{t("mergeOpenSource")}</button>
      </div>
    </Modal>}
  </>;
}

/** Exception handling is outside the executable selection and its two-step flow. */
function DeliveryExceptions({productId,onClose,onSession}:{productId:string;onClose:()=>void;onSession:(id:string)=>Promise<void>}) {
  const {t}=useI18n(),q=useIntegrationQueue(productId,"review");
  const [selected,setSelected]=useState<QueueDelivery>();
  return <><Modal title={t("reviewExceptions")} subtitle={t("reviewExceptionsHelp")} onClose={onClose} wide scrolls>
    {q.isPending?<p role="status">{t("mergeLoading")}</p>:q.isError?<p role="alert">{t("mergeLoadError")} <button className="secondary-button" onClick={()=>void q.refetch()}>{t("retry")}</button></p>:<div className="merge-list">
      {q.data.pages.flatMap(p=>p.deliveries).map(d=><div className="merge-row" key={d.id}><div><strong>{d.itemKeys.join(" · ")||`PR #${d.pullRequestUrl.split("/").at(-1)}`}</strong><p>{d.summary}</p><QueueFacts d={d}/><button type="button" className="secondary-button" onClick={()=>setSelected(d)}>{t("reviewHandle")}</button></div></div>)}
      {!q.data.pages.some(p=>p.deliveries.length)&&<p>{t("reviewEmpty")}</p>}
    </div>}
    {q.hasNextPage&&<button type="button" className="secondary-button" disabled={q.isFetchingNextPage} onClick={()=>void q.fetchNextPage()}>{t("queueLoadMore")}</button>}
  </Modal>{selected&&<DeliveryReview productId={productId} delivery={selected} onClose={()=>setSelected(undefined)} onSession={onSession}/>}</>;
}
function DeliveryReview({productId,delivery,onClose,onSession}:{productId:string;delivery:QueueDelivery;onClose:()=>void;onSession:(id:string)=>Promise<void>}) {
  const {t}=useI18n(),client=useQueryClient();
  const context=useQuery({queryKey:["merge-deliveries",productId,"queue","review-detail",delivery.id],queryFn:()=>request<QueueDelivery>(`/api/v1/merge-deliveries/${delivery.id}/review`)});
  const current=context.data,review=current?.queue.review;
  const [configure,setConfigure]=useState(false),[finish,setFinish]=useState<{scopeDigest:string;caseId:string}>(),[note,setNote]=useState("");
  const frozen=useRef<{requestKey:string;revision:string;scopeDigest:string;config:FreeSessionConfig}|undefined>(undefined);
  const products=useQuery({queryKey:["products"],queryFn:()=>api.listProducts()});
  const session=useQuery({queryKey:["agent-session",review?.sessionId],queryFn:({signal})=>api.getAgentSession(review!.sessionId!,signal),enabled:Boolean(review?.sessionId)});
  const answer=[...(session.data?.messages??[])].reverse().find(m=>m.role==="agent"&&m.text.trim());
  const running=Boolean(session.data?.turnState?.turnActive||session.data?.status==="active");
  const unsettled=Boolean(session.data?.command&&["queued","delivering","delivery_unknown"].includes(session.data.command.status));
  const product=products.data?.find(p=>p.id===productId);
  const mayInvestigate=product?.access?.canOperate!==false&&product?.access?.canUseAi!==false;
  const latestInputAt=current?.latestInputAt;
  const freshAnswer=Boolean(answer&&Number.isFinite(Date.parse(answer.occurredAt))&&!(latestInputAt&&(!Number.isFinite(Date.parse(latestInputAt))||Date.parse(answer.occurredAt)<Date.parse(latestInputAt)))&&!(session.data?.command?.kind==="message"&&Date.parse(answer.occurredAt)<Date.parse(session.data.command.createdAt)));
  const status=session.data?.turnState?.waitingForInput?"reviewWaiting":running?"reviewRunning":session.isError||session.data&&["failed","stalled","unavailable"].includes(session.data.status)?"reviewFailed":answer?(freshAnswer?"reviewAnswer":"reviewStaleAnswer"):"reviewQueued";
  const refresh=()=>client.invalidateQueries({queryKey:["merge-deliveries",productId]});
  const open=useMutation({mutationFn:onSession});
  const start=useMutation({mutationFn:(config:FreeSessionConfig)=>{
    if(!current?.queue.review)throw Error("Missing current review scope");
    frozen.current??={requestKey:crypto.randomUUID(),revision:current.revision,scopeDigest:current.queue.review.scopeDigest,config};
    const f=frozen.current;return post<QueueDelivery>(`/api/v1/merge-deliveries/${delivery.id}/review`,{...f.config,revision:f.revision,scopeDigest:f.scopeDigest,requestKey:f.requestKey});
  },onSuccess:async()=>{setConfigure(false);frozen.current=undefined;await refresh();},onError:error=>{if(error instanceof ApiError&&error.status>=400&&error.status<500)frozen.current=undefined;}});
  const close=useMutation({mutationFn:()=>post<QueueDelivery>(`/api/v1/merge-deliveries/${delivery.id}/review/close`,{...finish,note}),onSuccess:async()=>{await refresh();onClose();},onError:()=>void context.refetch()});
  const canClose=Boolean(freshAnswer&&!running&&!session.data?.turnState?.waitingForInput&&!unsettled&&!session.isError&&!["failed","stalled","unavailable"].includes(session.data?.status??""));
  const finishChanged=Boolean(finish&&(review?.scopeDigest!==finish.scopeDigest||review?.caseId!==finish.caseId));
  return <><Modal title={t("reviewHandle")} subtitle={delivery.itemKeys.join(" · ")||delivery.summary} onClose={onClose} wide scrolls pending={start.isPending||close.isPending||open.isPending}>
    {context.isPending?<p role="status">{t("mergeLoading")}</p>:context.isError?<p role="alert">{context.error instanceof ApiError&&[404,409].includes(context.error.status)?t("reviewChanged"):localizedErrorText(context.error,t)} <button className="secondary-button" onClick={()=>void context.refetch()}>{t("retry")}</button></p>:current&&<div className="merge-delivery-detail">
      <strong>{current.summary}</strong><QueueFacts d={current}/><p>{t("reviewResponsibility")}</p><p>{t("reviewBoundary")}</p>
      <details><summary>{t("mergeDetails")}</summary><p>{current.validation}</p><p>{current.noReleaseReason}</p><a href={current.pullRequestUrl} target="_blank" rel="noreferrer">{t("mergeViewPR")}</a></details>
      {products.isError&&<p role="alert" className="inline-error">{t("reviewPermissionsError")} <button type="button" className="secondary-button" onClick={()=>void products.refetch()}>{t("retry")}</button></p>}
      {!mayInvestigate&&<p>{t("reviewNoPermission")}</p>}
      {current.previousReviews?.length? <details><summary>{t("reviewPrevious")}</summary>{current.previousReviews.map(r=><div key={r.caseId}><p>{r.closeNote||t("reviewScopeChanged")}</p><button type="button" className="secondary-button" onClick={()=>open.mutate(r.sessionId)}>{t("reviewOpenSession")}</button></div>)}</details>:null}
      {!review?.sessionId?<button type="button" className="primary-button" disabled={!mayInvestigate||!products.isSuccess} onClick={()=>setConfigure(true)}>{t("reviewDelegate")}</button>:<>
        <strong>{t(status)}</strong>{session.data&&<p>{t("reviewAssigned")}: {({codex:"Codex",claude_code:"Claude Code",opencode:"OpenCode",other:"Agent"} as Record<string,string>)[session.data.agentKind]??session.data.agentKind}</p>}
        <div className="merge-actions"><button type="button" className="secondary-button" disabled={open.isPending} onClick={()=>open.mutate(review.sessionId!)}>{t("reviewOpenSession")}</button><button type="button" className="secondary-button" onClick={()=>{void context.refetch();void session.refetch();}}>{t("reviewRefresh")}</button></div>
        {session.isPending&&<p role="status">{t("agentSessionLoading")}</p>}
        {session.isError&&<p role="alert" className="inline-error">{t("reviewSessionError")}</p>}
        {answer&&<section><h3>{t("reviewLatestAnswer")}</h3><MarkdownText>{answer.text}</MarkdownText>{session.data?.history?.nextCursor&&<p>{t("reviewMoreInSession")}</p>}</section>}
        {canClose&&!review.closedAt&&<button type="button" className="secondary-button" onClick={()=>setFinish({scopeDigest:review.scopeDigest,caseId:review.caseId!})}>{t("reviewFinish")}</button>}
        {review.closedAt&&<p>{t("reviewClosed")}: {review.closeNote}</p>}
      </>}
    </div>}
    {(open.isError||close.isError)&&<p role="alert" className="inline-error">{localizedErrorText(open.error??close.error,t)}</p>}
  </Modal>
  {finish&&<Modal title={t("reviewFinish")} subtitle={delivery.itemKeys.join(" · ")} onClose={()=>{setFinish(undefined);setNote("");}} dirty={Boolean(note.trim())} pending={close.isPending}>
    <form className="dispatch-form" onSubmit={e=>{e.preventDefault();if(!finishChanged&&canClose&&!context.isError)close.mutate();}}><p>{t("reviewCloseBoundary")}</p>{context.isError&&<p role="alert" className="inline-error">{context.error instanceof ApiError&&[404,409].includes(context.error.status)?t("reviewChanged"):localizedErrorText(context.error,t)} <button type="button" className="secondary-button" onClick={()=>void context.refetch()}>{t("retry")}</button></p>}{!canClose&&<p role="status">{t(session.isError?"reviewSessionError":"reviewIncomplete")} <button type="button" className="secondary-button" onClick={()=>{void context.refetch();void session.refetch();}}>{t("reviewRefresh")}</button></p>}{finishChanged&&<p role="alert" className="inline-error">{t("reviewChanged")}</p>}<label>{t("reviewConclusion")}<textarea data-initial-focus required maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} disabled={close.isPending}/></label><div className="form-footer"><button type="submit" className="primary-button" disabled={!note.trim()||close.isPending||finishChanged||!canClose||context.isError}>{t("reviewConfirmClose")}</button></div>{close.isError&&<p role="alert" className="inline-error">{localizedErrorText(close.error,t)}</p>}</form>
  </Modal>}
  {configure&&<Modal title={t("reviewDelegate")} subtitle={t("reviewBoundary")} onClose={()=>setConfigure(false)} pending={start.isPending}>
    {!frozen.current?<DispatchDialog items={[]} products={products.data?.filter(p=>p.id===productId)??[]} onClose={()=>setConfigure(false)} onDispatched={()=>{}} newSession={{productId,allowSaveDefaults:false,onConfigured:config=>start.mutate(config)}}/>:<><p role="status">{t(start.isPending?"reviewStarting":"reviewFrozen")}</p>{!start.isPending&&<button className="primary-button" onClick={()=>start.mutate(frozen.current!.config)}>{t("retry")}</button>}</>}
    {start.isError&&<p role="alert" className="inline-error">{localizedErrorText(start.error,t)}</p>}
  </Modal>}</>;
}
