import { useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { Modal } from "./modal";
import { MarkdownText } from "./markdown-text";
import { BackButton } from "./back-button";
import { useOverlay } from "./overlay";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import { currentPlan } from "./agent-plan-content";
import type { AgentPlanRecord, AgentSession } from "./types";

/** Display ordering only; authority is always supplied by the server. */
export const newestPlanRecord = (a:AgentPlanRecord,b:AgentPlanRecord) =>
  (Date.parse(b.submittedAt ?? "") || 0)-(Date.parse(a.submittedAt ?? "") || 0) || b.id-a.id;

export function AgentPlanRecords({session}:{session:AgentSession}) {
  const {t}=useI18n();
  const [open,setOpen]=useState(false);
  if(session.hasPlanRecords===false || !session.hasPlanRecords&&!currentPlan(session)) return null;
  return <>
    <button type="button" className="secondary-button" onClick={()=>setOpen(true)}>{t("agentPlanRecords")}</button>
    {open && <Modal className="agent-plan-modal" title={t("agentPlanRecords")} subtitle="" wide onClose={()=>setOpen(false)}>
      <PlanRecordDetails key={session.id} sessionId={session.id} />
    </Modal>}
  </>;
}

function PlanRecordDetails({sessionId}:{sessionId:string}) {
  const {t,locale}=useI18n();
  const [selected,setSelected]=useState<number>();
  const [parent,setParent]=useState<string>();
  const [historyOpen,setHistoryOpen]=useState(false);
  const [scrollable,setScrollable]=useState(false);
  const root=useRef<HTMLDivElement>(null),focusReturn=useRef<HTMLElement[]>([]),previous=useRef("list");
  const screen=parent ? "parent" : selected!==undefined ? "detail" : "list";
  const enter=(action:()=>void)=>{if(document.activeElement instanceof HTMLElement)focusReturn.current.push(document.activeElement);action();};
  useLayoutEffect(()=>{
    if(previous.current===screen)return;
    const back=screen==="list" || screen==="detail"&&previous.current==="parent";
    const target=back ? focusReturn.current.pop() : root.current?.querySelector<HTMLElement>(`[data-screen="${screen}"] button`);
    target?.focus({preventScroll:true});previous.current=screen;
  },[screen]);
  useOverlay(selected!==undefined,()=>setSelected(undefined));
  useOverlay(Boolean(parent),()=>setParent(undefined));
  const overview=useQuery({queryKey:["plan-overview",sessionId],queryFn:()=>api.getPlanOverview(sessionId),refetchInterval:5000});
  const pages=useInfiniteQuery({queryKey:["plan-records",sessionId],initialPageParam:undefined as number|undefined,enabled:historyOpen,
    queryFn:({pageParam})=>api.getPlanRecords(sessionId,pageParam),getNextPageParam:page=>page.nextBefore,refetchInterval:historyOpen?5000:false});
  const detail=useQuery({queryKey:["plan-record",sessionId,selected],enabled:selected!==undefined,
    queryFn:()=>api.getPlanRecords(sessionId,undefined,selected),refetchInterval:5000});
  const parentDocument=useQuery({queryKey:["plan-record-parent",sessionId,parent],enabled:Boolean(parent),queryFn:()=>api.getPlanDocument(parent!)});
  useLayoutEffect(()=>{
    const area=root.current?.querySelector<HTMLElement>(`[data-screen="${screen}"]`);
    if(!area) return;
    const measure=()=>setScrollable(area.scrollHeight>area.clientHeight+1);
    measure();
    const observer=new ResizeObserver(measure);observer.observe(area);
    return ()=>observer.disconnect();
  },[screen,overview.data,pages.data,detail.data,parentDocument.data,historyOpen]);
  const time=(value?:string)=>value ? new Date(value).toLocaleString(locale) : t("agentPlanUnknownTime");
  const version=(item:AgentPlanRecord)=>item.version ? `v${item.version}` : item.revision.slice(0,8);
  const status=(item:AgentPlanRecord)=>item.effective?"agentPlanEffective":item.kind==="rework"?(item.parentApproved?"agentPlanParentValid":"agentPlanParentInvalid"):item.approval?"agentPlanNotEffective":item.pending?"agentPlanPendingGroup":item.current?"agentPlanInvalid":"agentPlanHistorical";
  const source=(value:string)=>value==="web"?t("agentPlanSourceWeb"):value==="native"?t("agentPlanSourceNative"):value;
  const failure=(error:unknown,retry:()=>unknown)=><p className="inline-error" role="alert">{localizedErrorText(error,t)} <button type="button" className="text-button" onClick={()=>void retry()}>{t("retry")}</button></p>;
  const record=detail.data?.records[0];
  const records=[...(overview.data?.records??[])].sort(newestPlanRecord);
  const visibleIds=new Set(records.map(item=>item.id));
  const history=[...new Map(pages.data?.pages.flatMap(page=>page.records).map(item=>[item.id,item])??[]).values()].filter(item=>!visibleIds.has(item.id)).sort(newestPlanRecord);
  const metadata=(item:AgentPlanRecord)=><>
    {item.keys.length>0 && <p className="account-note">{item.rounds?.length?item.rounds.map(round=>t("planDocumentRound",{key:round.key,round:round.number})).join("、"):item.keys.join("、")}</p>}
    <p className="account-note">{t("agentPlanSubmitted")}：{time(item.submittedAt)}</p>
  </>;
  const original=(item:AgentPlanRecord)=><button type="button" className="text-button" onClick={()=>enter(()=>setSelected(item.id))}>{t("agentPlanReadVersion")}</button>;
  const card=(item:AgentPlanRecord)=><section key={item.id} className="agent-plan-version" aria-label={`${version(item)} · ${item.keys.join("、")}`}>
    <div className="agent-plan-card-heading"><h3>{version(item)}</h3><span className={`agent-plan-state ${item.effective?"effective":item.pending?"pending":""}`}>{t(status(item))}</span></div>
    {metadata(item)}
    {item.summary!==undefined?<MarkdownText>{item.summary}</MarkdownText>:<p className="account-note">{t("agentPlanNoSummary")}</p>}
    {item.parentDocumentId && <div className="agent-plan-parent-reference"><span>{t("agentPlanReferences",{version:(records.find(parent=>parent.documentId===item.parentDocumentId)?version(records.find(parent=>parent.documentId===item.parentDocumentId)!):t("agentPlanParentVersion"))})}</span><button type="button" className="text-button" onClick={()=>enter(()=>setParent(item.parentDocumentId))}>{t("agentPlanParent")}</button></div>}
    <div className="agent-plan-card-footer">
      {item.approval && <p><span className="account-note">{t("agentPlanApprovalTime")}</span><br/>{time(item.approval.approvedAt)} · {source(item.approval.source)}</p>}
      {original(item)}
    </div>
  </section>;
  const group=(title:"agentPlanPendingGroup"|"agentPlanEffectiveGroup"|"agentPlanReworkGroup"|"agentPlanInvalidGroup",items:AgentPlanRecord[])=>items.length>0 && <section className="agent-plan-group" aria-label={t(title)}><h3>{t(title)}</h3>{items.map(card)}</section>;
  const parentView=<>
    <div className="agent-plan-reading-toolbar"><BackButton label={t("agentPlanBackRecords")} onClick={()=>setParent(undefined)} /></div>
    {parentDocument.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {parentDocument.isError && failure(parentDocument.error,()=>parentDocument.refetch())}
    {parentDocument.data && <MarkdownText>{parentDocument.data.markdown}</MarkdownText>}
  </>;
  const detailView=<>
    <div className="agent-plan-reading-toolbar"><BackButton label={t("agentPlanBackRecords")} onClick={()=>setSelected(undefined)} /></div>
    {detail.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {detail.isError && failure(detail.error,()=>detail.refetch())}
    {record && <>
      <h3>{version(record)} · {record.keys.join("、")}</h3>
      <p>{t(status(record))}</p>
      {record.approval && <p>{t("agentPlanApprovalTime")}：{time(record.approval.approvedAt)} · {source(record.approval.source)}</p>}
      {record.parentDocumentId && <button type="button" className="text-button" onClick={()=>enter(()=>setParent(record.parentDocumentId))}>{t("agentPlanParent")}</button>}
      <details><summary>{t("agentPlanTechnicalDetails")}</summary><p className="account-note">SHA-256：{record.sha256??t("agentPlanUnknownTime")}</p></details>
      <MarkdownText>{record.markdown ?? [record.plan,record.validation].filter(Boolean).join("\n\n")}</MarkdownText>
    </>}
  </>;
  const listView=<>
    {overview.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {overview.isError && failure(overview.error,()=>overview.refetch())}
    {overview.data?.historyIncomplete && <p className="account-note">{t("agentPlanHistoryGap")}</p>}
    {overview.data && !records.length && !overview.data.hasHistory && <p>{t("agentPlanNoRecords")}</p>}
    {group("agentPlanPendingGroup",records.filter(item=>item.pending))}
    {group("agentPlanEffectiveGroup",records.filter(item=>item.effective))}
    {group("agentPlanReworkGroup",records.filter(item=>item.kind==="rework"))}
    {group("agentPlanInvalidGroup",records.filter(item=>item.kind==="proposal"&&!item.pending&&!item.effective))}
    {(overview.data?.hasHistory) && <details className="agent-plan-history" open={historyOpen} onToggle={event=>setHistoryOpen(event.currentTarget.open)}>
      <summary>{t("agentPlanHistoryGroup")}</summary>
      {historyOpen && <>
        {pages.isPending && <p role="status">{t("agentSessionLoading")}</p>}
        {pages.isError && failure(pages.error,()=>pages.refetch())}
        {history.map(item=><section key={item.id} className="agent-plan-history-row"><div><h4>{version(item)} · {t(item.kind==="rework"?"agentPlanRework":"agentPlanHistorical")}</h4>{metadata(item)}<p className="account-note">{t(status(item))}</p></div>{original(item)}</section>)}
        {pages.hasNextPage && <button type="button" className="secondary-button" disabled={pages.isFetchingNextPage} onClick={()=>void pages.fetchNextPage()}>{t("agentPlanMore")}</button>}
      </>}
    </details>}
  </>;
  return <div ref={root} className="agent-plan-details">
    <div className="agent-plan-screen" data-screen="list" tabIndex={0} aria-label={t("agentPlanScrollContent")} hidden={screen!=="list"}>{listView}</div>
    <div key={selected??"no-detail"} className="agent-plan-screen" data-screen="detail" tabIndex={0} aria-label={t("agentPlanScrollContent")} hidden={screen!=="detail"}>{detailView}</div>
    <div key={parent??"no-parent"} className="agent-plan-screen" data-screen="parent" tabIndex={0} aria-label={t("agentPlanScrollContent")} hidden={screen!=="parent"}>{parentView}</div>
    {scrollable && <p className="agent-plan-scroll-hint">{t("agentPlanScrollHint")}</p>}
  </div>;
}
