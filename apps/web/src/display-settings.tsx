import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";

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

/**
 * One size setting, wired to its own account field and its own root attribute.
 *
 * The console-wide size (AND-247) and the Agent console chat body's size
 * (AND-254) are separate values with the same three steps and the same
 * interaction, so both are drawn through this. The choice lands on screen and in
 * the local cache before the request goes out, so the size changes under the
 * pointer rather than after a round trip; a failed save puts the last
 * server-confirmed value back and says so. Storing it on the account is the
 * point: the same reader gets the same size on their next device.
 */
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
    choose: (scale: FontScale) => {
      if (scale === selected) return;
      applyLocally(scale);
      mutation.mutate(scale);
    },
    pending: mutation.isPending,
    error: mutation.isError
      ? (mutation.error instanceof Error && mutation.error.message ? mutation.error.message : null)
      : undefined,
    saved: mutation.isSuccess,
  };
}

type FontScaleField = ReturnType<typeof useFontScaleField>;

/** One heading, the three steps, and the preview that shows what they did. */
function FontScaleGroup({
  headingKey,
  helpKey,
  previewKey,
  savedKey,
  field,
  previewClass,
}: {
  headingKey: MessageKey;
  helpKey: MessageKey;
  previewKey: MessageKey;
  savedKey: MessageKey;
  field: FontScaleField;
  previewClass?: string;
}) {
  const { t } = useI18n();
  const heading = t(headingKey);

  return (
    <div className="font-scale-group">
      <h3>{heading}</h3>
      <p className="account-note">{t(helpKey)}</p>
      <div className="font-scale-options" role="radiogroup" aria-label={heading}>
        {FONT_SCALES.map((scale) => (
          <button
            key={scale}
            type="button"
            role="radio"
            aria-checked={field.selected === scale}
            className={field.selected === scale ? "font-scale-option selected" : "font-scale-option"}
            disabled={field.pending}
            onClick={() => field.choose(scale)}
          >
            {field.selected === scale && <Check size={14} />}
            {t(FONT_SCALE_LABELS[scale])}
          </button>
        ))}
        {field.pending && <LoaderCircle className="spin" size={15} />}
      </div>
      <p className={previewClass ? `font-scale-preview ${previewClass}` : "font-scale-preview"}>{t(previewKey)}</p>
      <p className="account-note">{t("fontSizeHelp")}</p>
      {field.error !== undefined && (
        <p className="account-note danger">{field.error ?? t("somethingWentWrong")}</p>
      )}
      {field.saved && <p className="account-note">{t(savedKey)}</p>}
    </div>
  );
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
        savedKey="fontSizeSaved"
        field={globalField}
      />
      <FontScaleGroup
        headingKey="consoleFontSize"
        helpKey="consoleFontSizeHelp"
        previewKey="consoleFontSizePreview"
        savedKey="consoleFontSizeSaved"
        field={consoleField}
        previewClass="console-chat"
      />
    </section>
  );
}
