#!/usr/bin/env node
//
// What a release contains, for the update dialog an installed client shows.
//
// Read from the git history rather than a hand-written changelog: a merge commit
// names its pull request, and each client declares the work items in its own
// release-notes directory. A PR that changes a client without declaring one is
// refused at publish time, so a shipped build can never show an empty or
// half-filled list of what changed.
//
// Two clients read this: the macOS app and the Android app (AND-258). Their
// manifests are different files, but the notes have the same shape, so the rules
// live here once and the difference is the client entry below.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Per client: where its declarations live, which trees count as "the client",
 * and the files whose only job is to carry the version number -- a release PR
 * may bump one of those without declaring an update a person would read.
 *
 * The `clientRoots` for the Android app match `released.json`'s `androidApp`
 * paths, because those are what the published APK is built from: the app module
 * and the feedback SDK it compiles in.
 */
export const CLIENTS = {
  androidApp: {
    label: "Android client",
    notesDir: "release-notes/android",
    clientRoots: ["apps/android/", "sdks/android-feedback/missiongo-feedback/"],
    versionOnlyPaths: ["sdks/android-feedback/gradle.properties"],
  },
  macosApp: {
    label: "macOS client",
    notesDir: "release-notes/macos",
    clientRoots: ["apps/macos/"],
    versionOnlyPaths: ["apps/macos/version.properties"],
  },
};

const DEFAULT_ARTIFACT = "macosApp";

