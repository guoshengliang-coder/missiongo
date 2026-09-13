import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { readClaudeJson } from "./preflight.js";

/**
 * The checkouts this machine can already work in.
 *
 * Typing an absolute path into a web form is both tedious and the easiest place
 * to get a dispatch wrong — a typo only shows up as a failed launch minutes
 * later. Claude Code already keeps the list of directories it has been opened
 * in, so the machine offers those instead and the console becomes a choice
 * rather than a text field.
 *
 * Only the path and the directory name leave the machine. Git remotes would
 * match products more reliably, but they carry private hosts and owners into the
 * server's database and its backups, and a directory name is enough to sort the
 * likely candidate to the top of a list the operator confirms anyway.
 */
export type RepoCandidate = {
  readonly path: string;
  readonly name: string;
  readonly lastUsedAt?: string;
};

export const MAX_REPO_CANDIDATES = 50;

type ProjectEntry = {
  hasTrustDialogAccepted?: unknown;
  lastSessionModified?: unknown;
};

function isGitRepository(path: string): boolean {
  try {
    // A worktree records `.git` as a file, a clone as a directory.
    statSync(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Worktrees under `.claude/worktrees/` are per-session scratch copies — several
 * of them are this daemon's own leftovers. Offering them would let a dispatch
 * land in a copy that is about to be deleted.
 */
export function isSessionWorktree(path: string): boolean {
  return path.split(sep).includes("worktrees") && path.includes(`${sep}.claude${sep}`);
}

/**
 * Claude Code leaves `lastSessionModified` null for a project with a session
 * still open — which is exactly the repository someone is about to dispatch to.
 * The checkout's own mtime keeps those from sinking to the bottom of the list.
 */
function directoryModifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function parseRepoCandidates(
  claudeJson: string | undefined,
  options: {
    isRepo?: (path: string) => boolean;
    limit?: number;
    modifiedAt?: (path: string) => number | undefined;
  } = {},
): readonly RepoCandidate[] {
  if (!claudeJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(claudeJson);
  } catch {
    return [];
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (typeof projects !== "object" || projects === null) return [];

  const isRepo = options.isRepo ?? isGitRepository;
  const limit = options.limit ?? MAX_REPO_CANDIDATES;
  const seen = new Set<string>();
  const candidates: Array<RepoCandidate & { sortKey: number }> = [];

  for (const [rawPath, value] of Object.entries(projects as Record<string, unknown>)) {
    const entry = (typeof value === "object" && value !== null ? value : {}) as ProjectEntry;
    // Untrusted directories are skipped rather than offered and refused later:
    // a candidate in the list reads as "this one works".
    if (entry.hasTrustDialogAccepted !== true) continue;
    const path = resolve(rawPath);
    if (seen.has(path)) continue;
    if (isSessionWorktree(path)) continue;
    if (!isRepo(path)) continue;
    seen.add(path);

    const modifiedAt = options.modifiedAt ?? directoryModifiedAt;
    const recorded = typeof entry.lastSessionModified === "number"
      ? entry.lastSessionModified
      : Date.parse(String(entry.lastSessionModified ?? ""));
    const sortKey = Number.isNaN(recorded) ? modifiedAt(path) ?? 0 : recorded;
    candidates.push({
      path,
      name: basename(path),
      ...(sortKey ? { lastUsedAt: new Date(sortKey).toISOString() } : {}),
      sortKey,
    });
  }

  return candidates
    .sort((left, right) => right.sortKey - left.sortKey || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map(({ sortKey: _sortKey, ...candidate }) => candidate);
}

export function detectRepoCandidates(home: string = homedir()): readonly RepoCandidate[] {
  return parseRepoCandidates(readClaudeJson(home));
}
