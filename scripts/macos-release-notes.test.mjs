import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fallbackItems, generateReleaseNotes, pullRequest } from "./macos-release-notes.mjs";

test("recognizes merge and squash pull request subjects", () => {
  assert.deepEqual(pullRequest({ subject: "Merge pull request #94 from owner/topic", body: "AND-122 Better UX" }), {
    pullRequestNumber: 94, title: "AND-122 Better UX",
  });
  assert.equal(pullRequest({ subject: "AND-136 Grow input (#95)", body: "" })?.pullRequestNumber, 95);
  assert.equal(pullRequest({ subject: "local commit", body: "" }), null);
});

test("extracts unique fallback item keys", () => {
  assert.deepEqual(fallbackItems("AND-1 and AND-2, then AND-1"), [
    { key: "AND-1", title: "AND-1 and AND-2, then AND-1" },
    { key: "AND-2", title: "AND-1 and AND-2, then AND-1" },
  ]);
});

test("collects structured item titles from each merged PR", () => {
  const root = mkdtempSync(join(tmpdir(), "missiongo-release-notes-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "README.md"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const from = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    mkdirSync(join(root, "release-notes/macos"), { recursive: true });
    writeFileSync(join(root, "release-notes/macos/batch.json"), JSON.stringify({
      items: [{ key: "AND-136", title: "输入框按内容自动扩展" }],
    }));
    git("add", ".");
    git("commit", "-qm", "AND-136 implementation");
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-q", "-m", "Merge pull request #95 from owner/feature", "-m", "AND-136 implementation", "feature");
    const notes = generateReleaseNotes({ root, from, to: "HEAD" });
    assert.deepEqual(notes, [{
      pullRequestNumber: 95,
      title: "AND-136 implementation",
      items: [{ key: "AND-136", title: "输入框按内容自动扩展" }],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
