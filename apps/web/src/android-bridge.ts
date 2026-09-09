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