export function clientConfig(artifact = DEFAULT_ARTIFACT) {
  const client = CLIENTS[artifact];
  if (!client) throw new Error(`Unknown artifact "${artifact}"; expected one of ${Object.keys(CLIENTS).join(", ")}`);
  return client;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function pullRequest(commit) {
  let match = /^Merge pull request #([1-9][0-9]*)\b/.exec(commit.subject);
  if (!match) match = /\(#([1-9][0-9]*)\)$/.exec(commit.subject);
  if (!match) return null;
  const bodyTitle = commit.body.split("\n").map((line) => line.trim()).find(Boolean);
  const title = bodyTitle ?? commit.subject.replace(/\s*\(#[1-9][0-9]*\)$/, "").trim();
  return { pullRequestNumber: Number(match[1]), title };
}

/// A change to the client itself, as opposed to a release PR that only moves the
/// version number forward.
function touchesClient(files, client) {
  return files.some((path) =>
    client.clientRoots.some((root) => path.startsWith(root)) && !client.versionOnlyPaths.includes(path),
  );
}

function assertRange(root, from, to) {
  if (![from, git(root, "rev-parse", to)].every((value) => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error("release note range must use full commit hashes");
  }
}

/// Every merged PR in the range, oldest first, with the files it changed. One
/// traversal feeds both the published notes and the check that no client change
/// slipped through without a declaration.
function mergedPullRequests({ root, from, to }) {
  assertRange(root, from, to);
  const records = git(root, "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`)
    .split("\x1e").map((record) => record.trim()).filter(Boolean);
  const merged = [];
  for (const record of records.reverse()) {
    const [hash, subject, ...bodyParts] = record.split("\x1f");
    const pr = pullRequest({ hash, subject, body: bodyParts.join("\x1f").trim() });
    if (!pr) continue;
    let files = [];
    try {
      files = git(root, "diff", "--name-only", `${hash}^1`, hash).split("\n").filter(Boolean);
    } catch {
      files = [];
    }
    merged.push({ ...pr, files });
  }
  return merged;
}

/// One `<notesDir>/*.json`. `pullRequest` is optional: without it the file
/// belongs to the PR that added it, which is the normal case. With it, the items
/// can be attributed to an already-merged PR whose own diff may not have carried
/// them -- how a missing note is filled in after the fact.
function parseDeclaration(content, path) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!Array.isArray(parsed.items)) throw new Error(`${path} must contain an items array`);
  const items = [];
  for (const item of parsed.items) {
    if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(item.key ?? "") || !String(item.title ?? "").trim()) {
      throw new Error(`${path} contains an invalid item`);
    }
    items.push({ key: item.key, title: item.title.trim() });
  }
  return { pullRequest: Number.isInteger(parsed.pullRequest) ? parsed.pullRequest : null, items };
}

/// The items declared for each PR, keyed by PR number. A declaration with an
/// empty `items` array still gets an entry: it is how a PR says "this is
/// internal, do not show it", which is different from saying nothing.
function declarationsInRange({ root, from, to, merged, client }) {
  const byPullRequest = new Map();
  let paths = [];
  try {
    paths = git(root, "diff", "--name-only", from, to, "--", client.notesDir)
      .split("\n").filter((path) => path.endsWith(".json"));
  } catch {
    paths = [];
  }
  for (const path of paths) {
    let content;
    try {
      content = git(root, "show", `${to}:${path}`);
    } catch {
      continue; // deleted within the range
    }
    const declaration = parseDeclaration(content, path);
    const owner = declaration.pullRequest ?? merged.find((entry) => entry.files.includes(path))?.pullRequestNumber;
    if (owner === undefined || !merged.some((entry) => entry.pullRequestNumber === owner)) continue;
    const items = byPullRequest.get(owner) ?? [];
    for (const item of declaration.items) {
      if (!items.some((existing) => existing.key === item.key)) items.push(item);
    }
    byPullRequest.set(owner, items);
  }
  return byPullRequest;
}

/// The notes published to clients: only PRs that declare themselves, in the
/// Chinese titles a person wrote. A PR with no declaration is silent -- never a
/// fallback English PR title.
function notesFrom(merged, declarations) {
  return merged
    .filter((entry) => (declarations.get(entry.pullRequestNumber)?.length ?? 0) > 0)
    .map((entry) => ({
      pullRequestNumber: entry.pullRequestNumber,
      title: entry.title,
      items: declarations.get(entry.pullRequestNumber),
    }));
}

/// Merged PRs that changed the client without declaring a note. A release that
/// leaves one of these unresolved would silently drop an update, so the
/// publisher adds the declaration (or an empty one to exclude it on purpose).
function undeclaredFrom(merged, declarations, client) {
  return merged
    .filter((entry) => touchesClient(entry.files, client) && !declarations.has(entry.pullRequestNumber))
    .map(({ pullRequestNumber, title }) => ({ pullRequestNumber, title }));
}

function collect({ root = repositoryRoot, from, to, client = clientConfig() }) {
  const merged = mergedPullRequests({ root, from, to });
  return { merged, declarations: declarationsInRange({ root, from, to, merged, client }) };
}

export function generateReleaseNotes({ root = repositoryRoot, from, to = "HEAD", client = clientConfig() }) {
  const { merged, declarations } = collect({ root, from, to, client });
  return notesFrom(merged, declarations);
}

export function undeclaredClientPullRequests({ root = repositoryRoot, from, to = "HEAD", client = clientConfig() }) {
  const { merged, declarations } = collect({ root, from, to, client });
  return undeclaredFrom(merged, declarations, client);
}

/**
 * The one entry point the publish scripts use. Refuses to print notes while a
 * client change in the range has no declaration: shipping one would publish an
 * update dialog that does not mention it.
 */
export function releaseNotesFor({ artifact, from, to } = {}) {
  const client = clientConfig(artifact);
  const { merged, declarations } = collect({ root: repositoryRoot, from, to, client });
  const undeclared = undeclaredFrom(merged, declarations, client);
  if (undeclared.length > 0) {
    const error = new Error(
      `These merged PRs changed the ${client.label} without a ${client.notesDir} declaration:`
      + undeclared.map(({ pullRequestNumber, title }) => `\n  PR #${pullRequestNumber} · ${title}`).join("")
      + `\nAdd ${client.notesDir}/*.json with Chinese item titles, or an empty items array to exclude one.`,
    );
    error.undeclared = undeclared;
    throw error;
  }
  return notesFrom(merged, declarations);
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const artifact = valueOf("--artifact") ?? DEFAULT_ARTIFACT;
  const ledger = JSON.parse(readFileSync(join(repositoryRoot, "released.json"), "utf8"));
  const from = valueOf("--from") ?? ledger.artifacts?.[artifact]?.commit;
  const to = valueOf("--to") ?? "HEAD";
  if (!from || !to) throw new Error("Usage: release-notes.mjs [--artifact macosApp|androidApp] [--from commit] [--to commit]");
  process.stdout.write(`${JSON.stringify(releaseNotesFor({ artifact, from, to }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error.message ?? error); process.exitCode = 1; }
}
