import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";

import { api, type AuthenticatedUser } from "./api";
import { applyFontScale, FONT_SCALES, storeFontScale, type FontScale } from "./font-scale";
import { useI18n, type MessageKey } from "./i18n";

const FONT_SCALE_LABELS: Record<FontScale, MessageKey> = {
  small: "fontSizeSmall",
  medium: "fontSizeMedium",
  large: "fontSizeLarge",
};

/**
 * The console's type size (AND-247), chosen and saved to the account.
 *
 * The choice lands on screen and in the local cache before the request goes
 * out, so the size changes under the pointer rather than after a round trip;
 * a failed save puts it back and says so. Storing it on the account is the
 * point: the same reader gets the same size on their next device.
 */
export function DisplaySettings({ user }: { user: AuthenticatedUser }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<FontScale>(user.fontScale);

  // The account is the source of truth. Following it here is what repairs the
  // local cache after another device chose something else.
  useEffect(() => {
    setSelected(user.fontScale);
  }, [user.fontScale]);

  const apply = (scale: FontScale) => {
    applyFontScale(scale);
    storeFontScale(scale);
    setSelected(scale);
  };

  const mutation = useMutation({
    mutationFn: (scale: FontScale) => api.changeFontScale(scale),
    onSuccess: async (session) => {
      apply(session.user.fontScale);
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: () => {
      // Put the last value the server confirmed back, so the screen does not
      // keep showing a size nobody stored.
      apply(user.fontScale);
    },
  });

  return (
    <section className="display-settings">
      <h3>{t("fontSize")}</h3>
      <p className="account-note">{t("displaySettingsHelp")}</p>
      <div className="font-scale-options" role="radiogroup" aria-label={t("fontSize")}>
        {FONT_SCALES.map((scale) => (
          <button
            key={scale}
            type="button"
            role="radio"
            aria-checked={selected === scale}
            className={selected === scale ? "font-scale-option selected" : "font-scale-option"}
            disabled={mutation.isPending}
            onClick={() => {
              if (scale === selected) return;
              apply(scale);
              mutation.mutate(scale);
            }}
          >
            {selected === scale && <Check size={14} />}
            {t(FONT_SCALE_LABELS[scale])}
          </button>
        ))}
        {mutation.isPending && <LoaderCircle className="spin" size={15} />}
      </div>
      <p className="font-scale-preview">{t("fontSizePreview")}</p>
      <p className="account-note">{t("fontSizeHelp")}</p>
      {mutation.isError && (
        <p className="account-note danger">
          {mutation.error instanceof Error && mutation.error.message
            ? mutation.error.message
            : t("somethingWentWrong")}
        </p>
      )}
      {mutation.isSuccess && <p className="account-note">{t("fontSizeSaved")}</p>}
    </section>
  );
}
