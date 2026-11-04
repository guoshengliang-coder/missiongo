#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLIENTS, parseDeclaration } from "./release-notes.mjs";

export function isReleaseMetadata(path) {
  return path === "released.json" || /^release-notes\/(android|macos)\/[\w-]+\.json$/.test(path);
}

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (root, path) => {
  if (!lstatSync(join(root, path)).isFile()) throw new Error(`${path} must be a regular file`);
  return readFileSync(join(root, path), "utf8");
};
const configuration = ({ version: _version, commit: _commit, sha256: _sha256, ...rest }) => rest;

// Only publication facts can take the fast path. Changing artifact paths,
// version sources or the artifact inventory still requires full runtime checks.
export function validateReleaseMetadata({ root, base, changes }) {
  let safe = true;
  for (const { path, status } of changes.filter(change => isReleaseMetadata(change.path))) {
    if (!["A", "M"].includes(status)) { safe = false; continue; }
    if (path !== "released.json") {
      const client = path.startsWith("release-notes/macos/") ? CLIENTS.macosApp : CLIENTS.androidApp;
      const source = read(root, path);
      const note = JSON.parse(source);
      if (note.pullRequest !== undefined && (!Number.isSafeInteger(note.pullRequest) || note.pullRequest < 1)) {
        throw new Error(`${path} has an invalid pullRequest`);
      }
      parseDeclaration(source, path, client);
      continue;
    }
    const before = JSON.parse(git(root, "show", `${base}:released.json`));
    const after = JSON.parse(read(root, path));
    if (!after.artifacts || typeof after.artifacts !== "object" || Array.isArray(after.artifacts)) throw new Error("Invalid release ledger");
    const { artifacts: oldArtifacts, $comment: _oldComment, ...oldExtra } = before;
    const { artifacts: newArtifacts, $comment: _newComment, ...newExtra } = after;
    if (!isDeepStrictEqual(oldExtra, newExtra)
      || !isDeepStrictEqual(Object.keys(oldArtifacts).sort(), Object.keys(newArtifacts).sort())) safe = false;
    for (const [name, record] of Object.entries(newArtifacts)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${name}: invalid publication record`);
      const previous = oldArtifacts[name];
      if (!previous || !isDeepStrictEqual(configuration(previous), configuration(record))) { safe = false; continue; }
      if (isDeepStrictEqual(previous, record)) continue;
      if (record.version === null && record.commit === null && previous.version === null && previous.commit === null) continue;
      if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)
        || typeof record.commit !== "string" || !/^[0-9a-f]{40}$/.test(record.commit)) throw new Error(`${name}: invalid version or source commit`);
      if (record.sha256 !== undefined && (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256))) throw new Error(`${name}: invalid sha256`);
      git(root, "merge-base", "--is-ancestor", record.commit, "HEAD");
      const source = read(root, record.versionFile);
      const version = record.versionJsonPath
        ? record.versionJsonPath.split(".").reduce((value, key) => value?.[key], JSON.parse(source))
        : new RegExp(`^${record.versionProperty}=(.+)$`, "m").exec(source)?.[1]?.trim();
      if (version !== record.version) throw new Error(`${name}: ledger version differs from its declaration`);
    }
  }
  return safe;
}
