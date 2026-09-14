import { useRef, useState, type ReactNode } from "react";
import { Bot, Check, ClipboardCheck, Download, Laptop, Smartphone } from "lucide-react";

import { ANDROID_APK_DOWNLOAD_PATH, MACOS_CLIENT_DOWNLOAD_PATH, SKILL_DOWNLOAD_PATH, skillDownloadUrl } from "./downloads";
import { useI18n } from "./i18n";

/**
 * The three things a person installs to use MissionGo beyond this page. Each is
 * a plain link rather than a fetch: the browser handles the save, and nothing
 * here waits on it.
 */
export function DownloadsPanel() {
  const { t } = useI18n();

  return (
    <div className="download-cards">
      <DownloadCard icon={<Smartphone size={18} />} title={t("downloadAndroidTitle")} description={t("downloadAndroidDescription")}>
        <a className="primary-button download-link" href={ANDROID_APK_DOWNLOAD_PATH} download data-initial-focus>
          <Download size={15} /> {t("downloadAndroid")}
        </a>
      </DownloadCard>

      <DownloadCard icon={<Laptop size={18} />} title={t("downloadMacTitle")} description={t("downloadMacDescription")}>
        <a className="primary-button download-link" href={MACOS_CLIENT_DOWNLOAD_PATH} download>
          <Download size={15} /> {t("nodeDownloadMacClient")}
        </a>
        <p className="node-requirements">{t("nodeRequirements")}</p>
        {/* The client is ad-hoc signed, not notarized, so the Gatekeeper step
            is not optional reading. Same steps as the executor settings tab, except
            that the Mac turns up there rather than on this dialog. */}
        <ol className="node-install-steps">
          <li><h4>{t("nodeStepInstall")}</h4></li>
          <li>
            <h4>{t("nodeStepOpen")}</h4>
            <p>{t("nodeStepOpenHelp")}</p>
          </li>
          <li>
            <h4>{t("nodeStepSignIn")}</h4>
            <p>{t("downloadMacSignInHelp")}</p>
          </li>
        </ol>
      </DownloadCard>

      <DownloadCard icon={<Bot size={18} />} title={t("downloadSkillTitle")} description={t("downloadSkillDescription")}>
        <SkillLink />
      </DownloadCard>
    </div>
  );
}

function DownloadCard({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="download-card">
      <header>
        <span className="download-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <div className="download-card-body">{children}</div>
    </section>
  );
}

function SkillLink() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLElement>(null);
  const url = skillDownloadUrl(window.location.origin);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard outside a secure context (a LAN address over http, some
      // WebViews). Select the link instead so a long-press or ⌘C still works.
      const link = linkRef.current;
      const selection = window.getSelection();
      if (!link || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(link);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  return (
    <>
      <code className="download-skill-url" ref={linkRef}>{url}</code>
      <div className="download-actions">
        <button type="button" className="secondary-button" onClick={() => void copy()}>
          {copied ? <Check size={15} /> : <ClipboardCheck size={15} />} {copied ? t("copied") : t("copySkillLink")}
        </button>
        {/* nginx serves the Skill inline so a client can read it as text; the
            download attribute turns this same-origin link into a save. */}
        <a className="secondary-button download-link" href={SKILL_DOWNLOAD_PATH} download="SKILL.md">
          <Download size={15} /> {t("downloadSkillFile")}
        </a>
      </div>
    </>
  );
}
