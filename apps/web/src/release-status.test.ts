import { afterEach, expect, it, vi } from "vitest";
import { checkReleaseStatus, deploymentInProgress, parseReleaseStatus, releaseStatusSnapshot } from "./release-status";
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
