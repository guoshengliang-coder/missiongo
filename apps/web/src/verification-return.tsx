import { RotateCcw } from "lucide-react";

import { useI18n } from "./i18n";
import type { WorkItem } from "./types";

type VerificationReturn = NonNullable<WorkItem["verificationReturn"]>;

export function VerificationReturnBadge() {
  const { t } = useI18n();
  return <small className="verification-return-badge"><RotateCcw size={12} aria-hidden="true" /><span>{t("verificationReturnBadge")}</span></small>;
}

export function VerificationReturnSummary({ info }: { info: VerificationReturn }) {
  const { t } = useI18n();
  return <span className="item-description" title={info.note}>
    {info.note ? t("verificationReturnReason", { note: info.note }) : t("verificationReturnNoNote")}
  </span>;
}

export function VerificationReturnCallout({ info }: { info: VerificationReturn }) {
  const { locale, t } = useI18n();
  return (
    <section className="verification-return-callout" aria-label={t("verificationReturnBadge")}>
      <strong><RotateCcw size={17} aria-hidden="true" />{t("verificationReturnBadge")}</strong>
      <small>{t("verificationReturnAt", { time: new Date(info.at).toLocaleString(locale) })}</small>
      <p>{info.note ? t("verificationReturnReason", { note: info.note }) : t("verificationReturnNoNote")}</p>
      <small>{t("verificationReturnGuidance")}</small>
    </section>
  );
}
