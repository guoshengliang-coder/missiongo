import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, ListTodo, CheckCheck, ExternalLink, X } from "lucide-react";
import type { PersonalNotificationFilter, PersonalNotificationKind } from "@missiongo/domain";
import { api } from "./api";
import { useI18n } from "./i18n";
import { OverlayDialog, useOverlay } from "./overlay";
import { Modal } from "./modal";
import { Select } from "./select";
import "./message-center.css";

export function useMessageCount(accountId: string) {
  return useQuery({queryKey:["personal-notifications",accountId,"count"],queryFn:api.personalAttentionCount,
    enabled:Boolean(accountId)});
}
export function MessageButton({accountId,onOpen}:{accountId:string;onOpen:()=>void}) {
  const {t}=useI18n(),count=useMessageCount(accountId);
  return <button type="button" className="secondary-button message-center-trigger" onClick={onOpen} aria-label={t("attention")} title={count.isError?t("messagesLoadFailed"):t("attention")}>
    <ListTodo size={18} aria-hidden="true" /><span>{t("attention")}</span>
    {!count.isError && Boolean(count.data?.count) && <small className="message-unread-badge" aria-label={t("attentionCount",{count:count.data!.count})}>{count.data!.count>99?"99+":count.data!.count}</small>}
    {count.isError && <span aria-label={t("messagesLoadFailed")}>!</span>}
  </button>;
}
const kinds:PersonalNotificationKind[]=["mention","reply","verification","decision"];
const labels={mention:"messageMention",reply:"messageReply",verification:"messageVerification",decision:"messageDecision"} as const;
const reasons={mention:"messageReasonMention",reply:"messageReasonReply",verification:"messageReasonVerification",decision:"messageReasonDecision"} as const;
export function MessageCenter({accountId,products,onClose,renderItem}:{
  accountId:string;products:readonly {id:string;name:string}[];onClose:()=>void;
  renderItem:(key:string,commentId:string|null,close:()=>void,open:(key:string)=>void)=>ReactNode;
}) {
  const {t,formatTime}=useI18n(),client=useQueryClient();
  const [compact,setCompact]=useState(()=>matchMedia("(max-width: 1023px)").matches);
  useEffect(()=>{const mq=matchMedia("(max-width: 1023px)"),change=()=>setCompact(mq.matches);mq.addEventListener("change",change);return()=>mq.removeEventListener("change",change);},[]);
  const [tab,setTab]=useState<"todos"|"notifications">("todos");
  const count=useMessageCount(accountId);
  const [unread,setUnread]=useState(false),[productId,setProductId]=useState(""),[kind,setKind]=useState<PersonalNotificationKind|"">("");
  const [selected,setSelected]=useState<string|null>(null),[business,setBusiness]=useState<{key:string;commentId:string|null}|null>(null);
  const filter:PersonalNotificationFilter={unread,...(productId?{productId}:{}),...(kind?{kind}:{})};
  const list=useInfiniteQuery({queryKey:["personal-notifications",accountId,"list",filter],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>api.personalNotifications({...filter,...(pageParam?{beforeSequence:pageParam}:{})}),
    getNextPageParam:page=>page.nextBeforeSequence,staleTime:0,refetchOnMount:"always",enabled:tab==="notifications"});
  const detail=useQuery({queryKey:["personal-notifications",accountId,"detail",selected],queryFn:()=>api.personalNotification(selected!),enabled:tab==="notifications" && Boolean(selected),staleTime:0,refetchOnMount:"always"});
  const refresh=()=>client.invalidateQueries({queryKey:["personal-notifications",accountId]});
  const read=useMutation({mutationFn:api.readPersonalNotification,onSuccess:refresh});
  const allRead=useMutation({mutationFn:(through:number)=>api.readAllPersonalNotifications(through,filter),onSuccess:refresh});
  const attempted=useRef<string|null>(null);
  useEffect(()=>{
    if(tab==="notifications" && selected && detail.isSuccess && !detail.isFetching && detail.data.id===selected && !detail.data.readAt && attempted.current!==selected){
      attempted.current=selected;read.mutate(selected);
    }
  },[tab,selected,detail.isSuccess,detail.isFetching,detail.data]);
  const todos=useInfiniteQuery({queryKey:["personal-notifications",accountId,"todos",productId],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>api.personalTodos({...(productId?{productId}:{}),...(pageParam?{beforeSequence:pageParam}:{})}),
    getNextPageParam:page=>page.nextBeforeSequence,enabled:tab==="todos",staleTime:0,refetchOnMount:"always"});
  const todoRows=todos.isError?[]:todos.data?.pages.flatMap(page=>page.todos) ?? [];
  const currentTodo=todoRows.find(row=>row.id===selected);
  const rows=list.isError?[]:list.data?.pages.flatMap(page=>page.notifications) ?? [];
  const current=detail.isError?undefined:detail.data;
  const choose=(id:string)=>{attempted.current=null;read.reset();setSelected(id);};
  return <OverlayDialog className="message-center-layer" aria-labelledby="message-center-title" onClose={onClose}>
    <section className="message-center-panel">
      <header className="message-center-header">
        {compact && <button type="button" className="icon-button message-center-back" onClick={()=>selected?setSelected(null):onClose()} aria-label={t(selected?"messagesBackList":"messagesBackHome")}><ArrowLeft size={20}/></button>}
        <div><h2 id="message-center-title">{t("attention")}</h2><p>{t("attentionHelp")}</p></div>
        {!compact && <button type="button" className="icon-button" data-initial-focus onClick={onClose} aria-label={t("close")}><X size={20}/></button>}
      </header>
      <div className="message-center-tabs" aria-label={t("attentionCategories")}>
        <button type="button" className="secondary-button" aria-pressed={tab==="todos"} onClick={()=>{setTab("todos");setSelected(null);}}><ListTodo size={17}/>{t("attentionTodos")}{count.isSuccess && <small>{count.data.todoCount}</small>}</button>
        <button type="button" className="secondary-button" aria-pressed={tab==="notifications"} onClick={()=>{setTab("notifications");setSelected(null);}}><Bell size={17}/>{t("attentionNotifications")}{count.isSuccess && <small>{count.data.unreadCount}</small>}</button>
      </div>
      <div className={`message-center-body${compact && selected?" showing-detail":""}`}>
        {tab==="todos" ? <>
          <section className="message-list-pane" aria-label={t("attentionTodos")}>
            <div className="message-list-tools"><Select aria-label={t("messagesProject")} value={productId} onChange={event=>{setProductId(event.target.value);setSelected(null);}}><option value="">{t("messagesAllProjects")}</option>{products.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}</Select></div>
            <div className="message-list-scroll">
              {todos.isPending && <p role="status">{t("messagesLoading")}</p>}
              {todos.isError && <p role="alert">{t("messagesLoadFailed")} <button type="button" className="secondary-button" onClick={()=>void todos.refetch()}>{t("retry")}</button></p>}
              {todos.isSuccess && !todoRows.length && <div className="message-empty"><ListTodo size={28}/><h3>{t("todosEmpty")}</h3><p>{t("todosEmptyHelp")}</p><button type="button" className="secondary-button" onClick={()=>void todos.refetch()}>{t("refresh")}</button></div>}
              {todoRows.map(row=><button type="button" key={row.id} className={`message-list-row${row.id===selected?" selected":""}`} onClick={()=>setSelected(row.id)} aria-current={row.id===selected?"true":undefined}>
                <span className="message-row-meta"><strong>{t("messageVerification")}</strong><span>{t("todoPending")}</span></span>
                <strong>{row.itemKey} · {row.itemTitle}</strong><span className="message-row-summary">{t("todoVerificationHelp")}</span><small>{row.productName} · {formatTime(row.createdAt)}</small>
              </button>)}
              {todos.hasNextPage && <button type="button" className="secondary-button" disabled={todos.isFetchingNextPage} onClick={()=>void todos.fetchNextPage()}>{t("loadMore")}</button>}
            </div>
          </section>
          <section className="message-detail-pane" aria-label={t("todoDetail")}>
            <MessageDetailBack active={compact && Boolean(selected)} onBack={()=>setSelected(null)}/>
            {todos.isError ? <p role="alert">{t("messagesLoadFailed")} <button type="button" className="secondary-button" onClick={()=>void todos.refetch()}>{t("retry")}</button></p> : !selected ? <div className="message-empty"><ListTodo size={28}/><h3>{t("todosChoose")}</h3><p>{t("todoVerificationHelp")}</p></div> : currentTodo ? <>
              <div className="message-detail-content"><p className="eyebrow">{currentTodo.productName} · {t("messageVerification")}</p><h3>{currentTodo.itemKey} · {currentTodo.itemTitle}</h3><p className="message-detail-meta">{formatTime(currentTodo.createdAt)}</p><p className="message-reason">{t("todoVerificationHelp")}</p><p>{t("todoReadingHelp")}</p></div>
              <div className="message-detail-actions"><button type="button" className="primary-button" onClick={()=>setBusiness({key:currentTodo.itemKey,commentId:null})}><ExternalLink size={17}/>{t("todoGoVerify")}</button></div>
            </> : <div className="message-empty"><CheckCheck size={28}/><h3>{t("todoNoLongerPending")}</h3><p>{t("todoNoLongerPendingHelp")}</p></div>}
          </section>
        </> : <>
        <section className="message-list-pane" aria-label={t("messagesList")}>
          <div className="message-list-tools">
            <div className="message-list-tabs"><button type="button" className="secondary-button" aria-pressed={!unread} onClick={()=>setUnread(false)}>{t("messagesAll")}</button><button type="button" className="secondary-button" aria-pressed={unread} onClick={()=>setUnread(true)}>{t("messagesUnread")}</button>
              <button type="button" className="icon-button" disabled={!list.data || list.isError || allRead.isPending || !rows.some(row=>!row.readAt && !row.resolvedAt)} onClick={()=>allRead.mutate(list.data!.pages[0]!.throughSequence)} aria-label={t("messagesReadAll")} title={t("messagesReadAll")}><CheckCheck size={19}/></button>
            </div>
            <div className="message-list-filters">
              <Select aria-label={t("messagesProject")} value={productId} onChange={event=>setProductId(event.target.value)}><option value="">{t("messagesAllProjects")}</option>{products.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}</Select>
              <Select aria-label={t("messagesType")} value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="">{t("messagesAllTypes")}</option>{kinds.map(value=><option key={value} value={value}>{t(labels[value])}</option>)}</Select>
            </div>
            {allRead.isError && <p role="alert">{t("messagesReadFailed")}</p>}
          </div>
          <div className="message-list-scroll">
            {list.isPending && <p role="status">{t("messagesLoading")}</p>}
            {list.isError && <p role="alert">{t("messagesLoadFailed")} <button type="button" className="secondary-button" onClick={()=>void list.refetch()}>{t("retry")}</button></p>}
            {list.isSuccess && !rows.length && <div className="message-empty"><Bell size={28}/><h3>{t("messagesEmpty")}</h3><p>{t("messagesEmptyHelp")}</p><button type="button" className="secondary-button" onClick={()=>void list.refetch()}>{t("refresh")}</button></div>}
            {rows.map(row=><button type="button" key={row.id} className={`message-list-row${row.id===selected?" selected":""}${row.readAt || row.resolvedAt?"":" unread"}`} onClick={()=>choose(row.id)} aria-current={row.id===selected?"true":undefined}>
              <span className="message-row-meta"><strong>{t(labels[row.kind])}</strong><span>{row.resolvedAt?t("notificationResolved"):row.readAt?t("messagesRead"):t("messagesUnread")}</span></span>
              <strong>{row.itemKey} · {row.itemTitle}</strong><span className="message-row-summary">{row.unavailable?t("messageWithdrawn"):row.summary || t(labels[row.kind])}</span>
              <small>{row.productName} · {row.actorName || t("messageSystem")} · {formatTime(row.createdAt)}</small>
            </button>)}
            {list.hasNextPage && <button type="button" className="secondary-button" disabled={list.isFetchingNextPage} onClick={()=>void list.fetchNextPage()}>{t("loadMore")}</button>}
          </div>
        </section>
        <section className="message-detail-pane" aria-label={t("messagesDetail")}>
          <MessageDetailBack active={compact && Boolean(selected)} onBack={()=>setSelected(null)} />
          {!selected ? <div className="message-empty"><Bell size={28}/><h3>{t("messagesChoose")}</h3><p>{t("messagesChooseHelp")}</p></div> : detail.isPending ? <p role="status">{t("messagesLoading")}</p> : detail.isError ? <p role="alert">{t("messagesUnavailable")} <button type="button" className="secondary-button" onClick={()=>void detail.refetch()}>{t("retry")}</button></p> : current && <>
            <div className="message-detail-content"><p className="eyebrow">{current.productName} · {t(labels[current.kind])}</p><h3>{current.itemKey} · {current.itemTitle}</h3>
            <p className="message-detail-meta">{current.actorName || t("messageSystem")} · {formatTime(current.createdAt)}</p>
            <p className="message-reason">{current.resolvedAt?t("notificationResolvedHelp"):t(reasons[current.kind])}</p>
            <div className="message-detail-text">{current.unavailable?t("messageWithdrawn"):current.text || t(labels[current.kind])}</div>
            </div><div className="message-detail-actions"><button type="button" className="primary-button" onClick={()=>setBusiness({key:current.itemKey,commentId:current.unavailable?null:current.commentId})}><ExternalLink size={17}/>{t(current.commentId && !current.unavailable?"messageGoComment":"messageGoItem")}</button>
              {!current.readAt && <button type="button" className="secondary-button" disabled={read.isPending} onClick={()=>read.mutate(current.id)}>{t("messagesMarkRead")}</button>}
            </div>{read.isError && <p role="alert">{t("messagesReadFailed")}</p>}
          </>}
        </section>
        </>}
      </div>
    </section>
    {business && <Modal className="message-business-modal" fullScreenOnCompact wide title={t("messageGoItem")} subtitle={t("attention")} onClose={()=>{setBusiness(null);void refresh();}}>
      {close=>renderItem(business.key,business.commentId,close,key=>setBusiness({key,commentId:null}))}
    </Modal>}
  </OverlayDialog>;
}
/** Detail is a child navigation step only on compact screens. It uses the same
 * back coordinator as dialogs, Select menus and the Android host. */
function MessageDetailBack({active,onBack}:{active:boolean;onBack:()=>void}) {
  useOverlay(active,onBack);
  useEffect(()=>{if(active)document.querySelector<HTMLButtonElement>(".message-center-back")?.focus();},[active]);
  return null;
}
