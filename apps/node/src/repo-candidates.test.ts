import { describe, expect, it } from "vitest";

import { isSessionWorktree, parseRepoCandidates } from "./repo-candidates.js";

function claudeJson(projects: Record<string, unknown>): string {
  return JSON.stringify({ projects });
}

const everythingIsARepo = () => true;

describe("Reading this machine's checkouts from Claude Code's project list", () => {
  it("offers trusted git checkouts, newest first", () => {
    const candidates = parseRepoCandidates(
      claudeJson({
        "/Users/dev/Projects/hermes": { hasTrustDialogAccepted: true, lastSessionModified: 1_000 },
        "/Users/dev/Projects/missiongo": { hasTrustDialogAccepted: true, lastSessionModified: 9_000 },
      }),
      { isRepo: everythingIsARepo },
    );
    expect(candidates.map((candidate) => candidate.name)).toEqual(["missiongo", "hermes"]);
    expect(candidates[0]).toMatchObject({ path: "/Users/dev/Projects/missiongo", name: "missiongo" });
  });

  it("leaves out what a dispatch could not actually use", () => {
    const candidates = parseRepoCandidates(
      claudeJson({
        // Untrusted: offering it would read as "this one works", and the session
        // would hang on the trust dialog instead.
        "/Users/dev/Projects/untrusted": { hasTrustDialogAccepted: false, lastSessionModified: 9_000 },
        // Not a git checkout.
        "/Users/dev/Documents/notes": { hasTrustDialogAccepted: true, lastSessionModified: 8_000 },
        // A session's own scratch worktree, which may be deleted at any time.
        "/Users/dev/Projects/missiongo/.claude/worktrees/mg-1f2e3d4c": {
          hasTrustDialogAccepted: true,
          lastSessionModified: 7_000,
        },
        "/Users/dev/Projects/missiongo": { hasTrustDialogAccepted: true, lastSessionModified: 6_000 },
      }),
      { isRepo: (path) => !path.includes("/Documents/") },
    );
    expect(candidates.map((candidate) => candidate.path)).toEqual(["/Users/dev/Projects/missiongo"]);
  });

  it("caps the list and survives a missing or unreadable file", () => {
    const many = Object.fromEntries(
      Array.from({ length: 80 }, (_value, index) => [
        `/Users/dev/Projects/repo-${index}`,
        { hasTrustDialogAccepted: true, lastSessionModified: index },
      ]),
    );
    expect(parseRepoCandidates(claudeJson(many), { isRepo: everythingIsARepo, limit: 50 })).toHaveLength(50);
    expect(parseRepoCandidates(undefined)).toEqual([]);
    expect(parseRepoCandidates("{ not json")).toEqual([]);
    expect(parseRepoCandidates("{}")).toEqual([]);
  });

  it("falls back to the checkout's mtime when no session time was recorded", () => {
    // Claude Code leaves the field null while a session is still open, which is
    // the repository most likely to be dispatched to next.
    const candidates = parseRepoCandidates(
      claudeJson({
        "/Users/dev/Projects/older": { hasTrustDialogAccepted: true, lastSessionModified: 1_000 },
        "/Users/dev/Projects/open-now": { hasTrustDialogAccepted: true, lastSessionModified: null },
      }),
      {
        isRepo: everythingIsARepo,
        modifiedAt: (path) => (path.endsWith("open-now") ? 5_000 : undefined),
      },
    );
    expect(candidates.map((candidate) => candidate.name)).toEqual(["open-now", "older"]);
  });

  it("recognises a session worktree by its path", () => {
    expect(isSessionWorktree("/Users/dev/p/.claude/worktrees/mg-1")).toBe(true);
    expect(isSessionWorktree("/Users/dev/p/worktrees/mine")).toBe(false);
    expect(isSessionWorktree("/Users/dev/p")).toBe(false);
  });
});
