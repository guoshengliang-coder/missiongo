import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type ItemDelivery } from "./api";
import type { WorkItem } from "./types";
import { DispatchDialog } from "./dispatch-dialog";
import { ExecutionStopNotice, blocksExecution } from "./execution-stop-notice";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { Modal } from "./modal";
import { Select } from "./select";

export function AgentHandoffDialog({item,delivery,onRefresh,onClose}: {
  item:WorkItem;delivery:ItemDelivery;onRefresh:()=>Promise<unknown>;onClose:()=>void;
}) {
  const {t}=useI18n();
  const [target,setTarget]=useState("dispatch"),[note,setNote]=useState("");
  const [idempotencyKey]=useState(()=>crypto.randomUUID());
  const [dispatchRevision,setDispatchRevision]=useState<number|null>(null);
  const [saved,setSaved]=useState(false);
  const products=useQuery({queryKey:["products"],queryFn:()=>api.listProducts()});
  const save=useMutation({mutationFn:()=>api.createAgentHandoff(item.key,{expectedRevision:item.revision!,note,idempotencyKey,target:{kind:"session",sessionId:target}}),
    onSuccess:async()=>{setSaved(true);await onRefresh();}});
  const blockers=delivery.executionBlockers ?? [];
  return <Modal title={t("agentHandoffTitle")} subtitle={item.key} onClose={onClose} dirty={!saved && Boolean(note)} pending={save.isPending}>
    {saved ? <><p role="status">{t("agentHandoffSaved")}</p><div className="form-footer"><button type="button" className="primary-button" onClick={onClose}>{t("close")}</button></div></>
      : dispatchRevision!==null ? <DispatchDialog items={[item]} products={products.data ?? []} handoff={{itemKey:item.key,expectedRevision:dispatchRevision,note,idempotencyKey}}
        onClose={()=>setDispatchRevision(null)} onDispatched={()=>{setSaved(true);void onRefresh();}} />
      : <>
        <p>{t("agentHandoffHelp")}</p>
        <ExecutionStopNotice itemKey={item.key} blockers={blockers} onRefresh={onRefresh} />
        <form className="delivery-form" onSubmit={event=>{event.preventDefault();if(blockers.some(blocksExecution) || !note.trim() || !delivery.canHandoffToAgent || item.revision===undefined) return;
          if(target==="dispatch") setDispatchRevision(item.revision);else save.mutate();}}>
          <fieldset className="execution-stop-fields" disabled={save.isPending}>
            <label>{t("agentHandoffNote")}<textarea data-initial-focus required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)} /></label>
            <label>{t("agentHandoffTarget")}<Select value={target} onChange={event=>setTarget(event.target.value)}>
              <option value="dispatch">{t("agentHandoffNewDispatch")}</option>
              {(delivery.agentHandoffTargets ?? []).map(row=><option key={row.sessionId} value={row.sessionId}>{row.name} · {row.sessionId.slice(0,8)}</option>)}
            </Select></label>
            <p>{t("agentHandoffExistingHelp")}</p>
          </fieldset>
          {save.isError && <p role="alert">{localizedErrorText(save.error,t)}</p>}
          <div className="form-footer"><button type="button" className="secondary-button" disabled={save.isPending} onClick={onClose}>{t("cancel")}</button>
            <button type="submit" className="primary-button" disabled={save.isPending || blockers.some(blocksExecution) || !note.trim() || !delivery.canHandoffToAgent || item.revision===undefined}>{t(target==="dispatch"?"agentHandoffChooseNode":"agentHandoffConfirm")}</button></div>
        </form>
      </>}
  </Modal>;
}
