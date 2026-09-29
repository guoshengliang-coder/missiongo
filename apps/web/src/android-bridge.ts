/**
 * The Android shell and the feedback SDK both host this app in a WebView and
 * expose the same object to it. Everything here is absent in a browser, so every
 * caller has to handle `undefined` and the feature simply does not appear.
 */
interface AndroidBridge {
  readonly openFeedback?: () => void;
  readonly supportsMediaDeletion?: () => boolean;
  readonly deletePickedMedia?: () => void;
  readonly setBackDepth?: (depth: number) => void;
  /** JSON `{versionName, versionCode}` of the installed shell (AND-258). */
  readonly appVersion?: () => string;
  /** Downloads the APK at [downloadPath] and opens the system installer (AND-258). */
  readonly downloadAndInstall?: (downloadPath: string, sha256: string, versionName: string) => void;
}

function bridge(): AndroidBridge | undefined {
  return (window as { MissionGoAndroid?: AndroidBridge }).MissionGoAndroid;
}

/** Present only in the Android shell, which can open the native feedback flow. */
export function androidFeedbackBridge(): { openFeedback: () => void } | undefined {
  const android = bridge();
  return typeof android?.openFeedback === "function" ? (android as { openFeedback: () => void }) : undefined;
}

/**
 * Tell the Android shell how many of its own history entries this page can
 * still unwind, so its back button knows whether to pop one or leave.
 *
 * The shell cannot work this out for itself. Measured on an API 36 emulator:
 * after two `history.pushState` calls the page reports `history.length` 3, but
 * `WebView.canGoBack()` still answers false and `WebView.goBack()` does not
 * move — only `history.back()` run inside the page does. Back is dispatched
 * synchronously, so the shell cannot ask at the time either; the page pushes
 * the number over whenever it changes. See AND-28.
 *
 * A no-op in a browser, where the object does not exist.
 */
export function reportAndroidBackDepth(depth: number): void {
  try {
    bridge()?.setBackDepth?.(depth);
  } catch {
    // An older shell without this method, or a bridge call that threw. The back
    // button is the shell's problem then, exactly as it was before.
  }
}

/**
 * Present when the host can offer to delete the gallery copies of what was just
 * uploaded. It answers false where the platform is too old or the host app did
 * not ask for the media permissions, so the option stays hidden rather than
 * failing after the fact.
 */
export function androidMediaDeletion(): { deletePickedMedia: () => void } | undefined {
  const android = bridge();
  if (typeof android?.supportsMediaDeletion !== "function" || typeof android.deletePickedMedia !== "function") {
    return undefined;
  }
  try {
    if (!android.supportsMediaDeletion()) return undefined;
  } catch {
    return undefined;
  }
  return { deletePickedMedia: () => android.deletePickedMedia?.() };
}

export type AndroidAppVersion = {
  versionName: string;
  versionCode: number;
};

/**
 * The installed shell's version, or undefined in a browser or an older shell.
 *
 * The page cannot read the APK's versionCode -- that is Gradle's manifest
 * attribute, not something the WebView exposes -- so the shell reports it. An
 * older shell without `appVersion` answers undefined, and the update check then
 * simply does not run rather than guessing a version to compare against.
 */
export function androidAppVersion(): AndroidAppVersion | undefined {
  const android = bridge();
  if (typeof android?.appVersion !== "function") return undefined;
  try {
    const parsed = JSON.parse(android.appVersion()) as { versionName?: unknown; versionCode?: unknown };
    if (typeof parsed.versionName !== "string" || typeof parsed.versionCode !== "number") return undefined;
    if (!Number.isInteger(parsed.versionCode) || parsed.versionCode <= 0) return undefined;
    return { versionName: parsed.versionName, versionCode: parsed.versionCode };
  } catch {
    return undefined;
  }
}

/**
 * Ask the shell to download the APK and open the system installer. Returns false
 * when there is no shell to ask, or when it is too old to have the method; the
 * caller then says the update has to be installed from the download page.
 *
 * The page only names where the file is on this origin -- the shell rebuilds the
 * URL from its own configured endpoint and re-checks the path, so a manifest
 * cannot send the download to another host.
 */
export function androidDownloadAndInstall(downloadPath: string, sha256: string, versionName: string): boolean {
  const android = bridge();
  if (typeof android?.downloadAndInstall !== "function") return false;
  try {
    android.downloadAndInstall(downloadPath, sha256, versionName);
    return true;
  } catch {
    return false;
  }
}
