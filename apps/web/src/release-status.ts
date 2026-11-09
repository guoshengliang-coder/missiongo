/** Only an explicit, bounded deployment signal identifies an upgrade. */
export const RELEASE_STATUS_PATH = "/release-status.json";
export const RELEASE_FAILURE_STAGES = ["restart", "health"] as const;
export const RELEASE_FAILURE_REASONS = ["restart_check_failed", "health_timeout", "health_unavailable", "health_mismatch", "health_invalid", "unknown"] as const;
export interface ReleaseFailure {
  stage: typeof RELEASE_FAILURE_STAGES[number];
  reason: typeof RELEASE_FAILURE_REASONS[number];
  occurredAt: number;
}
export interface ReleaseStatus { version: 1; phase: "idle" | "upgrading" | "failed"; expiresAt: number; release: string; failure?: ReleaseFailure }
export function parseReleaseStatus(value: unknown, now = Date.now()): ReleaseStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ReleaseStatus>;
  if (v.version !== 1 || !["idle", "upgrading", "failed"].includes(v.phase ?? "")
    || typeof v.release !== "string" || !Number.isSafeInteger(v.expiresAt)) return null;
  if (v.phase !== "idle" && (v.expiresAt! <= now || v.expiresAt! > now + 15 * 60_000)) return null;
  const f = v.failure;
  const failure = v.phase === "failed" && f && RELEASE_FAILURE_STAGES.includes(f.stage) && RELEASE_FAILURE_REASONS.includes(f.reason)
    && Number.isSafeInteger(f.occurredAt) && f.occurredAt > 0 && f.occurredAt <= now + 60_000
    ? { stage: f.stage, reason: f.reason, occurredAt: f.occurredAt } : undefined;
  return { version: 1, phase: v.phase!, expiresAt: v.expiresAt!, release: v.release, ...(failure ? { failure } : {}) };
}
export interface ReleaseProbe { state: "idle" | "checking" | "success" | "failed"; error?: "timeout" | "unavailable" | "invalid" }
let current: ReleaseStatus | null = null;
let probe: ReleaseProbe = { state: "idle" };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeReleaseStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const releaseStatusSnapshot = () => current;
export const releaseProbeSnapshot = () => probe;
export const deploymentInProgress = () => current?.phase === "upgrading" && current.expiresAt > Date.now();
let checking: Promise<void> | undefined;
export function checkReleaseStatus(): Promise<void> {
  if (checking) return checking;
  // Reserve the in-flight promise before notifying subscribers, including reentrant callers.
  checking = Promise.resolve().then(async () => {
    probe = { state: "checking" }; notify();
    let next = current;
    try {
      const response = await fetch(RELEASE_STATUS_PATH, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("unavailable");
      const value: unknown = await response.json();
      const parsed = parseReleaseStatus(value);
      if (!parsed) {
        const expired = value && typeof value === "object" && "version" in value && value.version === 1
          && "expiresAt" in value && typeof value.expiresAt === "number" && value.expiresAt <= Date.now()
          && "phase" in value && (value.phase === "upgrading" || value.phase === "failed");
        if (!expired) throw new Error("invalid");
      }
      next = parsed;
      probe = { state: "success" };
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      probe = { state: "failed", error: timeout ? "timeout" : error instanceof Error && error.message === "invalid" ? "invalid" : "unavailable" };
      // Failure is neither upgrade nor recovery evidence. Retain only an unexpired fact.
    }
    current = next?.phase === "idle" || next && next.expiresAt > Date.now() ? next : null;
    notify();
  }).finally(() => { checking = undefined; });
  return checking;
}
export function startReleaseStatusWatch(): () => void {
  void checkReleaseStatus();
  const timer = window.setInterval(() => { if (document.visibilityState === "visible") void checkReleaseStatus(); }, 5_000);
  const foreground = () => { if (document.visibilityState === "visible") void checkReleaseStatus(); };
  document.addEventListener("visibilitychange", foreground);
  return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", foreground); };
}
