import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDelivery } from "./merge-delivery.mjs";

const delivery = { repository: "https://github.com/example/project", pullRequest: 12, head: "a".repeat(40), targetBranch: "main" };
const pr = { url: `${delivery.repository}/pull/12`, headRefOid: delivery.head, baseRefName: "main", baseRefOid: "b".repeat(40),
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] };
const mock = (p = pr) => (command, args) => {
  assert.equal(command, "gh");
  return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" } : p);
};
test("evidence fails closed on unknown checks, conflict, draft, and changed head", () => {
  assert.equal(inspectDelivery(delivery, mock()).ready, true);
  for (const change of [{ statusCheckRollup: [] }, { isDraft: true }, { mergeable: "CONFLICTING" },
    { statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }]) {
    assert.equal(inspectDelivery(delivery, mock({ ...pr, ...change })).ready, false);
  }
  assert.throws(() => inspectDelivery(delivery, mock({ ...pr, headRefOid: "c".repeat(40) })), /revision changed/);
  assert.deepEqual(inspectDelivery(delivery, mock()).mergeArguments.slice(-2), ["--match-head-commit", delivery.head]);
});

test("verifies two actual isolated branch integrations and rejects an unintegrated commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "missiongo-merge-fixture-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main"); git("config", "user.name", "Synthetic fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(dir, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const heads = [];
    for (const name of ["one", "two", "unfinished"]) {
      git("checkout", "-b", name, base); writeFileSync(join(dir, `${name}.txt`), name); git("add", "."); git("commit", "-m", name);
      heads.push(git("rev-parse", "HEAD"));
    }
    git("checkout", "main");
    const commits = [];
    for (const name of ["one", "two"]) { git("merge", "--no-ff", name, "-m", `Integrate ${name}`); commits.push(git("rev-parse", "HEAD")); }
    const inspect = (index, commit) => inspectDelivery({ ...delivery, head: heads[index] }, (command, args) => {
      if (command === "gh") return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" }
        : { ...pr, headRefOid: heads[index], state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: commit } });
      // Substitute only transport: ancestry check still runs against a real repository.
      if (args[0] === "fetch") return git("fetch", dir, "main");
      return git(...args);
    });
    for (let i = 0; i < 2; i++) assert.equal(inspect(i, commits[i]).result.commit, commits[i]);
    assert.throws(() => inspect(2, heads[2]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
