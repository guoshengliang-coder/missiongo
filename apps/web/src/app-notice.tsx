import { Check, CircleAlert, X } from "lucide-react";
import { useI18n } from "./i18n";

export type NoticeHandler = (message: string, tone?: "error") => void;
export type Notice = string | { text: string; tone: "success" | "error" };

/** A failed write must never look like the confirmation of a successful one. */
export function AppNotice({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const { t } = useI18n();
  const failed = typeof notice !== "string" && notice.tone === "error";
  const Icon = failed ? CircleAlert : Check;
  return <div className={`toast${failed ? " toast-error" : ""}`} role={failed ? "alert" : "status"}>
    <Icon size={16} aria-hidden="true" />
    <span tabIndex={failed ? 0 : undefined}>{typeof notice === "string" ? notice : notice.text}</span>
    <button onClick={onDismiss} aria-label={t("dismiss")}><X size={14} /></button>
  </div>;
}
