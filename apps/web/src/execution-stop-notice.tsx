import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type ItemExecutionBlocker } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { Modal } from "./modal";

const reasonKeys = {active:"executionStopActive",commands_pending:"executionStopCommands",
  connection_unknown:"executionStopUnknown",execution_open:"executionStopOpen"} as const;

export function ExecutionStopNotice({itemKey,blockers,onRefresh}: {
  itemKey:string;blockers:readonly ItemExecutionBlocker[];onRefresh:()=>Promise<unknown>;
}) {
  const {t} = useI18n();
  // Keep the exact displayed observation during editing; polling must not silently approve newer evidence.
  const [selected,setSelected] = useState<ItemExecutionBlocker | null>(null);
  const [note,setNote] = useState("");
  const [checked,setChecked] = useState(false);
  const save = useMutation({mutationFn:()=>api.confirmExecutionStopped(itemKey,selected!.id,selected!.revision,note),
    onSuccess:async()=>{setSelected(null);setNote("");setChecked(false);await onRefresh();}});
  if (!blockers.length && !selected) return null;
  return <section className="execution-stop-notice" aria-label={t("executionStopHeading")}>
    {blockers.length > 0 && <>
      <strong>{t("executionStopHeading")}</strong>
      {blockers.map(blocker=><div className="execution-stop-observation" key={blocker.id}>
        <p>{blocker.nodeName && <strong>{blocker.nodeName} · </strong>}{t(reasonKeys[blocker.reason])}</p>
        <p>{t("executionStopSession",{id:blocker.sessionId ?? blocker.executionId})}</p>
        <p>{t("executionStopStatus",{status:blocker.status,progress:blocker.progressStatus ?? "—"})}</p>
        {blocker.lastObservedAt && <p>{t("executionStopObserved",{time:new Date(blocker.lastObservedAt).toLocaleString()})}</p>}
        {blocker.error && <details><summary>{t("executionStopDiagnostic")}</summary><p>{blocker.error}</p></details>}
        {blocker.canConfirmStopped && <button type="button" className="secondary-button" onClick={()=>{
          setNote("");setChecked(false);save.reset();setSelected(blocker);
        }}>{t("executionStopVerify")}</button>}
      </div>)}
    </>}
    {selected && <Modal title={t("executionStopVerify")} subtitle={itemKey} onClose={()=>setSelected(null)} dirty={Boolean(note || checked)} pending={save.isPending}>
      <form className="delivery-form execution-stop-form" onSubmit={event=>{event.preventDefault();if (checked && note.trim()) save.mutate();}}>
        <p>{t("executionStopHelp")}</p>
        <p>{t("executionStopSession",{id:selected.sessionId ?? selected.executionId})}</p>
        <fieldset className="execution-stop-fields" disabled={save.isPending}>
          <label>{t("executionStopNote")}<textarea data-initial-focus required maxLength={2000} value={note} onChange={event=>setNote(event.target.value)} /></label>
          <label className="execution-stop-attestation"><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)} /><span>{t("executionStopAttestation")}</span></label>
        </fieldset>
        {save.isError && <p role="alert">{localizedErrorText(save.error,t)}</p>}
        <div className="form-footer">
          <button type="button" className="secondary-button" disabled={save.isPending} onClick={()=>setSelected(null)}>{t("cancel")}</button>
          <button type="submit" className="primary-button" disabled={save.isPending || !checked || !note.trim()}>{t("executionStopConfirm")}</button>
        </div>
      </form>
    </Modal>}
  </section>;
}
