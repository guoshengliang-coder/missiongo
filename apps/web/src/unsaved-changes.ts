import { useEffect } from "react";

/**
 * Make the browser confirm before a form with typed-but-unsent input is left.
 *
 * Only for input that is genuinely lost. The console's own capture form mirrors its draft
 * into localStorage and its files into IndexedDB, so leaving that page costs nothing and a
 * prompt there would be pure noise; the forms below keep their edits in React state alone.
 *
 * This covers a reload, a tab close, and a browser back that leaves the site. It does not
 * cover an in-app route change, which never unloads the document -- and inside the Android
 * app it does nothing at all, because a WebView drops beforeunload unless the host answers
 * WebChromeClient.onJsBeforeUnload. The SDK's own editor is guarded natively instead, in
 * MissionGoFeedbackActivity.
 */
export function useUnsavedChangesGuard(hasUnsavedInput: boolean): void {
  useEffect(() => {
    if (!hasUnsavedInput) return undefined;

    const confirmLeaving = (event: BeforeUnloadEvent) => {
      // preventDefault is the current spec; returnValue is what older Safari and Firefox
      // still read. Browsers show their own wording either way -- the string is ignored.
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", confirmLeaving);
    return () => window.removeEventListener("beforeunload", confirmLeaving);
  }, [hasUnsavedInput]);
}
