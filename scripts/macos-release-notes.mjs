#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/// The version bump a release PR makes is not a macOS update a person would
/// read, so it needs no declaration. Anything else under apps/macos is a change
/// to the client itself and does.
const VERSION_ONLY_PATH = "apps/macos/version.properties";

function touchesClient(files) {
  return files.some((path) => path.startsWith("apps/macos/") && path !== VERSION_ONLY_PATH);
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

/// One `release-notes/macos/*.json`. `pullRequest` is optional: without it the
/// file belongs to the PR that added it, which is the normal case. With it, the
/// items can be attributed to an already-merged PR whose own diff may not have
/// carried them -- how a missing note is filled in after the fact.
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
function declarationsInRange({ root, from, to, merged }) {
  const byPullRequest = new Map();
  let paths = [];
  try {
    paths = git(root, "diff", "--name-only", from, to, "--", "release-notes/macos")
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

/// Merged PRs that changed the macOS client without declaring a note. A release
/// that leaves one of these unresolved would silently drop an update, so the
/// publisher adds the declaration (or an empty one to exclude it on purpose).
function undeclaredFrom(merged, declarations) {
  return merged
    .filter((entry) => touchesClient(entry.files) && !declarations.has(entry.pullRequestNumber))
    .map(({ pullRequestNumber, title }) => ({ pullRequestNumber, title }));
}

function collect({ root = repositoryRoot, from, to }) {
  const merged = mergedPullRequests({ root, from, to });
  return { merged, declarations: declarationsInRange({ root, from, to, merged }) };
}

export function generateReleaseNotes({ root = repositoryRoot, from, to = "HEAD" }) {
  const { merged, declarations } = collect({ root, from, to });
  return notesFrom(merged, declarations);
}

export function undeclaredClientPullRequests({ root = repositoryRoot, from, to = "HEAD" }) {
  const { merged, declarations } = collect({ root, from, to });
  return undeclaredFrom(merged, declarations);
}

function main() {
  const args = process.argv.slice(2);
  const fromIndex = args.indexOf("--from");
  const toIndex = args.indexOf("--to");
  const ledger = JSON.parse(readFileSync(join(repositoryRoot, "released.json"), "utf8"));
  const from = fromIndex >= 0 ? args[fromIndex + 1] : ledger.artifacts?.macosApp?.commit;
  const to = toIndex >= 0 ? args[toIndex + 1] : "HEAD";
  if (!from || !to) throw new Error("Usage: macos-release-notes.mjs [--from commit] [--to commit]");

  const { merged, declarations } = collect({ root: repositoryRoot, from, to });
  const undeclared = undeclaredFrom(merged, declarations);
  if (undeclared.length > 0) {
    console.error("These merged PRs changed the macOS client without a release-notes/macos declaration:");
    for (const { pullRequestNumber, title } of undeclared) {
      console.error(`  PR #${pullRequestNumber} · ${title}`);
    }
    console.error("Add release-notes/macos/*.json with Chinese item titles, or an empty items array to exclude one.");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(notesFrom(merged, declarations))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
