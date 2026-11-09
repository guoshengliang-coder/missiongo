import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, CircleCheck, X } from "lucide-react";
import { Modal } from "./modal";
import { useI18n, type MessageKey } from "./i18n";
import { checkReleaseStatus, releaseStatusSnapshot, releaseProbeSnapshot, startReleaseStatusWatch, subscribeReleaseStatus } from "./release-status";

const reasonKeys: Record<string, MessageKey> = {
  restart_check_failed: "releaseRestartFailed", health_timeout: "releaseHealthTimeout",
  health_unavailable: "releaseHealthUnavailable", health_mismatch: "releaseHealthMismatch",
  health_invalid: "releaseHealthInvalid", unknown: "releaseReasonUnknown",
};
export function ReleaseNotice() {
  const { t } = useI18n();
  const client = useQueryClient();
  const status = useSyncExternalStore(subscribeReleaseStatus, releaseStatusSnapshot, () => null);
  const probe = useSyncExternalStore(subscribeReleaseStatus, releaseProbeSnapshot, releaseProbeSnapshot);
  const wasUpgrading = useRef(false);
  const lastRelease = useRef<string | undefined>(undefined);
  const [dismissed, setDismissed] = useState<string>();
  const [recovered, setRecovered] = useState(false);
  useEffect(startReleaseStatusWatch, []);
  useEffect(() => {
    if (status?.phase === "upgrading" || status?.phase === "failed") {
      wasUpgrading.current = true; lastRelease.current = status.release; setRecovered(false);
    } else if (wasUpgrading.current && status?.phase === "idle") {
      wasUpgrading.current = false; setRecovered(true);
      // Never replay mutations or reload the document: drafts stay in memory.
      void client.invalidateQueries();
    }
  }, [client, status]);
  if (status?.phase === "upgrading") return <Modal title={t("releaseUpdating")} subtitle={t("releaseTitle")} pending pendingNotice={null} onClose={() => undefined}>
    <p role="status"><LoaderCircle className="spin" size={20} /> {t("releaseWait")}</p>
    <p>{t("releaseDrafts")}</p>
  </Modal>;
  const failure = status?.phase === "failed";
  const unconfirmed = wasUpgrading.current && !status;
  const identity = `${status?.release ?? lastRelease.current ?? "expired"}:${failure ? "failed" : "expired"}`;
  if ((failure || unconfirmed) && dismissed !== identity) return <Modal
    title={t(failure ? "releaseFailed" : probe.state === "failed" ? "releaseStatusUnavailable" : "releaseUnconfirmed")}
    subtitle={t("releaseTitle")} onClose={() => setDismissed(identity)}>
    <p>{t(failure ? reasonKeys[status.failure?.reason ?? "unknown"] ?? "releaseReasonUnknown" : "releaseExpired")}</p>
    {status?.failure && <p>{t("releaseFailureTime", { time: new Date(status.failure.occurredAt).toLocaleString() })} · {t(status.failure.stage === "health" ? "releaseHealthStage" : "releaseRestartStage")}</p>}
    <p>{t("releaseImpact")}</p>
    <p>{t("releaseDrafts")}</p>
    <p role="status">{t(probe.state === "checking" ? "releaseChecking" : probe.state === "failed"
      ? probe.error === "timeout" ? "releaseCheckTimeout" : "releaseCheckFailed" : "releaseStillUnconfirmed")}</p>
    <button type="button" className="secondary-button" disabled={probe.state === "checking"} onClick={() => void checkReleaseStatus()}>{t("releaseCheckAgain")}</button>
  </Modal>;
  return recovered ? <div className="toast" role="status"><CircleCheck size={16} /><span>{t("releaseRecovered")}</span><button type="button" aria-label={t("dismiss")} onClick={() => setRecovered(false)}><X size={14} /></button></div> : null;
}
