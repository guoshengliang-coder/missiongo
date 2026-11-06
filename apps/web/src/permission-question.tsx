import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { answeredOptionSelected } from "./agent-session-view";
import { permissionPresentation } from "./permission-presentation";
import type { AgentSession, AgentSessionQuestion } from "./types";

/** An approval is an action, never an edit to the conversation's unsent draft. */
export function PermissionQuestion({ question, requestKey, sessionId, canReply, historical }: {
  question: AgentSessionQuestion; requestKey: string; sessionId: string; canReply: boolean; historical: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const locked = useRef(false);
  const [choice, setChoice] = useState<string>();
  const send = useMutation({
    mutationFn: (option: string) => api.sendAgentSessionCommand(sessionId, `${requestKey}: ${option}`),
    onSuccess: command => {
      client.setQueryData<AgentSession>(["agent-session", sessionId], current => current ? { ...current, command } : current);
    },
    onError: () => { locked.current = false; },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["agent-session", sessionId] });
      void client.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });
  const settled = question.answered !== undefined || historical;
  const queued = send.isSuccess && !settled;
  const presentation = permissionPresentation(question);
  return <section className={`agent-session-question agent-console-attention-banner${settled ? " answered" : ""}`} aria-label={t("agentSessionWaitingApprovalStatus")}>
    <div>
      <strong>{historical && question.answered === undefined ? t("agentSessionOpenReadOnly") : settled ? t("agentSessionQuestionAnswered") : t("agentSessionWaitingApprovalStatus")}</strong>
      <details><summary>{question.title}</summary>
        {question.detail && <p className="agent-session-question-detail">{question.detail}</p>}
      </details>
      <div className="agent-session-options">
        {question.options?.map(option => <button key={option} type="button"
          className={(settled ? answeredOptionSelected(question, option) : choice === option) ? "selected" : ""}
          aria-pressed={settled ? answeredOptionSelected(question, option) : choice === option}
          disabled={!canReply || settled || send.isPending || queued}
          onClick={() => {
            if (locked.current || settled || !canReply) return;
            locked.current = true;
            setChoice(option);
            send.mutate(option);
          }}>{(() => { const readable = presentation?.get(option); return readable
            ? <span>{readable.label}</span> : option; })()}
            {presentation?.get(option)?.detail && <small>{presentation.get(option)!.detail}</small>}</button>)}
      </div>
      {send.isPending && <p role="status"><LoaderCircle className="spin" size={14} /> {t("permissionSubmitting")}</p>}
      {queued && <p role="status">{t("permissionQueued")}</p>}
      {!settled && send.isError && <p className="inline-error" role="alert">{localizedErrorText(send.error, t)}</p>}
    </div>
  </section>;
}
