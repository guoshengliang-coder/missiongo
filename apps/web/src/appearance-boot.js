// Resolve light/dark before the first paint, so styles.css needs only one dark
// palette instead of a media query and a duplicate of it. Loaded as a classic,
// synchronous script from <head> on purpose: the stylesheet selects on this
// attribute, so setting it from the module bundle would show the wrong theme
// until the bundle ran.
//
// ?appearance= wins over the system preference. The Android SDK opens the
// feedback editor with it, because a host app's own light/dark setting never
// reaches prefers-color-scheme.
//
// A file of its own, not an inline <script>: the deployed CSP is
// `script-src 'self'`, which blocks inline scripts, and while this lived inline
// production never showed dark mode at all (B12 in docs/ui-ue-review-2026-09.md).
// The appearance-boot-script plugin in vite.config.ts hashes it and links it.
(function () {
  var requested = new URLSearchParams(window.location.search).get("appearance");
  var explicit = requested === "light" || requested === "dark" ? requested : null;
  var query = window.matchMedia("(prefers-color-scheme: dark)");
  var apply = function () {
    document.documentElement.dataset.appearance =
      explicit || (query.matches ? "dark" : "light");
  };
  apply();
  if (!explicit) query.addEventListener("change", apply);
})();
