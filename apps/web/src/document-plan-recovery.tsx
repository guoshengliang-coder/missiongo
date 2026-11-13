import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useI18n } from "./i18n";
import { localizedErrorText } from "./error-text";
import type { AgentSession, DocumentPlanApprovalState } from "./types";

/** Shared by both conversation surfaces. Recovery verifies an old decision, never asks for a new one. */
export function DocumentPlanRecovery({session,blocked=false}:{session:AgentSession;blocked?:boolean}) {
  const {t}=useI18n(),client=useQueryClient();
  const lock=useRef(false),requestKey=useRef<string | undefined>(undefined);
  const [result,setResult]=useState<DocumentPlanApprovalState>();
  const plan=session.implementationPlan,state=session.documentPlanApproval;
  const mutation=useMutation({
    mutationFn:()=>api.recoverAgentSessionPlan(session.id,plan!.documentId!,plan!.revision,requestKey.current!),
    onSettled:()=>{lock.current=false;},
    onSuccess:response=>{setResult(response);void client.invalidateQueries({queryKey:["agent-session",session.id]});},
  });
  if(!state || !plan?.documentId || plan.approved || state.code==="no_document" || session.archivedAt) return null;
  if(session.planApprovalStatus?.code==="ready" && state.code!=="ready_to_restore") return null;
  const code=result?.code??state.code;
  const reason=code==="scope_changed" ? "documentApprovalScopeChanged"
    : code==="identity_unavailable" ? "documentApprovalIdentityUnavailable"
    : code==="source_conflict" ? "documentApprovalSourceConflict"
    : code==="history_incomplete" ? "documentApprovalHistoryIncomplete"
    : code==="restored" || code==="already_approved" ? "documentApprovalRestored"
    : code==="ready_to_restore" ? "documentApprovalReady" : "documentApprovalEvidenceMissing";
  return <section className="agent-plan-record" aria-label={t("documentApprovalRecovery")}>
    <p className="agent-session-muted" role="status">{t(reason)}</p>
    <button className="secondary-button" type="button"
      disabled={blocked || mutation.isPending || !session.canRecoverPlanApproval || ["scope_changed","identity_unavailable"].includes(code)}
      onClick={()=>{if(lock.current)return;lock.current=true;requestKey.current??=crypto.randomUUID();mutation.mutate();}}>
      {t(mutation.isPending?"documentApprovalChecking":"documentApprovalRecovery")}
    </button>
    {mutation.isError && <p role="alert">{localizedErrorText(mutation.error,t)}</p>}
  </section>;
}
