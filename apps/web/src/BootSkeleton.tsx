/**
 * What fills the screen between the entry chunk running and the page chunk
 * mounting. Before this, `Suspense` fell back to `null`, so the gap was a blank
 * white screen -- and on Android it is genuinely visible, because the native
 * loader is dismissed on `onPageFinished`, which fires while the page chunk is
 * still arriving.
 *
 * This file must not import from `App.tsx` (or `SdkFeedback.tsx`): pulling
 * anything out of them into the entry chunk would defeat the very code split
 * this fallback exists to cover. It reuses class names from styles.css and adds
 * only the `.boot-*` rules.
 */

/**
 * Whether this browser has opened the console before. `missiongo.product` is
 * written on every product selection, so its presence means the visitor got
 * past sign-in at least once and will almost certainly land on the shell again.
 *
 * A first-time visitor is heading for the sign-in page, and flashing a fake
 * workspace at them before it would be a lie about what is loading -- so they
 * get the plain app background instead.
 */
function hasSeenWorkspace(): boolean {
  try {
    return Boolean(localStorage.getItem("missiongo.product"));
  } catch {
    // Storage can throw outright in a locked-down WebView or private window.
    return false;
  }
}

export function BootSkeleton() {
  if (!hasSeenWorkspace()) return <div className="boot-blank" />;

  return (
    <div className="app-shell boot-skeleton" aria-hidden="true">
      <header className="topbar">
        <div className="boot-block boot-brand" />
        <div className="topbar-divider" />
        <div className="boot-block boot-switcher" />
        <div className="boot-block boot-search" />
        <div className="boot-block boot-action" />
      </header>
      <aside className="sidebar">
        <div className="boot-block boot-sidebar-label" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div className="boot-block boot-nav" key={row} />
        ))}
      </aside>
      <div className="boot-main">
        <div className="skeleton-list">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div className="skeleton-row" key={row}>
              <i />
              <span />
              <small />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
