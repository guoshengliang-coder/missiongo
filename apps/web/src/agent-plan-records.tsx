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
import type { AgentSession } from "./types";

export function AgentPlanRecords({session}:{session:AgentSession}) {
  const {t}=useI18n();
  const [open,setOpen]=useState(false);
  if(session.hasPlanRecords===false || !session.hasPlanRecords&&!currentPlan(session)) return null;
  return <>
    <button type="button" className="secondary-button" onClick={()=>setOpen(true)}>{t("agentPlanRecords")}</button>
    {open && <Modal title={t("agentPlanRecords")} subtitle="" wide scrolls onClose={()=>setOpen(false)}>
      <PlanRecordDetails key={session.id} sessionId={session.id} />
    </Modal>}
  </>;
}

function PlanRecordDetails({sessionId}:{sessionId:string}) {
  const {t,locale}=useI18n();
  const [selected,setSelected]=useState<number>();
  const [parent,setParent]=useState<string>();
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
  const pages=useInfiniteQuery({queryKey:["plan-records",sessionId],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>api.getPlanRecords(sessionId,pageParam),getNextPageParam:page=>page.nextBefore});
  const detail=useQuery({queryKey:["plan-record",sessionId,selected],enabled:selected!==undefined,
    queryFn:()=>api.getPlanRecords(sessionId,undefined,selected)});
  const parentDocument=useQuery({queryKey:["plan-record-parent",sessionId,parent],enabled:Boolean(parent),queryFn:()=>api.getPlanDocument(parent!)});
  const time=(value?:string)=>value ? new Date(value).toLocaleString(locale) : t("agentPlanUnknownTime");
  const record=detail.data?.records[0];
  const parentView=<>
    <BackButton label={t("agentPlanBackRecords")} onClick={()=>setParent(undefined)} />
    {parentDocument.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {parentDocument.isError && <p className="inline-error" role="alert">{localizedErrorText(parentDocument.error,t)} <button type="button" className="text-button" onClick={()=>void parentDocument.refetch()}>{t("retry")}</button></p>}
    {parentDocument.data && <MarkdownText>{parentDocument.data.markdown}</MarkdownText>}
  </>;
  const detailView=<>
    <BackButton label={t("agentPlanBackRecords")} onClick={()=>setSelected(undefined)} />
    {detail.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {detail.isError && <p className="inline-error" role="alert">{localizedErrorText(detail.error,t)} <button type="button" className="text-button" onClick={()=>void detail.refetch()}>{t("retry")}</button></p>}
    {record && <>
      <p>{record.keys.join("、")} · {record.version ? `v${record.version}` : record.revision.slice(0,8)} · {t(record.kind==="rework" ? "agentPlanRework" : record.current ? "agentPlanCurrent" : "agentPlanHistorical")}</p>
      {record.approval && <p>{t("agentPlanApprovalTime")}：{time(record.approval.approvedAt)} · {record.approval.source}</p>}
      <p>{t(record.effective ? "agentPlanEffective" : record.approval ? "agentPlanNotEffective" : "agentPlanNoBasis")}</p>
      {record.parentDocumentId && <><p>{t(record.parentApproved?"agentPlanParentValid":"agentPlanParentInvalid")}</p><button type="button" className="text-button" onClick={()=>enter(()=>setParent(record.parentDocumentId))}>{t("agentPlanParent")}</button></>}
      {record.sha256 && <p className="account-note">SHA-256：{record.sha256}</p>}
      <MarkdownText>{record.markdown ?? [record.plan,record.validation].filter(Boolean).join("\n\n")}</MarkdownText>
    </>}
  </>;
  const listView=<>
    {pages.isPending && <p role="status">{t("agentSessionLoading")}</p>}
    {pages.isError && <p className="inline-error" role="alert">{localizedErrorText(pages.error,t)} <button type="button" className="text-button" onClick={()=>void pages.refetch()}>{t("retry")}</button></p>}
    {pages.data?.pages.some(page=>page.historyIncomplete) && <p className="account-note">{t("agentPlanHistoryGap")}</p>}
    {pages.data?.pages[0]?.records.length===0 && <p>{t("agentPlanNoRecords")}</p>}
    {pages.data?.pages.flatMap(page=>page.records).map(item=><section key={item.id} className="agent-plan-version">
      <h3>{item.version ? `v${item.version}` : item.revision.slice(0,8)} · {item.keys.join("、")} · {t(item.kind==="rework" ? "agentPlanRework" : item.current ? "agentPlanCurrent" : "agentPlanHistorical")}</h3>
      {item.rounds && <p>{item.rounds.map(round=>t("planDocumentRound",{key:round.key,round:round.number})).join("、")}</p>}
      <p>{t("agentPlanSubmitted")}：{time(item.submittedAt)}</p>
      {item.approval && <p>{t("agentPlanApprovalTime")}：{time(item.approval.approvedAt)} · {item.approval.source}</p>}
      <p>{t(item.effective?"agentPlanEffective":item.kind==="rework"?(item.parentApproved?"agentPlanParentValid":"agentPlanParentInvalid"):item.approval?"agentPlanNotEffective":item.current?"agentPlanReview":"agentPlanHistorical")}</p>
      <button type="button" className="text-button" onClick={()=>enter(()=>setSelected(item.id))}>{t("agentPlanReadVersion")}</button>
    </section>)}
    {pages.hasNextPage && <button type="button" className="secondary-button" disabled={pages.isFetchingNextPage} onClick={()=>void pages.fetchNextPage()}>{t("agentPlanMore")}</button>}
  </>;
  return <div ref={root} className="agent-plan-details">
    <div className="agent-plan-screen" data-screen="list" hidden={screen!=="list"}>{listView}</div>
    <div className="agent-plan-screen" data-screen="detail" hidden={screen!=="detail"}>{detailView}</div>
    <div className="agent-plan-screen" data-screen="parent" hidden={screen!=="parent"}>{parentView}</div>
  </div>;

}
