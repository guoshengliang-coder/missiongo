import { describe, expect, it } from "vitest";

import {
  arrivalBaseline,
  arrivalProgress,
  MACOS_CLIENT_DOWNLOAD_PATH,
  NODE_LIST_REFETCH_MS,
  NODE_LIST_WAITING_REFETCH_MS,
  NODE_WAIT_GIVE_UP_MS,
  nodeListRefetchInterval,
} from "./node-install";
import type { DispatchNode } from "./types";

const node = (id: string, overrides: Partial<DispatchNode> = {}): DispatchNode => ({
  id,
  name: `machine ${id}`,
  agents: [],
  repos: [],
  repoCandidates: [],
  online: false,
  createdAt: "2026-09-13T08:00:00.000Z",
  ...overrides,
});

describe("the macOS client download", () => {
  it("points at the latest zip this deployment serves", () => {
    expect(MACOS_CLIENT_DOWNLOAD_PATH).toBe("/downloads/missiongo-macos-latest.zip");
  });
});

describe("waiting for a Mac to sign in", () => {
  const startedAt = Date.parse("2026-09-13T08:00:00.000Z");
  const now = startedAt + 60_000;
  const arrival = { baseline: ["old"], startedAt };

  it("remembers the usable machines, but not revoked ones that a sign-in would restore", () => {
    expect(arrivalBaseline([node("old"), node("gone", { revokedAt: "2026-09-12T08:00:00.000Z" })])).toEqual(["old"]);
  });

  it("waits while the list holds only machines that were there before", () => {
    expect(arrivalProgress(arrival, [node("old", { online: true })], now)).toEqual({ state: "waiting" });
  });

  it("reports a new machine that signed in but has not come online", () => {
    const fresh = node("fresh");
    expect(arrivalProgress(arrival, [node("old", { online: true }), fresh], now)).toEqual({ state: "signedIn", node: fresh });
  });

  it("reports the new machine once it is online", () => {
    const fresh = node("fresh", { name: "办公室 Mac mini", online: true });
    expect(arrivalProgress(arrival, [node("old", { online: true }), fresh], now)).toEqual({ state: "online", node: fresh });
  });

  it("does not take an old machine coming back online for the new one", () => {
    expect(arrivalProgress(arrival, [node("old", { online: true, name: "same name" })], now).state).toBe("waiting");
  });

  it("ignores a new machine while it is revoked, and counts it once a sign-in restores it", () => {
    const revoked = node("gone", { revokedAt: "2026-09-12T08:00:00.000Z" });
    const waitingOnIt = { baseline: arrivalBaseline([node("old"), revoked]), startedAt };
    expect(arrivalProgress(waitingOnIt, [node("old"), revoked], now).state).toBe("waiting");
    expect(arrivalProgress(waitingOnIt, [node("old"), node("gone", { online: true })], now).state).toBe("online");
  });

  it("gives up after fifteen minutes with nothing online", () => {
    expect(NODE_WAIT_GIVE_UP_MS).toBe(15 * 60_000);
    const justBefore = startedAt + NODE_WAIT_GIVE_UP_MS - 1;
    const later = startedAt + NODE_WAIT_GIVE_UP_MS;
    expect(arrivalProgress(arrival, [node("old")], justBefore)).toEqual({ state: "waiting" });
    expect(arrivalProgress(arrival, [node("old")], later)).toEqual({ state: "gaveUp" });
    expect(arrivalProgress(arrival, [node("fresh")], later)).toEqual({ state: "gaveUp" });
  });

  it("still confirms a Mac that comes online after the wait gave up", () => {
    const later = startedAt + NODE_WAIT_GIVE_UP_MS + 60_000;
    expect(arrivalProgress(arrival, [node("fresh", { online: true })], later).state).toBe("online");
  });

  it("polls fast only while a machine is expected", () => {
    expect(nodeListRefetchInterval(undefined)).toBe(NODE_LIST_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "waiting" })).toBe(NODE_LIST_WAITING_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "signedIn", node: node("fresh") })).toBe(NODE_LIST_WAITING_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "online", node: node("fresh", { online: true }) })).toBe(NODE_LIST_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "gaveUp" })).toBe(NODE_LIST_REFETCH_MS);
    expect(NODE_LIST_WAITING_REFETCH_MS).toBe(5_000);
    expect(NODE_LIST_REFETCH_MS).toBe(30_000);
  });
});
