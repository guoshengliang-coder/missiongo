import { Paperclip } from "lucide-react";

import { useI18n } from "./i18n";

/**
 * The AND-69 overlay drawn while files are dragged over a form. Shared by the
 * item capture/edit forms and the agent console reply box; `limitReachedText`
 * lets a caller speak its own limit (an item says "attachments", a chat reply
 * says "files in one message").
 */
export function FileDropOverlay({ remaining, limitReachedText }: { remaining: number; limitReachedText?: string }) {
  const { t } = useI18n();
  return (
    <div className={`file-drop-overlay ${remaining < 1 ? "full" : ""}`} aria-hidden>
      <div className="file-drop-overlay-message">
        <Paperclip size={22} />
        <strong>{remaining > 0 ? t("dropFilesToAttach") : (limitReachedText ?? t("dropFilesLimitReached", { count: 10 }))}</strong>
        {remaining > 0 && <small>{t("dropFilesToAttachHelp")}</small>}
      </div>
    </div>
  );
}
