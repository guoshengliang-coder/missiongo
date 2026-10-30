import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, LoaderCircle } from "lucide-react";

import { Modal } from "./modal";
import { api, type AuthenticatedUser, type AuthSession } from "./api";
import {
  applyConsoleFontScale,
  applyFontScale,
  FONT_SCALES,
  storeConsoleFontScale,
  storeFontScale,
  type FontScale,
} from "./font-scale";
import { useI18n, type MessageKey } from "./i18n";

const FONT_SCALE_LABELS: Record<FontScale, MessageKey> = {
  small: "fontSizeSmall",
  medium: "fontSizeMedium",
  large: "fontSizeLarge",
};

function useFontScaleField({
  serverValue,
  readSession,
  save,
  apply,
  store,
}: {
  serverValue: FontScale;
  readSession: (session: AuthSession) => FontScale;
  save: (scale: FontScale) => Promise<AuthSession>;
  apply: (scale: FontScale) => void;
  store: (scale: FontScale) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<FontScale>(serverValue);

  // The account is the source of truth. Following it here is what repairs the
  // local cache after another device chose something else.
  useEffect(() => {
    setSelected(serverValue);
  }, [serverValue]);

  const applyLocally = (scale: FontScale) => {
    apply(scale);
    store(scale);
    setSelected(scale);
  };

  const mutation = useMutation({
    mutationFn: (scale: FontScale) => save(scale),
    onSuccess: async (session) => {
      applyLocally(readSession(session));
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: () => {
      // Put the last value the server confirmed back, so the screen does not
      // keep showing a size nobody stored.
      applyLocally(serverValue);
    },
  });

  return {
    selected,
    choose: async (scale: FontScale) => {
      if (scale !== selected) await mutation.mutateAsync(scale);
    },
    reset: mutation.reset,
    pending: mutation.isPending,
    error: mutation.isError
      ? (mutation.error instanceof Error && mutation.error.message ? mutation.error.message : null)
      : undefined,
    saved: mutation.isSuccess,
  };
}

type FontScaleField = ReturnType<typeof useFontScaleField>;

function FontScaleGroup({ headingKey, helpKey, previewKey, field }: {
  headingKey: MessageKey; helpKey: MessageKey; previewKey: MessageKey; field: FontScaleField;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FontScale>(field.selected);
  const heading = t(headingKey);
  return <>
    <button type="button" className="settings-value-row" aria-label={heading} onClick={() => { field.reset(); setDraft(field.selected); setEditing(true); }}>
      <strong>{heading}</strong><span>{t(FONT_SCALE_LABELS[field.selected])}<ChevronRight size={18} /></span>
    </button>
    {editing && <Modal title={heading} subtitle="" onClose={() => setEditing(false)} pending={field.pending}>
      <p className="account-note">{t(helpKey)}</p>
      <div className="font-scale-options" role="radiogroup" aria-label={heading}>
        {FONT_SCALES.map(scale => <button key={scale} type="button" role="radio" aria-checked={draft === scale}
          className={draft === scale ? "font-scale-option selected" : "font-scale-option"} disabled={field.pending} onClick={() => setDraft(scale)}>
          {draft === scale && <Check size={14} />}{t(FONT_SCALE_LABELS[scale])}
        </button>)}
      </div>
      <p className="font-scale-preview" style={{ fontSize: `${{small: 14, medium: 16, large: 18}[draft]}px` }}>{t(previewKey)}</p>
      <p className="account-note">{t("fontSizeHelp")}</p>
      {field.error !== undefined && <p role="alert" className="account-note danger">{field.error ?? t("somethingWentWrong")}</p>}
      <div className="form-footer">
        <button type="button" className="secondary-button" disabled={field.pending} onClick={() => setEditing(false)}>{t("cancel")}</button>
        <button type="button" className="primary-button" disabled={field.pending} onClick={async () => { try { await field.choose(draft); setEditing(false); } catch { /* Keep the draft available for retry. */ } }}>{field.pending ? <LoaderCircle className="spin" size={15} /> : t("confirm")}</button>
      </div>
    </Modal>}
  </>;
}

/**
 * Display settings: the console-wide type size (AND-247) and the Agent console
 * chat body's own size (AND-254). Two independent choices rather than one, so a
 * reader can keep the console dense and the transcript large, or the reverse.
 */
export function DisplaySettings({ user }: { user: AuthenticatedUser }) {
  const globalField = useFontScaleField({
    serverValue: user.fontScale,
    readSession: (session) => session.user.fontScale,
    save: api.changeFontScale,
    apply: applyFontScale,
    store: storeFontScale,
  });
  // Independent of the field above: its own account value, its own root
  // attribute, its own cached copy.
  const consoleField = useFontScaleField({
    serverValue: user.consoleFontScale,
    readSession: (session) => session.user.consoleFontScale,
    save: api.changeConsoleFontScale,
    apply: applyConsoleFontScale,
    store: storeConsoleFontScale,
  });

  return (
    <section className="display-settings">
      <FontScaleGroup
        headingKey="fontSize"
        helpKey="displaySettingsHelp"
        previewKey="fontSizePreview"
        field={globalField}
      />
      <FontScaleGroup
        headingKey="consoleFontSize"
        helpKey="consoleFontSizeHelp"
        previewKey="consoleFontSizePreview"
        field={consoleField}
      />
    </section>
  );
}
