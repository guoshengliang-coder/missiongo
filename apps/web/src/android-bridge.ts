/**
 * The Android shell and the feedback SDK both host this app in a WebView and
 * expose the same object to it. Everything here is absent in a browser, so every
 * caller has to handle `undefined` and the feature simply does not appear.
 */
interface AndroidBridge {
  readonly openFeedback?: () => void;
  readonly supportsMediaDeletion?: () => boolean;
  readonly deletePickedMedia?: () => void;
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
