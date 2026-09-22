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

export function fallbackItems(text, title = text.trim()) {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]*-[1-9][0-9]*\b/g) ?? [])]
    .map((key) => ({ key, title }));
}

function releaseFiles(root, hash) {
  const parent = `${hash}^1`;
  let files = "";
  try {
    files = git(root, "diff", "--name-only", parent, hash, "--", "release-notes/macos");
  } catch {
    return [];
  }
  return files.split("\n").filter((path) => path.endsWith(".json"));
}

function itemsAt(root, hash, paths) {
  const items = [];
  for (const path of paths) {
    const parsed = JSON.parse(git(root, "show", `${hash}:${path}`));
    if (!Array.isArray(parsed.items)) throw new Error(`${path} must contain an items array`);
    for (const item of parsed.items) {
      if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(item.key ?? "") || !String(item.title ?? "").trim()) {
        throw new Error(`${path} contains an invalid item`);
      }
      items.push({ key: item.key, title: item.title.trim() });
    }
  }
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

export function generateReleaseNotes({ root = repositoryRoot, from, to = "HEAD" }) {
  if (![from, git(root, "rev-parse", to)].every((value) => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error("release note range must use full commit hashes");
  }
  const records = git(root, "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`)
    .split("\x1e").map((record) => record.trim()).filter(Boolean);
  const notes = [];
  for (const record of records.reverse()) {
    const [hash, subject, ...bodyParts] = record.split("\x1f");
    const commit = { hash, subject, body: bodyParts.join("\x1f").trim() };
    const pr = pullRequest(commit);
    if (!pr) continue;
    const declared = itemsAt(root, hash, releaseFiles(root, hash));
    notes.push({
      ...pr,
      items: declared.length ? declared : fallbackItems(`${pr.title}\n${commit.body}`, pr.title),
    });
  }
  return notes;
}

function main() {
  const args = process.argv.slice(2);
  const fromIndex = args.indexOf("--from");
  const toIndex = args.indexOf("--to");
  const ledger = JSON.parse(readFileSync(join(repositoryRoot, "released.json"), "utf8"));
  const from = fromIndex >= 0 ? args[fromIndex + 1] : ledger.artifacts?.macosApp?.commit;
  const to = toIndex >= 0 ? args[toIndex + 1] : "HEAD";
  if (!from || !to) throw new Error("Usage: macos-release-notes.mjs [--from commit] [--to commit]");
  process.stdout.write(`${JSON.stringify(generateReleaseNotes({ from, to }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
