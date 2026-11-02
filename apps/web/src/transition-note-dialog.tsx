import { Select } from "./select";
import { TransitionFiles, useTransitionFiles } from "./transition-files";
import type { TransitionAttachmentAttempt } from "./transition-attachments";
import type { WorkItem } from "./types";
import { useDialogDraft } from "./dialog-state";
import { useId, useState } from "react";
import { CirclePause, CircleX, LoaderCircle, Undo2 } from "lucide-react";

import { TRANSITION_NOTE_MAX_LENGTH } from "@missiongo/domain";

import { useI18n, type MessageKey } from "./i18n";
import type { TransitionAction, WorkItemStatus } from "./types";

/**
 * The words the note is asked with. Two edges owe a note -- back to Ready and
 * out to Cancelled (AND-64) -- and "why is this going back?" is the wrong
 * question for an item that is not going back anywhere.
 */
export function transitionNoteCopy(to: WorkItemStatus, reason?:TransitionAction["reason"]): {
  readonly title: MessageKey;
  readonly placeholder: MessageKey;
  readonly help: MessageKey;
} {
  if (to === "on_hold" || reason === "resume" || reason === "restored" || reason === "manual_override" || reason === "reopened") return {title:"decisionNoteTitle",placeholder:"decisionNotePlaceholder",help:"decisionNoteHelp"};
  return to === "cancelled"
    ? { title: "cancelNoteTitle", placeholder: "cancelNotePlaceholder", help: "cancelNoteHelp" }
    : { title: "transitionNoteTitle", placeholder: "transitionNotePlaceholder", help: "transitionNoteHelp" };
}

/**
 * Why an item is being sent back to Ready, or cancelled.
 *
 * The form stages a reason and files; the caller owns the mutation, because the list
 * and the detail pane invalidate different queries afterwards and moving that
 * in here would make a third copy of it. The server refuses a blank note too --
 * this dialog exists so the person is asked before the request is spent, not so
 * the rule lives in the browser.
 */
export function TransitionNoteDialog({
  item,
  action,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  readonly item: WorkItem;
  readonly action: TransitionAction;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (note: string, files: readonly File[], attempt: TransitionAttachmentAttempt) => void;
  readonly onCancel: () => void;
}) {
  const { t, transitionLabel } = useI18n();
  const [note, setNote] = useState("");
  const helpId = useId();
  const draft = useTransitionFiles([item], pending);

  const copy = transitionNoteCopy(action.to,action.reason);
  const cancelling = action.to === "cancelled";
  const executionDecision = cancelling || action.to === "on_hold";
  const [disposition,setDisposition] = useState<"keep_running"|"stop_requested">("keep_running");
  useDialogDraft(Boolean(note) || draft.files.length > 0 || disposition !== "keep_running", pending);
  const quickReasons = ["cancelReasonSentByMistake", "cancelReasonDuplicate", "cancelReasonNoLongerNeeded"] as const;

  return (
    <form
      className="transition-note-form"
      {...draft.dropHandlers}
      onPaste={draft.onPaste}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && note.trim()) { draft.attempt.executionDisposition = executionDecision ? disposition : undefined; onSubmit(note, draft.files, draft.attempt); }
      }}
    >
      <div className="transition-note-field">
        <label htmlFor={`${helpId}-input`}>{t(cancelling ? "cancelNoteLabel" : copy.title === "decisionNoteTitle" ? "decisionNoteLabel" : "transitionNoteLabel")}</label>
        <p id={helpId} className="dispatch-note">{t(copy.help)}</p>
        <textarea
          id={`${helpId}-input`}
          aria-describedby={helpId}
          data-initial-focus
          rows={4}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t(copy.placeholder)}
          maxLength={TRANSITION_NOTE_MAX_LENGTH}
          required
          disabled={pending}
        />
      </div>
      {cancelling && (
        <div className="transition-note-suggestions">
          <span>{t("cancelQuickReasons")}</span>
          <div className="transition-note-quick-reasons" role="group" aria-label={t("cancelQuickReasons")}>
            {quickReasons.map((reason) => (
              <button key={reason} type="button" className="secondary-button" disabled={pending} onClick={() => setNote(t(reason))}>
                {t(reason)}
              </button>
            ))}
          </div>
        </div>
      )}

      {executionDecision && <div className="transition-note-field">
        <label htmlFor={`${helpId}-execution`}>{t("executionDisposition")}</label>
        <p className="dispatch-note">{t("executionDispositionHelp")}</p>
        <Select id={`${helpId}-execution`} value={disposition} disabled={pending} onChange={event=>setDisposition(event.target.value as "keep_running"|"stop_requested")}>
          <option value="keep_running">{t("executionKeepRunning")}</option><option value="stop_requested">{t("executionStopRequested")}</option>
        </Select>
      </div>}
      <TransitionFiles draft={draft} disabled={pending} />

      {/* A dialog sits in the top layer and covers the page's toast, so the
          failure has to be repeated in here to be seen at all. */}
      {error && (
        <div className="inline-error"><CirclePause size={16} /><span>{error}</span></div>
      )}

      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primary-button" disabled={!note.trim() || pending}>
          {pending ? <LoaderCircle className="spin" size={16} /> : cancelling ? <CircleX size={16} /> : <Undo2 size={16} />}
          {transitionLabel(action.label)}
        </button>
      </div>
    </form>
  );
}
