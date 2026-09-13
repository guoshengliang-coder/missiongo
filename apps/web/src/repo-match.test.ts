import { describe, expect, it } from "vitest";

import { normalizeRepoName, startsInManualMode, suggestRepoCandidate } from "./repo-match";
import type { RepoCandidate } from "./types";

const candidate = (name: string, path: string, lastUsedAt?: string): RepoCandidate => ({
  name,
  path,
  ...(lastUsedAt ? { lastUsedAt } : {}),
});

const product = (name: string, keyPrefix: string) => ({ name, keyPrefix });

describe("suggesting the checkout a product lives in", () => {
  it("takes the directory whose name is the product name", () => {
    const candidates = [candidate("notes", "/work/notes"), candidate("missiongo", "/work/missiongo")];
    expect(suggestRepoCandidate(product("MissionGo", "AND"), candidates)?.path).toBe("/work/missiongo");
  });

  it("ignores case, spaces, hyphens and underscores", () => {
    expect(normalizeRepoName("Mission-Go_v2 ")).toBe("missiongov2");
    for (const directory of ["mission-go", "Mission_Go", "MISSIONGO"]) {
      expect(suggestRepoCandidate(product("Mission Go", "AND"), [candidate(directory, `/work/${directory}`)])?.name)
        .toBe(directory);
    }
  });

  it("accepts a directory that contains the product name, or is contained by it", () => {
    expect(suggestRepoCandidate(product("Hugo", "HG"), [candidate("hugo-android", "/work/hugo-android")])?.path)
      .toBe("/work/hugo-android");
    expect(suggestRepoCandidate(product("Hugo Android", "HG"), [candidate("hugo", "/work/hugo")])?.path)
      .toBe("/work/hugo");
  });

  it("prefers an exact name over one that merely contains it", () => {
    const candidates = [candidate("hugo-android", "/work/hugo-android"), candidate("hugo", "/work/hugo")];
    expect(suggestRepoCandidate(product("Hugo", "HG"), candidates)?.path).toBe("/work/hugo");
  });

  it("uses the key prefix only at the start of a name, and only from three characters", () => {
    expect(suggestRepoCandidate(product("Mobile client", "AND"), [candidate("android", "/work/android")])?.path)
      .toBe("/work/android");
    // `sandbox` contains "and" in the middle: a suggestion there would be wrong.
    expect(suggestRepoCandidate(product("Mobile client", "AND"), [candidate("sandbox", "/work/sandbox")]))
      .toBeUndefined();
    expect(suggestRepoCandidate(product("Mobile client", "HG"), [candidate("hgfs", "/work/hgfs")]))
      .toBeUndefined();
  });

  it("suggests nothing when no directory resembles the product", () => {
    const candidates = [candidate("dotfiles", "/work/dotfiles"), candidate("blog", "/work/blog")];
    expect(suggestRepoCandidate(product("MissionGo", "AND"), candidates)).toBeUndefined();
    expect(suggestRepoCandidate(product("MissionGo", "AND"), [])).toBeUndefined();
  });

  it("breaks a tie toward the more recently used checkout", () => {
    const older = candidate("missiongo", "/work/old/missiongo", "2026-09-01T10:00:00Z");
    const newer = candidate("missiongo", "/work/new/missiongo", "2026-09-12T10:00:00Z");
    expect(suggestRepoCandidate(product("MissionGo", "AND"), [older, newer])?.path).toBe("/work/new/missiongo");
    expect(suggestRepoCandidate(product("MissionGo", "AND"), [newer, older])?.path).toBe("/work/new/missiongo");
  });

  it("keeps the server's order when a tied candidate reports no time", () => {
    const untimed = candidate("missiongo", "/work/a/missiongo");
    const timed = candidate("missiongo", "/work/b/missiongo", "2026-09-01T10:00:00Z");
    expect(suggestRepoCandidate(product("MissionGo", "AND"), [untimed, timed])?.path).toBe("/work/b/missiongo");
    expect(suggestRepoCandidate(product("MissionGo", "AND"), [untimed, candidate("missiongo", "/work/c/missiongo")])?.path)
      .toBe("/work/a/missiongo");
  });
});

describe("choosing between the reported list and a typed path", () => {
  const candidates = [candidate("missiongo", "/work/missiongo"), candidate("notes", "/work/notes")];

  it("uses the list when a saved mapping is in it", () => {
    expect(startsInManualMode("/work/missiongo", candidates)).toBe(false);
  });

  it("keeps showing a saved mapping the machine did not report", () => {
    expect(startsInManualMode("/elsewhere/missiongo", candidates)).toBe(true);
  });

  it("starts on the list for a product with no mapping yet", () => {
    expect(startsInManualMode(undefined, candidates)).toBe(false);
    expect(startsInManualMode("", candidates)).toBe(false);
  });

  it("falls back to typing when the machine has reported nothing", () => {
    expect(startsInManualMode(undefined, [])).toBe(true);
    expect(startsInManualMode("/work/missiongo", [])).toBe(true);
  });
});
