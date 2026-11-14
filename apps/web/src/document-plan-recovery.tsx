import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import { useDialogDraft } from "./dialog-state";
import type { AgentSession, DocumentPlanApprovalState } from "./types";

/** Shared by both conversation surfaces. Recovery verifies an old decision, never asks for a new one. */
export function DocumentPlanRecovery({session,blocked=false,diagnosticOnly=false}:{session:AgentSession;blocked?:boolean;diagnosticOnly?:boolean}) {
  const {t}=useI18n(),client=useQueryClient();
  const lock=useRef(false),requestKey=useRef<string | undefined>(undefined);
  const [result,setResult]=useState<DocumentPlanApprovalState>();
  const feedback=useRef<HTMLElement>(null);
  const plan=session.implementationPlan,state=session.documentPlanApproval;
  const mutation=useMutation({
    mutationFn:()=>api.recoverAgentSessionPlan(session.id,plan!.documentId!,plan!.revision,requestKey.current!),
    onSettled:()=>{lock.current=false;},
    onSuccess:response=>{
      setResult(response);
      for(const key of ["agent-session","plan-overview","plan-records","plan-record"])
        void client.invalidateQueries({queryKey:[key,session.id]});
    },
  });
  useDialogDraft(false,mutation.isPending);
  useLayoutEffect(()=>{if(result)feedback.current?.focus({preventScroll:true});},[result]);
  const resultRestored=result?.code==="restored" || result?.code==="already_approved";
  if(!state || !plan?.documentId || plan.approved&&!resultRestored || state.code==="no_document") return null;
  const code=result?.code??state.code;
  const restored=code==="restored" || code==="already_approved";
  const matches=state.documentId===plan.documentId && state.revision===plan.revision;
  const canRestore=matches && code==="ready_to_restore" && !plan.approved && !session.archivedAt && session.canRecoverPlanApproval;
  if(!diagnosticOnly && !canRestore && !result) return null;
  const reason=code==="scope_changed" ? "documentApprovalScopeChanged"
    : code==="identity_unavailable" ? "documentApprovalIdentityUnavailable"
    : code==="source_conflict" ? "documentApprovalSourceConflict"
    : code==="history_incomplete" ? "documentApprovalHistoryIncomplete"
    : code==="restored" || code==="already_approved" ? "documentApprovalRestored"
    : code==="ready_to_restore" ? "documentApprovalReady" : "documentApprovalEvidenceMissing";
  return <section ref={feedback} tabIndex={-1} className="agent-plan-record" aria-label={t("documentApprovalRecovery")}>
    <p className="agent-session-muted" role="status">{mutation.isPending?t("documentApprovalChecking"):result&&!restored?<>{t("documentApprovalNotRestored")} {t(reason)}</>:t(reason)}</p>
    {!diagnosticOnly && canRestore && <button className="secondary-button" type="button"
      disabled={blocked || mutation.isPending}
      onClick={()=>{if(lock.current)return;lock.current=true;requestKey.current??=crypto.randomUUID();mutation.mutate();}}>
      {t(mutation.isPending?"documentApprovalChecking":"documentApprovalRecovery")}
    </button>}
    {mutation.isError && <p role="alert">{t("documentApprovalRequestFailed")} {localizedErrorText(mutation.error,t)}</p>}
  </section>;
}
