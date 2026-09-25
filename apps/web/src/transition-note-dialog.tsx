import { useState } from "react";
import { CirclePause, CircleX, LoaderCircle, Undo2 } from "lucide-react";

import { TRANSITION_NOTE_MAX_LENGTH } from "@missiongo/domain";

import { useI18n, type MessageKey } from "./i18n";
import type { TransitionAction, WorkItemStatus } from "./types";

/**
 * The words the note is asked with. Two edges owe a note -- back to Ready and
 * out to Cancelled (AND-64) -- and "why is this going back?" is the wrong
 * question for an item that is not going back anywhere.
 */
export function transitionNoteCopy(to: WorkItemStatus): {
  readonly title: MessageKey;
  readonly placeholder: MessageKey;
  readonly help: MessageKey;
} {
  return to === "cancelled"
    ? { title: "cancelNoteTitle", placeholder: "cancelNotePlaceholder", help: "cancelNoteHelp" }
    : { title: "transitionNoteTitle", placeholder: "transitionNotePlaceholder", help: "transitionNoteHelp" };
}

/**
 * Why an item is being sent back to Ready, or cancelled.
 *
 * The form only collects text; the caller owns the mutation, because the list
 * and the detail pane invalidate different queries afterwards and moving that
 * in here would make a third copy of it. The server refuses a blank note too --
 * this dialog exists so the person is asked before the request is spent, not so
 * the rule lives in the browser.
 */
export function TransitionNoteDialog({
  action,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  readonly action: TransitionAction;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (note: string) => void;
  readonly onCancel: () => void;
}) {
  const { t, transitionLabel } = useI18n();
  const [note, setNote] = useState("");
  const copy = transitionNoteCopy(action.to);
  const cancelling = action.to === "cancelled";
  const quickReasons = ["cancelReasonSentByMistake", "cancelReasonDuplicate", "cancelReasonNoLongerNeeded"] as const;

  return (
    <form
      className="transition-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim()) onSubmit(note);
      }}
    >
      <label>
        {t("transitionNoteLabel")}
        <textarea
          data-initial-focus
          rows={4}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t(copy.placeholder)}
          maxLength={TRANSITION_NOTE_MAX_LENGTH}
          required
        />
      </label>
      {cancelling && (
        <div className="transition-note-quick-reasons" aria-label={t("cancelQuickReasons")}>
          {quickReasons.map((reason) => (
            <button key={reason} type="button" className="secondary-button" disabled={pending} onClick={() => setNote(t(reason))}>
              {t(reason)}
            </button>
          ))}
        </div>
      )}
      <p className="dispatch-note">{t(copy.help)}</p>

      {/* A dialog sits in the top layer and covers the page's toast, so the
          failure has to be repeated in here to be seen at all. */}
      {error && (
        <div className="inline-error"><CirclePause size={16} /><span>{error}</span></div>
      )}

      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primary-button" disabled={!note.trim() || pending}>
          {pending ? <LoaderCircle className="spin" size={16} /> : cancelling ? <CircleX size={16} /> : <Undo2 size={16} />}
          {transitionLabel(action.label)}
        </button>
      </div>
    </form>
  );
}
