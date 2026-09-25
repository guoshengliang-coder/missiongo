import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { generateReleaseNotes, pullRequest, undeclaredClientPullRequests } from "./macos-release-notes.mjs";

test("recognizes merge and squash pull request subjects", () => {
  assert.deepEqual(pullRequest({ subject: "Merge pull request #94 from owner/topic", body: "AND-122 Better UX" }), {
    pullRequestNumber: 94, title: "AND-122 Better UX",
  });
  assert.equal(pullRequest({ subject: "AND-136 Grow input (#95)", body: "" })?.pullRequestNumber, 95);
  assert.equal(pullRequest({ subject: "local commit", body: "" }), null);
});

/// A scratch repository whose "base" commit is the point releases start from.
function repository() {
  const root = mkdtempSync(join(tmpdir(), "missiongo-release-notes-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(root, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { root, git, from: git("rev-parse", "HEAD") };
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function mergePullRequest(root, git, number, title, files) {
  const branch = `topic-${number}`;
  git("checkout", "-qb", branch);
  write(root, files);
  git("add", ".");
  git("commit", "-qm", `${title} (#${number})`);
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-q", "-m", `Merge pull request #${number} from owner/${branch}`, "-m", title, branch);
}

test("publishes only declared PRs, in the Chinese titles a person wrote", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 95, "AND-136 Grow input", {
      "release-notes/macos/batch.json": JSON.stringify({ items: [{ key: "AND-136", title: "输入框按内容自动扩展" }] }),
      "apps/macos/Sources/Foo.swift": "// client change\n",
    });
    assert.deepEqual(generateReleaseNotes({ root, from, to: "HEAD" }), [{
      pullRequestNumber: 95,
      title: "AND-136 Grow input",
      items: [{ key: "AND-136", title: "输入框按内容自动扩展" }],
    }]);
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a client change with no declaration publishes nothing and is reported", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 96, "AND-181 Snapshot upload", {
      "apps/macos/Sources/MissionGoNodeCore/APIClient.swift": "// client change\n",
    });
    assert.deepEqual(generateReleaseNotes({ root, from, to: "HEAD" }), []);
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), [
      { pullRequestNumber: 96, title: "AND-181 Snapshot upload" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty declaration excludes a PR from both the notes and the check", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 97, "internal client refactor", {
      "release-notes/macos/internal.json": JSON.stringify({ items: [] }),
      "apps/macos/Sources/Internal.swift": "// internal\n",
    });
    assert.deepEqual(generateReleaseNotes({ root, from, to: "HEAD" }), []);
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing declaration can be filled in after the PR merged", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 96, "AND-181 Snapshot upload", {
      "apps/macos/Sources/MissionGoNodeCore/APIClient.swift": "// client change\n",
    });
    // A later branch adds the note and names the PR it belongs to, because the
    // original PR's diff cannot carry it any more.
    write(root, {
      "release-notes/macos/and-181.json": JSON.stringify({
        pullRequest: 96,
        items: [{ key: "AND-181", title: "超大快照仍能上传，节点同步不再卡住" }],
      }),
    });
    git("add", ".");
    git("commit", "-qm", "Add the missing AND-181 release note");
    assert.deepEqual(generateReleaseNotes({ root, from, to: "HEAD" }), [{
      pullRequestNumber: 96,
      title: "AND-181 Snapshot upload",
      items: [{ key: "AND-181", title: "超大快照仍能上传，节点同步不再卡住" }],
    }]);
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version-only release commit needs no declaration", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 98, "Release macOS 0.4.24", {
      "apps/macos/version.properties": "missiongoMacosVersion=0.4.24\n",
    });
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PR that touches nothing under apps/macos is not a missed client update", () => {
  const { root, git, from } = repository();
  try {
    mergePullRequest(root, git, 99, "AND-180 server only", {
      "services/server/src/app.ts": "// server change\n",
    });
    assert.deepEqual(undeclaredClientPullRequests({ root, from, to: "HEAD" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
