import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, ListTodo, CheckCheck, X } from "lucide-react";
import type { PersonalNotificationFilter, PersonalNotificationKind, PersonalTodo } from "@missiongo/domain";
import { api } from "./api";
import { useI18n } from "./i18n";
import { OverlayDialog, useOverlay } from "./overlay";
import { DialogDraftContext, useDialogDraftState } from "./dialog-state";
import { useBeforeUnloadGuard } from "./unsaved-changes";
import { Select } from "./select";
import "./message-center.css";

export function useMessageCount(accountId: string) {
  return useQuery({queryKey:["personal-notifications",accountId,"count"],queryFn:api.personalAttentionCount,
    enabled:Boolean(accountId),refetchInterval:5000});
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
export interface AttentionItemTarget {
  key: string;
  instanceKey: string;
  commentId: string | null;
  businessEventId: string | null;
  onReady: () => void;
  navigate: (action: () => void) => boolean;
}
export function MessageCenter({accountId,products,onClose,renderItem}:{
  accountId:string;products:readonly {id:string;name:string}[];onClose:()=>void;
  renderItem:(target:AttentionItemTarget,close:()=>void,open:(key:string)=>void)=>ReactNode;
}) {
  const {t,formatTime}=useI18n(),client=useQueryClient();
  const [compact,setCompact]=useState(()=>matchMedia("(max-width: 1023px)").matches);
  useEffect(()=>{const mq=matchMedia("(max-width: 1023px)"),change=()=>setCompact(mq.matches);mq.addEventListener("change",change);return()=>mq.removeEventListener("change",change);},[]);
  const [tab,setTab]=useState<"todos"|"notifications">("todos");
  const count=useMessageCount(accountId);
  const [unread,setUnread]=useState(false),[productId,setProductId]=useState(""),[kind,setKind]=useState<PersonalNotificationKind|"">("");
  const [selected,setSelected]=useState<string|null>(null);
  const selectionFocus=useRef<HTMLElement|null>(null);
  const [selectedTodo,setSelectedTodo]=useState<PersonalTodo|null>(null);
  const [relatedKey,setRelatedKey]=useState<string|null>(null);
  const [readySelection,setReadySelection]=useState<string|null>(null);
  const drafts=useDialogDraftState();
  const [discard,setDiscard]=useState<{action:()=>void;focus:HTMLElement|null}|null>(null);
  const [waiting,setWaiting]=useState(false);
  useBeforeUnloadGuard(drafts.dirty || drafts.pending);
  useEffect(()=>{if(discard)document.querySelector<HTMLElement>(".message-center-layer [data-continue-editing]")?.focus();},[discard]);
  const navigate=(action:()=>void):boolean=>{
    if(discard){const focus=discard.focus;setDiscard(null);requestAnimationFrame(()=>focus?.focus());return false;}
    if(drafts.pending){setWaiting(true);return false;}
    if(drafts.dirty){setDiscard({action,focus:document.activeElement as HTMLElement|null});return false;}
    action();return true;
  };
  const clearSelection=()=>{setSelected(null);setSelectedTodo(null);setRelatedKey(null);setReadySelection(null);};
  const back=()=>{
    // Returning from a related item keeps the compact detail layer mounted.
    // Reject its dismissal so the shared coordinator retains the next Back step.
    if(relatedKey){navigate(()=>setRelatedKey(null));return false;}
    return navigate(()=>{
    clearSelection();requestAnimationFrame(()=>{
      const target=selectionFocus.current?.isConnected?selectionFocus.current:document.querySelector<HTMLElement>(".message-center-layer .message-list-scroll");
      target?.focus();
    });
    });
  };
  const close=()=>navigate(onClose);
  const select=(id:string,todo:PersonalTodo|null=null)=>{
    if(id===selected && !relatedKey)return;
    const focus=document.activeElement as HTMLElement|null;
    navigate(()=>{
    selectionFocus.current=focus;attempted.current=null;read.reset();setSelected(id);setSelectedTodo(todo);setRelatedKey(null);setReadySelection(null);
    });
  };
  const selectionToken=`${tab}:${selected}`;
  const itemReady=useCallback(()=>setReadySelection(selectionToken),[selectionToken]);
  const filter:PersonalNotificationFilter={unread,...(productId?{productId}:{}),...(kind?{kind}:{})};
  const list=useInfiniteQuery({queryKey:["personal-notifications",accountId,"list",filter],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>api.personalNotifications({...filter,...(pageParam?{beforeSequence:pageParam}:{})}),
    getNextPageParam:page=>page.nextBeforeSequence,staleTime:0,refetchOnMount:"always",refetchInterval:5000,enabled:tab==="notifications"});
  const detail=useQuery({queryKey:["personal-notifications",accountId,"detail",selected],queryFn:()=>api.personalNotification(selected!),enabled:tab==="notifications" && Boolean(selected),staleTime:0,refetchOnMount:"always",refetchInterval:5000});
  const refresh=()=>client.invalidateQueries({queryKey:["personal-notifications",accountId]});
  const read=useMutation({mutationFn:api.readPersonalNotification,onSuccess:refresh});
  const allRead=useMutation({mutationFn:(through:number)=>api.readAllPersonalNotifications(through,filter),onSuccess:refresh});
  const attempted=useRef<string|null>(null);
  useEffect(()=>{
    if(tab==="notifications" && selected && readySelection===selectionToken && !relatedKey && detail.isSuccess && !detail.isFetching && detail.data.id===selected && !detail.data.readAt && attempted.current!==selected){
      attempted.current=selected;read.mutate(selected);
    }
  },[tab,selected,detail.isSuccess,detail.isFetching,detail.data,readySelection,selectionToken,relatedKey]);
  const todos=useInfiniteQuery({queryKey:["personal-notifications",accountId,"todos",productId],initialPageParam:undefined as number|undefined,
    queryFn:({pageParam})=>api.personalTodos({...(productId?{productId}:{}),...(pageParam?{beforeSequence:pageParam}:{})}),
    getNextPageParam:page=>page.nextBeforeSequence,enabled:tab==="todos",staleTime:0,refetchOnMount:"always",refetchInterval:5000});
  const todoRows=todos.data?.pages.flatMap(page=>page.todos) ?? [];
  const currentTodo=selectedTodo;
  const rows=list.data?.pages.flatMap(page=>page.notifications) ?? [];
  const current=detail.data;
  const targetKey=relatedKey ?? (tab==="todos"?currentTodo?.itemKey:current?.itemKey);
  const renderDetail=()=>targetKey && renderItem({key:targetKey,instanceKey:`${selectionToken}:${relatedKey ?? ""}`,
    commentId:relatedKey?null:current?.unavailable?null:current?.commentId ?? null,
    businessEventId:relatedKey?null:tab==="todos"?currentTodo?.businessEventId ?? null:current?.businessEventId ?? null,
    onReady:itemReady,navigate},()=>{back();},key=>{navigate(()=>setRelatedKey(key));});
  return <OverlayDialog className="message-center-layer" aria-labelledby="message-center-title" aria-busy={drafts.pending} onClose={close}>
    <DialogDraftContext.Provider value={drafts.update}>
    <section className="message-center-panel">
      <header className="message-center-header">
        {compact && <button type="button" className="icon-button message-center-back" disabled={drafts.pending} onClick={()=>selected?back():close()} aria-label={t(selected?"messagesBackList":"messagesBackHome")}><ArrowLeft size={20}/></button>}
        <div><h2 id="message-center-title">{t("attention")}</h2><p>{t("attentionHelp")}</p></div>
        {!compact && <button type="button" className="icon-button" data-initial-focus disabled={drafts.pending} onClick={close} aria-label={t("close")}><X size={20}/></button>}
      </header>
      {waiting && drafts.pending && <p className="message-reason" role="status">{t("settingsWaitForSave")}</p>}
      {discard && <div className="discard-dialog">
        <h3>{t("discardDialogTitle")}</h3><p>{t("discardDialogHelp")}</p>
        <div className="form-footer"><button type="button" className="secondary-button" data-continue-editing onClick={()=>{
          const focus=discard.focus;setDiscard(null);requestAnimationFrame(()=>focus?.focus());
        }}>{t("continueEditing")}</button><button type="button" className="danger-button" onClick={()=>{
          const action=discard.action;setDiscard(null);action();
        }}>{t("discardChanges")}</button></div>
      </div>}
      <div className="message-center-workspace" hidden={Boolean(discard)}>
      <div className="message-center-tabs" aria-label={t("attentionCategories")}>
        <button type="button" className="secondary-button" aria-pressed={tab==="todos"} onClick={()=>{if(tab!=="todos")navigate(()=>{setTab("todos");clearSelection();});}}><ListTodo size={17}/>{t("attentionTodos")}{count.isSuccess && <small>{count.data.todoCount}</small>}</button>
        <button type="button" className="secondary-button" aria-pressed={tab==="notifications"} onClick={()=>{if(tab!=="notifications")navigate(()=>{setTab("notifications");clearSelection();});}}><Bell size={17}/>{t("attentionNotifications")}{count.isSuccess && <small>{count.data.unreadCount}</small>}</button>
      </div>
      <div className={`message-center-body${compact && selected?" showing-detail":""}`}>
        {tab==="todos" ? <>
          <section className="message-list-pane" aria-label={t("attentionTodos")}>
            <div className="message-list-tools"><Select aria-label={t("messagesProject")} value={productId} onChange={event=>{const value=event.target.value;navigate(()=>{setProductId(value);clearSelection();});}}><option value="">{t("messagesAllProjects")}</option>{products.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}</Select></div>
            <div className="message-list-scroll" tabIndex={-1}>
              {todos.isPending && <p role="status">{t("messagesLoading")}</p>}
              {todos.isError && <p role="alert">{t("messagesLoadFailed")} <button type="button" className="secondary-button" onClick={()=>void todos.refetch()}>{t("retry")}</button></p>}
              {todos.isSuccess && !todoRows.length && <div className="message-empty"><ListTodo size={28}/><h3>{t("todosEmpty")}</h3><p>{t("todosEmptyHelp")}</p><button type="button" className="secondary-button" onClick={()=>void todos.refetch()}>{t("refresh")}</button></div>}
              {todoRows.map(row=><button type="button" key={row.id} className={`message-list-row${row.id===selected?" selected":""}`} onClick={()=>select(row.id,row)} aria-current={row.id===selected?"true":undefined}>
                <span className="message-row-meta"><strong>{t("messageVerification")}</strong><span>{t("todoPending")}</span></span>
                <strong>{row.itemKey} · {row.itemTitle}</strong><span className="message-row-summary">{t("todoVerificationHelp")}</span><small>{row.productName} · {formatTime(row.createdAt)}</small>
              </button>)}
              {todos.hasNextPage && <button type="button" className="secondary-button" disabled={todos.isFetchingNextPage} onClick={()=>void todos.fetchNextPage()}>{t("loadMore")}</button>}
            </div>
          </section>
          <section className="message-detail-pane" aria-label={t("todoDetail")}>
            <MessageDetailBack active={compact && Boolean(selected)} onBack={back}/>
            {!selected ? <div className="message-empty"><ListTodo size={28}/><h3>{t("todosChoose")}</h3><p>{t("todoVerificationHelp")}</p></div> : currentTodo && <>
              <p className="message-reason" role="status">{relatedKey?t("messageRelatedItem"):todos.isSuccess && !todoRows.some(row=>row.id===selected)?t("todoNoLongerPendingHelp"):t("todoVerificationHelp")}</p>
              {renderDetail()}
            </>}

          </section>
        </> : <>
        <section className="message-list-pane" aria-label={t("messagesList")}>
          <div className="message-list-tools">
            <div className="message-list-tabs"><button type="button" className="secondary-button" aria-pressed={!unread} onClick={()=>navigate(()=>{setUnread(false);clearSelection();})}>{t("messagesAll")}</button><button type="button" className="secondary-button" aria-pressed={unread} onClick={()=>navigate(()=>{setUnread(true);clearSelection();})}>{t("messagesUnread")}</button>
              <button type="button" className="icon-button" disabled={!list.data || list.isError || allRead.isPending || !rows.some(row=>!row.readAt && !row.resolvedAt)} onClick={()=>allRead.mutate(list.data!.pages[0]!.throughSequence)} aria-label={t("messagesReadAll")} title={t("messagesReadAll")}><CheckCheck size={19}/></button>
            </div>
            <div className="message-list-filters">
              <Select aria-label={t("messagesProject")} value={productId} onChange={event=>{const value=event.target.value;navigate(()=>{setProductId(value);clearSelection();});}}><option value="">{t("messagesAllProjects")}</option>{products.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}</Select>
              <Select aria-label={t("messagesType")} value={kind} onChange={event=>{const value=event.target.value as typeof kind;navigate(()=>{setKind(value);clearSelection();});}}><option value="">{t("messagesAllTypes")}</option>{kinds.map(value=><option key={value} value={value}>{t(labels[value])}</option>)}</Select>
            </div>
            {allRead.isError && <p role="alert">{t("messagesReadFailed")}</p>}
          </div>
          <div className="message-list-scroll" tabIndex={-1}>
            {list.isPending && <p role="status">{t("messagesLoading")}</p>}
            {list.isError && <p role="alert">{t("messagesLoadFailed")} <button type="button" className="secondary-button" onClick={()=>void list.refetch()}>{t("retry")}</button></p>}
            {list.isSuccess && !rows.length && <div className="message-empty"><Bell size={28}/><h3>{t("messagesEmpty")}</h3><p>{t("messagesEmptyHelp")}</p><button type="button" className="secondary-button" onClick={()=>void list.refetch()}>{t("refresh")}</button></div>}
            {rows.map(row=><button type="button" key={row.id} className={`message-list-row${row.id===selected?" selected":""}${row.readAt || row.resolvedAt?"":" unread"}`} onClick={()=>select(row.id)} aria-current={row.id===selected?"true":undefined}>
              <span className="message-row-meta"><strong>{t(labels[row.kind])}</strong><span>{row.resolvedAt?t("notificationResolved"):row.readAt?t("messagesRead"):t("messagesUnread")}</span></span>
              <strong>{row.itemKey} · {row.itemTitle}</strong><span className="message-row-summary">{row.unavailable?t("messageWithdrawn"):row.summary || t(labels[row.kind])}</span>
              <small>{row.productName} · {row.actorName || t("messageSystem")} · {formatTime(row.createdAt)}</small>
            </button>)}
            {list.hasNextPage && <button type="button" className="secondary-button" disabled={list.isFetchingNextPage} onClick={()=>void list.fetchNextPage()}>{t("loadMore")}</button>}
          </div>
        </section>
        <section className="message-detail-pane" aria-label={t("messagesDetail")}>
          <MessageDetailBack active={compact && Boolean(selected)} onBack={back} />
          {!selected ? <div className="message-empty"><Bell size={28}/><h3>{t("messagesChoose")}</h3><p>{t("messagesChooseHelp")}</p></div> : !current && detail.isPending ? <p role="status">{t("messagesLoading")}</p> : <>
            {detail.isError && <p role="alert">{t("messagesUnavailable")} <button type="button" className="secondary-button" onClick={()=>void detail.refetch()}>{t("retry")}</button></p>}
            {current && <>
              <p className="message-reason">{relatedKey?t("messageRelatedItem"):current.unavailable?t("messageWithdrawn"):t(reasons[current.kind])} · {current.actorName || t("messageSystem")} · {formatTime(current.createdAt)}</p>
              {renderDetail()}
              {read.isError && <p role="alert">{t("messagesReadFailed")} <button type="button" className="secondary-button" disabled={read.isPending} onClick={()=>read.mutate(current.id)}>{t("retry")}</button></p>}
            </>}
          </>}

        </section>
        </>}
      </div>
      </div>
    </section>
    </DialogDraftContext.Provider>
  </OverlayDialog>;
}
/** Detail is a child navigation step only on compact screens. It uses the same
 * back coordinator as dialogs, Select menus and the Android host. */
function MessageDetailBack({active,onBack}:{active:boolean;onBack:()=>boolean | void}) {
  useOverlay(active,onBack);
  useEffect(()=>{if(active)document.querySelector<HTMLButtonElement>(".message-center-back")?.focus();},[active]);
  return null;
}
