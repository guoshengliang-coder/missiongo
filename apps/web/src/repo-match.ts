import type { Product, RepoCandidate } from "./types";

/**
 * Which reported checkout a product probably lives in, and whether a row has to
 * fall back to a typed path.
 *
 * The machine reports directory names and nothing else -- it deliberately never
 * sends git remotes, so there is no authoritative link between a product and a
 * folder. Everything here is therefore a suggestion offered to a person, never a
 * mapping: the caller still shows it as a suggestion and the person still saves.
 */

/**
 * Directory names compare without case, spaces, hyphens or underscores:
 * `MissionGo`, `mission-go` and `mission_go` are one checkout to a person, and
 * which of them a folder happens to use says nothing about the product.
 */
export function normalizeRepoName(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Two characters are not evidence. `go` sits inside `django`, and a two-letter
 * key prefix sits inside half the directories on a machine, so a fragment that
 * short is only ever allowed to match as a whole name.
 */
const MIN_FRAGMENT = 3;

const EXACT = 3;
const CONTAINS = 2;
const PREFIX = 1;

/** 0 when nothing links them; higher is a stronger reason to suggest. */
function matchScore(product: Pick<Product, "name" | "keyPrefix">, candidate: RepoCandidate): number {
  const directory = normalizeRepoName(candidate.name);
  const name = normalizeRepoName(product.name);
  if (directory && name) {
    if (directory === name) return EXACT;
    if (
      directory.length >= MIN_FRAGMENT
      && name.length >= MIN_FRAGMENT
      && (directory.includes(name) || name.includes(directory))
    ) return CONTAINS;
  }
  // The weakest rule, and anchored at the start on purpose: a prefix allowed to
  // match anywhere would offer `sandbox` for AND, which is worse than offering
  // nothing at all -- a wrong suggestion costs a person more than a blank row.
  const prefix = normalizeRepoName(product.keyPrefix);
  if (directory && prefix.length >= MIN_FRAGMENT && directory.startsWith(prefix)) return PREFIX;
  return 0;
}

/**
 * A candidate with no reported time loses to one that has it, and with neither
 * the earlier entry wins: the server orders the list newest first, so keeping
 * the incumbent already prefers the more recently used checkout.
 */
function lastUsedTime(candidate: RepoCandidate): number {
  const parsed = candidate.lastUsedAt ? Date.parse(candidate.lastUsedAt) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * The checkout to pre-select for a product that has no mapping yet, or undefined
 * when no reported directory resembles it.
 */
export function suggestRepoCandidate(
  product: Pick<Product, "name" | "keyPrefix">,
  candidates: readonly RepoCandidate[],
): RepoCandidate | undefined {
  let best: RepoCandidate | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = matchScore(product, candidate);
    if (score === 0) continue;
    if (score > bestScore || (score === bestScore && best && lastUsedTime(candidate) > lastUsedTime(best))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Whether a row has to offer a free-text path instead of the reported list.
 *
 * Two cases, and both are about not losing what is already true: a machine that
 * has reported nothing has no list to choose from, and a saved mapping that is
 * not in the list is still the mapping in force -- dropping it silently would
 * un-dispatch a product the next time somebody saved the form. A repository that
 * has never been opened in Claude Code is simply not among the candidates.
 */
export function startsInManualMode(
  savedPath: string | undefined,
  candidates: readonly RepoCandidate[],
): boolean {
  if (candidates.length === 0) return true;
  if (!savedPath) return false;
  return !candidates.some((candidate) => candidate.path === savedPath);
}
