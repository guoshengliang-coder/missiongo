/** Only an explicit, bounded deployment signal can turn a connection failure into an upgrade. */
export const RELEASE_STATUS_PATH = "/release-status.json";
export interface ReleaseStatus { version: 1; phase: "idle" | "upgrading" | "failed"; expiresAt: number; release: string }
export function parseReleaseStatus(value: unknown, now = Date.now()): ReleaseStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ReleaseStatus>;
  if (v.version !== 1 || !["idle", "upgrading", "failed"].includes(v.phase ?? "")
    || typeof v.release !== "string" || !Number.isSafeInteger(v.expiresAt)) return null;
  if (v.phase !== "idle" && (v.expiresAt! <= now || v.expiresAt! > now + 15 * 60_000)) return null;
  return v as ReleaseStatus;
}
let current: ReleaseStatus | null = null;
const listeners = new Set<() => void>();
export const subscribeReleaseStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const releaseStatusSnapshot = () => current;
export const deploymentInProgress = () => current?.phase === "upgrading" && current.expiresAt > Date.now();
let checking: Promise<void> | undefined;
export function checkReleaseStatus(): Promise<void> {
  if (checking) return checking;
  checking = (async () => {
    let next = current && current.expiresAt > Date.now() ? current : null;
    try {
      const response = await fetch(RELEASE_STATUS_PATH, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5_000) });
      if (response.ok) next = parseReleaseStatus(await response.json());
    } catch { /* A failed probe is not evidence of an upgrade, nor of recovery. */ }
    if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; listeners.forEach(listener => listener()); }
  })().finally(() => { checking = undefined; });
  return checking;
}
export function startReleaseStatusWatch(): () => void {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, stopped = false;
  const schedule = () => {
    if (stopped) return;
    if (expiry) clearTimeout(expiry);
    expiry = undefined;
    if (current?.phase !== "upgrading") attempts = 0;
    if (current && current.phase !== "idle" && current.expiresAt > Date.now()) {
      // Deployment markers live outside Server, so there is no database/SSE
      // event for the marker returning to idle. Retry only a confirmed active
      // upgrade, with bounded backoff and the original expiry as the deadline.
      const remaining = current.expiresAt - Date.now() + 1;
      const delay = current.phase === "upgrading" ? Math.min(remaining, 2000 * 2 ** Math.min(attempts++, 3)) : remaining;
      expiry = setTimeout(async () => { await checkReleaseStatus(); schedule(); }, delay);
    }
  };
  const unsubscribe = subscribeReleaseStatus(schedule);
  void checkReleaseStatus();
  schedule();
  const connected = () => void checkReleaseStatus();
  window.addEventListener("missiongo:console-connected", connected);
  const foreground = () => { if (document.visibilityState === "visible") void checkReleaseStatus(); };
  document.addEventListener("visibilitychange", foreground);
  return () => { stopped = true; if (expiry) clearTimeout(expiry); unsubscribe(); window.removeEventListener("missiongo:console-connected", connected); document.removeEventListener("visibilitychange", foreground); };
}
