import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { Modal } from "./modal";
import { useI18n } from "./i18n";
import { checkReleaseStatus, releaseStatusSnapshot, startReleaseStatusWatch, subscribeReleaseStatus } from "./release-status";

export function ReleaseNotice() {
  const { t } = useI18n();
  const client = useQueryClient();
  const status = useSyncExternalStore(subscribeReleaseStatus, releaseStatusSnapshot, () => null);
  const wasUpgrading = useRef(false);
  const lastRelease = useRef<string | undefined>(undefined);
  const [dismissed, setDismissed] = useState<string>();
  useEffect(startReleaseStatusWatch, []);
  useEffect(() => {
    if (status?.phase === "upgrading") { wasUpgrading.current = true; lastRelease.current = status.release; }
    else if (wasUpgrading.current && status?.phase === "idle") {
      wasUpgrading.current = false;
      // Never replay mutations or reload the document: drafts stay in memory.
      void client.invalidateQueries();
    }
  }, [client, status]);
  if (status?.phase === "upgrading") return <Modal title={t("releaseUpdating")} subtitle={t("releaseTitle")} pending pendingNotice={null} onClose={() => undefined}>
    <p role="status"><LoaderCircle className="spin" size={20} /> {t("releaseWait")}</p>
    <p>{t("releaseDrafts")}</p>
  </Modal>;
  if ((status?.phase === "failed" || wasUpgrading.current && !status) && dismissed !== (status?.release ?? lastRelease.current ?? "expired")) return <Modal
    title={t("releaseUnconfirmed")} subtitle={t("releaseTitle")} onClose={() => setDismissed(status?.release ?? lastRelease.current ?? "expired")}>
    <p role="status">{t("releaseRetryHelp")}</p>
    <button type="button" className="secondary-button" onClick={() => void checkReleaseStatus()}>{t("retry")}</button>
  </Modal>;
  return null;
}
