import { RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { isChunkLoadError } from "./chunk-recovery";
import { useI18n } from "./i18n";

/**
 * Keeps one render failure from emptying the document.
 *
 * React unmounts the whole tree when nothing catches an error, and the tree is
 * the entire console, so an exception anywhere -- including a `lazy()` import
 * that rejects, which React reports as a render error -- painted a blank page
 * with no way back except a reload the person had to think of themselves. That
 * was AND-35: clicking the annotate icon showed white.
 *
 * The boundary is deliberately dumb. It does not retry and it does not clear
 * state, because the two failures it exists for are not retryable from inside
 * the page: a dead chunk name cannot be re-fetched into existence, and a
 * component that threw on this render will throw on the next one from the same
 * state. It shows what happened and offers the one action that can help.
 */
export class ErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: (error: unknown) => ReactNode },
  { readonly error: unknown; readonly caught: boolean }
> {
  override state = { error: undefined as unknown, caught: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, caught: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The only record there is. Without a boundary the browser logged this
    // itself; with one, React considers it handled and says nothing.
    console.error("[missiongo] render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.caught ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * What the boundary shows. Separate from the boundary because it needs the
 * translations, and a class component cannot use a hook.
 *
 * `onDismiss` is for a failure that only cost one screen -- the annotator, say,
 * which the console can carry on without. Omit it where there is nothing left
 * to go back to.
 */
export function LoadFailureNotice({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const { t } = useI18n();
  const stale = isChunkLoadError(error);

  return (
    <div className="load-failure" role="alert">
      <div className="load-failure-card">
        <h2>{t(stale ? "loadFailureStaleTitle" : "loadFailureTitle")}</h2>
        <p>{t(stale ? "loadFailureStaleBody" : "loadFailureBody")}</p>
        <div className="load-failure-actions">
          {onDismiss ? <button type="button" className="secondary-button" onClick={onDismiss}>{t("close")}</button> : null}
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>
            <RotateCw size={16} aria-hidden="true" />
            {t("loadFailureReload")}
          </button>
        </div>
      </div>
    </div>
  );
}
