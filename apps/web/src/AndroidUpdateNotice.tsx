import { useEffect, useId, useRef, useState } from "react";
import { Download, Smartphone, X } from "lucide-react";

import { androidAppVersion, androidDownloadAndInstall, type AndroidAppVersion } from "./android-bridge";
import { checkAndroidUpdate, publishedAt, type AndroidUpdateManifest } from "./android-update";
import { useI18n } from "./i18n";

/**
 * Tells the person when a newer Android build has been published (AND-258).
 *
 * Mounted beside the console's own update banner, but inert unless the page is
 * running inside the MissionGo Android shell: only that shell reports a version
 * over the bridge. The check runs once, on mount -- the shell reloads the page
 * on a cold start and keeps it otherwise, so mount is exactly "every time the
 * app is opened from scratch", which is the timing the item asked for.
 *
 * The dialog itself lives here, not in the APK, so its wording and the notes it
 * shows can change with a deploy. Handing the download over is the shell's job:
 * see androidDownloadAndInstall.
 */
export function AndroidUpdateNotice() {
  const { t, locale } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [installed, setInstalled] = useState<AndroidAppVersion | null>(null);
  const [update, setUpdate] = useState<AndroidUpdateManifest | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const shell = androidAppVersion();
    if (!shell) return;
    let cancelled = false;
    void checkAndroidUpdate({ currentVersionCode: shell.versionCode }).then((found) => {
      if (cancelled || !found) return;
      setInstalled(shell);
      setUpdate(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (update) dialogRef.current?.showModal();
  }, [update]);

  if (!update || !installed) return null;

  const close = () => {
    setUpdate(null);
    setHandedOff(false);
    setError(null);
  };

  const built = publishedAt(update.buildTimestamp);

  const install = () => {
    setError(null);
    // The shell re-checks the path against its own origin and the digest after
    // it downloads; the page only names where the file sits on this deployment.
    if (androidDownloadAndInstall(update.downloadPath, update.sha256, update.version)) {
      setHandedOff(true);
    } else {
      setError(t("androidUpdateUnsupported"));
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-layer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <section className="modal">
        <header>
          <div>
            <p className="eyebrow">{t("androidUpdateEyebrow")}</p>
            <h2 id={titleId}>{t("androidUpdateTitle", { version: update.version })}</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label={t("close")}><X size={20} /></button>
        </header>

        <p className="android-update-current">
          {t("androidUpdateInstalled", { version: installed.versionName })}
          {built && ` · ${t("androidUpdateBuilt", { time: built.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) })}`}
        </p>

        {update.releaseNotes.length > 0
          ? (
            <ul className="android-update-notes">
              {update.releaseNotes.flatMap((note) => note.items.map((item) => (
                <li key={`${note.pullRequestNumber}-${item.key}`}>
                  <span className="android-update-key">{item.key}</span>
                  <span>{item.title}</span>
                </li>
              )))}
            </ul>
          )
          : <p className="android-update-current">{t("androidUpdateNoNotes")}</p>}

        {handedOff && <p className="android-update-current" role="status">{t("androidUpdateHandedOff")}</p>}
        {error && <div className="inline-error"><Smartphone size={16} /><span>{error}</span></div>}

        <div className="form-footer">
          <button type="button" className="secondary-button" onClick={close}>{t("androidUpdateLater")}</button>
          <button type="button" className="primary-button" onClick={install}>
            <Download size={15} /> {handedOff ? t("androidUpdateRetry") : t("androidUpdateInstall")}
          </button>
        </div>
      </section>
    </dialog>
  );
}
