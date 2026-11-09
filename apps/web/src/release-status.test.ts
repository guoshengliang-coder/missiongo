import { afterEach, expect, it, vi } from "vitest";
import { checkReleaseStatus, deploymentInProgress, parseReleaseStatus, releaseStatusSnapshot, startReleaseStatusWatch } from "./release-status";
const now = 2_000_000;
const status = { version: 1, phase: "upgrading", expiresAt: now + 600_000, release: "abc" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("requires explicit versioned bounded signals, never a generic outage", () => {
  expect(parseReleaseStatus(status, now)).toEqual(status);
  for (const value of [null, "updating", { ...status, version: 2 }, { ...status, expiresAt: now }, { ...status, expiresAt: now + 900_001 }, { ...status, phase: "unknown" }]) expect(parseReleaseStatus(value, now)).toBeNull();
  expect(parseReleaseStatus({ ...status, phase: "idle", expiresAt: 0 }, now)?.phase).toBe("idle");
});
it("retains a known upgrade through dropped connections, expires it, and accepts confirmed recovery", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(status)));
  vi.stubGlobal("fetch", fetch);
  await checkReleaseStatus(); expect(deploymentInProgress()).toBe(true);
  fetch.mockRejectedValue(new TypeError("offline"));
  await checkReleaseStatus(); expect(deploymentInProgress()).toBe(true);
  vi.setSystemTime(now + 600_001);
  await checkReleaseStatus(); expect(releaseStatusSnapshot()).toBeNull();
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...status, phase: "idle", expiresAt: 0 })));
  await checkReleaseStatus(); expect(deploymentInProgress()).toBe(false);
  expect(releaseStatusSnapshot()?.phase).toBe("idle");
});
it("blocks new writes during a confirmed upgrade without submitting or replaying them", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(status)));
  vi.stubGlobal("fetch", fetch);
  await checkReleaseStatus();
  const { request } = await import("./api");
  fetch.mockClear();
  await expect(request("/api/v1/example", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "deployment_in_progress" });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...status, phase: "idle", expiresAt: 0 })));
  await checkReleaseStatus();
  expect(fetch).toHaveBeenCalledTimes(1); // Recovery queried only the status, never the blocked mutation.
});

it("retries only a confirmed upgrade and stops probing when it returns to idle",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("document",Object.assign(new EventTarget(),{visibilityState:"visible"}));
 let phase="upgrading";
 const fetch=vi.fn(async()=>new Response(JSON.stringify({...status,phase})));vi.stubGlobal("fetch",fetch);
 const stop=startReleaseStatusWatch();
 try {
  await vi.advanceTimersByTimeAsync(2001);expect(fetch.mock.calls.length).toBeGreaterThan(1);
  phase="idle";await vi.advanceTimersByTimeAsync(20_000);expect(releaseStatusSnapshot()?.phase).toBe("idle");
  fetch.mockClear();await vi.advanceTimersByTimeAsync(180_000);expect(fetch).not.toHaveBeenCalled();
 } finally {stop();}
});

it("strips unknown diagnostics and private fields while accepting the legacy protocol", () => {
  const failure = { stage: "health", reason: "health_timeout", occurredAt: now - 10, rawLog: "private" };
  expect(parseReleaseStatus({ ...status, phase: "failed", failure, rawLog: "private" }, now)?.failure)
    .toEqual({ stage: "health", reason: "health_timeout", occurredAt: now - 10 });
  for (const patch of [{ reason: "private host" }, { stage: "command" }, { occurredAt: now + 60_001 }, { occurredAt: 0 }]) {
    const parsed = parseReleaseStatus({ ...status, phase: "failed", failure: { ...failure, ...patch } }, now);
    expect(parsed?.phase).toBe("failed"); expect(parsed?.failure).toBeUndefined();
  }
  expect(parseReleaseStatus({ ...status, phase: "failed" }, now)?.failure).toBeUndefined();
});
it("deduplicates checks and exposes failure without inventing recovery", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let finish!: (value: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const { releaseProbeSnapshot } = await import("./release-status");
  const first = checkReleaseStatus(); const second = checkReleaseStatus();
  expect(first).toBe(second);
  await Promise.resolve(); expect(releaseProbeSnapshot().state).toBe("checking");
  finish(new Response(JSON.stringify(status))); await first;
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  await checkReleaseStatus(); expect(releaseProbeSnapshot()).toEqual({ state: "failed", error: "timeout" });
  expect(deploymentInProgress()).toBe(true);
  fetch.mockResolvedValue(new Response("invalid"));
  await checkReleaseStatus(); expect(releaseProbeSnapshot().state).toBe("failed");
  expect(deploymentInProgress()).toBe(true);});
