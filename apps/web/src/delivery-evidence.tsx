import { useI18n } from "./i18n";
const object = (value:unknown):Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const strings = (value:unknown) => Array.isArray(value) ? value.filter((item):item is string=>typeof item === "string") : [];
export function DeliveryEvidence({payload}:{readonly payload:Readonly<Record<string,unknown>>}) {
  const {t}=useI18n();
  const completion=object(payload.completion),local=completion.kind === "local_change" ? object(completion.evidence) : {};
  const validation=object(payload.validation ?? local.validation);
  const checks=Array.isArray(validation.checks) ? validation.checks.map(object) : [];
  const files=Array.isArray(local.files) ? local.files.map(object) : [];
  const noRelease=Array.isArray(payload.requiredArtifacts)&&payload.requiredArtifacts.length===0&&typeof payload.noReleaseReason === "string";
  if(!noRelease && !files.length && !checks.length)return null;
  return <details className="timeline-handover-evidence">
    <summary>{t("deliveryEvidenceTitle")}</summary>
    <p>{t("deliveryEvidenceBoundary")}</p>
    {noRelease&&<p>{t("deliveryNoRelease")}: {String(payload.noReleaseReason)}</p>}
    {typeof local.target === "string"&&<p>{t("deliveryTarget")}: {local.target}</p>}
    {typeof local.summary === "string"&&<p>{local.summary}</p>}
    {files.length>0&&<ul>{files.map((file,index)=><li key={index}>
      <p>{typeof file.name === "string"?file.name:t("deliveryFile")}</p>
      <p>{t("deliveryBefore")}: <code>{typeof file.beforeSha256 === "string"?file.beforeSha256:t("deliveryAbsent")}</code></p>
      <p>{t("deliveryAfter")}: <code>{typeof file.afterSha256 === "string"?file.afterSha256:t("deliveryAbsent")}</code></p>
      {typeof file.sizeBytes === "number"&&<p>{file.sizeBytes} bytes</p>}
    </li>)}</ul>}
    {typeof local.rollback === "string"&&<p>{t("deliveryRollback")}: {local.rollback}</p>}
    {checks.length>0&&<ul>{checks.map((check,index)=><li key={index}>
      <p>{typeof check.name === "string"?check.name:""} · {check.result === "passed"?t("deliveryCheckPassed"):check.result === "failed"?t("deliveryCheckFailed"):t("deliveryCheckNotRun")}</p>
      {typeof check.method === "string"&&<p>{check.method}</p>}
      {typeof check.evidence === "string"&&<p>{check.evidence}</p>}
    </li>)}</ul>}
    {strings(validation.remainingVerification).length>0&&<><p>{t("deliveryRemaining")}</p><ul>{strings(validation.remainingVerification).map((text,index)=><li key={index}>{text}</li>)}</ul></>}
    {strings(validation.limitations).length>0&&<><p>{t("deliveryLimitations")}</p><ul>{strings(validation.limitations).map((text,index)=><li key={index}>{text}</li>)}</ul></>}
    {typeof payload.evidenceDigest === "string"&&<p>{t("deliveryDigest")}: <code>{payload.evidenceDigest}</code></p>}
  </details>;
}
