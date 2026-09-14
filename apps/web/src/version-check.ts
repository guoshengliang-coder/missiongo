/**
 * Noticing that a newer build has been deployed, and moving onto it.
 *
 * The service worker serves the cached document first and refreshes it in the
 * background, which keeps launches fast but means the first launch after a
 * deploy always shows the previous build. That was invisible until a feature
 * shipped: dispatching was live, and every phone — the Android app and mobile
 * browsers alike — still showed the console without it. The Android app is
 * worse off than a tab, because it sits in the background for days and never
 * navigates again, so "the next launch" may never come.
 *
 * So the page asks the server which entry script is current — on start, when it
 * comes back to the foreground, and periodically while visible — and compares
 * it with the one it is running. When they differ it reloads, unless that could
 * cost someone what they are typing, in which case it says a new version is
 * ready and leaves the reload to them.
 */

/** The hashed entry module a document loads, e.g. `/assets/index-B2Kzl8qX.js`. */
export function entryScriptOf(html: string): string | undefined {
  const match = /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/i.exec(html)
    ?? /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"[^>]*\btype="module"/i.exec(html);
  return match?.[1];
}

export type UpdateDecision = "none" | "reload" | "prompt";

export type UpdateInputs = {
  /** The entry script this page is running, or undefined in development. */
  current: string | undefined;
  /** The entry script the server serves now. */
  latest: string | undefined;
  /** The entry script a previous automatic reload was aiming for, if any. */
  reloadedFor: string | null;
  /** A form holds input that only lives in memory. */
  hasUnsavedInput: boolean;
  /** Milliseconds since the person last pressed a key or touched the page. */
  msSinceInteraction: number;
};

/**
 * How long the person has to be hands-off before reloading under them is fine.
 * Long enough that a reload never lands mid-sentence; short enough that coming
 * back to the app and waiting a moment is enough.
 */
export const QUIET_BEFORE_RELOAD_MS = 15_000;

export function decideUpdate(inputs: UpdateInputs): UpdateDecision {
  // Development serves unhashed modules and a failed check knows nothing: in
  // both cases there is no evidence of a newer build.
  if (!inputs.current || !inputs.latest || inputs.current === inputs.latest) return "none";
  // Already reloaded once for exactly this build and still not running it — a
  // cache somewhere in front of the server is handing back the old document.
  // Reloading again would loop; ask instead.
  if (inputs.reloadedFor === inputs.latest) return "prompt";
  if (inputs.hasUnsavedInput) return "prompt";
  if (inputs.msSinceInteraction < QUIET_BEFORE_RELOAD_MS) return "prompt";
  return "reload";
}

/** Minimum gap between two checks triggered by coming back to the foreground. */
export const FOREGROUND_CHECK_THROTTLE_MS = 60_000;
/** How often to check while the page stays visible. */
export const PERIODIC_CHECK_MS = 10 * 60_000;

const RELOADED_FOR_KEY = "missiongo:reloaded-for-build";

type Listener = () => void;

let updateReady = false;
const listeners = new Set<Listener>();

/** Whether a newer build is waiting for the person to reload. */
export function isUpdateReady(): boolean {
  return updateReady;
}

export function subscribeToUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announceUpdate(): void {
  if (updateReady) return;
  updateReady = true;
  for (const listener of listeners) listener();
}

/**
 * Forget the cached documents before reloading. The service worker answers a
 * navigation from its cache whenever that copy is complete, so without this the
 * reload could be served the very document it is trying to leave.
 */
async function dropCachedDocuments(): Promise<void> {
  if (!("caches" in window)) return;
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("missiongo-shell")).map(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((request) => request.mode === "navigate" || new URL(request.url).pathname === "/")
      .map((request) => cache.delete(request)));
  }));
}

export async function reloadToLatest(latest?: string): Promise<void> {
  try {
    if (latest) sessionStorage.setItem(RELOADED_FOR_KEY, latest);
  } catch {
    // Storage can be unavailable; the loop guard is then simply absent.
  }
  try {
    await dropCachedDocuments();
  } catch {
    // A reload that may be served from cache is still better than none.
  }
  window.location.reload();
}

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

async function fetchLatestEntryScript(): Promise<string | undefined> {
  try {
    // A plain fetch, not a navigation, so the service worker lets it through to
    // the network; no-store so no HTTP cache answers for the server either.
    const response = await fetch("/", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return undefined;
    return entryScriptOf(await response.text());
  } catch {
    return undefined;
  }
}

/**
 * Start watching for newer builds. `hasUnsavedInput` is read at decision time,
 * so a form that opens after start is still respected.
 */
export function startVersionWatch(options: { hasUnsavedInput: () => boolean }): void {
  const current = entryScriptOf(document.documentElement.outerHTML);
  if (!current) return;

  // A page that has just loaded counts as quiet: nobody has typed into it yet,
  // and the launch served from yesterday's cache is exactly the one to replace
  // before anyone starts.
  let lastInteraction = Date.now() - QUIET_BEFORE_RELOAD_MS;
  const markInteraction = () => { lastInteraction = Date.now(); };
  for (const type of ["keydown", "pointerdown", "input"] as const) {
    window.addEventListener(type, markInteraction, { capture: true, passive: true });
  }

  let lastCheck = 0;
  let checking = false;
  const check = async () => {
    if (checking || updateReady) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const latest = await fetchLatestEntryScript();
      const decision = decideUpdate({
        current,
        latest,
        reloadedFor: readReloadedFor(),
        hasUnsavedInput: options.hasUnsavedInput(),
        msSinceInteraction: Date.now() - lastInteraction,
      });
      if (decision === "reload") await reloadToLatest(latest);
      else if (decision === "prompt") announceUpdate();
    } finally {
      checking = false;
    }
  };

  // Soon after start: the case that matters most is a launch that was just
  // served yesterday's build from cache.
  window.setTimeout(() => void check(), 2_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Coming back counts as a fresh start for the quiet period: someone who just
    // switched to the app has not typed anything into it yet.
    lastInteraction = Date.now() - QUIET_BEFORE_RELOAD_MS;
    if (Date.now() - lastCheck >= FOREGROUND_CHECK_THROTTLE_MS) void check();
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") void check();
  }, PERIODIC_CHECK_MS);

  // The service worker says so as soon as its background refresh brings in a
  // different document, which is sooner than any timer here.
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type === "missiongo:document-updated") void check();
  });
}
