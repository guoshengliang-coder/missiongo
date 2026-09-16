import { useState } from "react";
import { CirclePause, LoaderCircle, Undo2 } from "lucide-react";

import { TRANSITION_NOTE_MAX_LENGTH } from "@missiongo/domain";

import { useI18n } from "./i18n";
import type { TransitionAction } from "./types";

/**
 * Why an item is being sent back to Ready.
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
          placeholder={t("transitionNotePlaceholder")}
          maxLength={TRANSITION_NOTE_MAX_LENGTH}
          required
        />
      </label>
      <p className="dispatch-note">{t("transitionNoteHelp")}</p>

      {/* A dialog sits in the top layer and covers the page's toast, so the
          failure has to be repeated in here to be seen at all. */}
      {error && (
        <div className="inline-error"><CirclePause size={16} /><span>{error}</span></div>
      )}

      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primary-button" disabled={!note.trim() || pending}>
          {pending ? <LoaderCircle className="spin" size={16} /> : <Undo2 size={16} />}
          {transitionLabel(action.label)}
        </button>
      </div>
    </form>
  );
}
