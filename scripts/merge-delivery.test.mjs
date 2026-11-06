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
  if (command === "git" && args[0] === "ls-remote") return `${pr.baseRefOid}\trefs/heads/main`;
  assert.equal(command, "gh");
  return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" } : p);
};
test("evidence fails closed on unknown checks, conflict, draft, and changed head", () => {
  assert.equal(inspectDelivery(delivery, mock()).ready, true);
  assert.equal(inspectDelivery({ ...delivery, mergeReady: false }, mock()).ready, false);
  assert.throws(() => inspectDelivery({ ...delivery, expectedBase: "c".repeat(40) }, mock()), /base/i);
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
    const target = git("rev-parse", "HEAD");
    const inspect = (index, commit) => inspectDelivery({ ...delivery, head: heads[index] }, (command, args) => {
      if (command === "gh") return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "example/project" }
        : { ...pr, headRefOid: heads[index], state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: commit } });
      // Substitute only transport: ancestry check still runs against a real repository.
      if (args[0] === "ls-remote") return `${target}\trefs/heads/main`;
      if (args[0] === "fetch") return git("fetch", dir, "main");
      return git(...args);
    });
    for (let i = 0; i < 2; i++) assert.equal(inspect(i, commits[i]).result.commit, commits[i]);
    assert.throws(() => inspect(2, heads[2]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test("rejects stale PR base even when expectedBase matches it", () => {
   const run = (command, args) => command === "git" ? `${"c".repeat(40)}\trefs/heads/main` : mock()(command, args);
   assert.throws(() => inspectDelivery({...delivery, expectedBase: pr.baseRefOid}, run), /actual target/);
 });

test("external reconciliation proves original-head and target ancestry using real Git", async () => {
  const { inspectMergedReconciliation } = await import("./merge-delivery.mjs");
  const dir = mkdtempSync(join(tmpdir(), "missiongo-reconcile-fixture-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");git("config", "user.name", "Fixture");git("config", "user.email", "fixture@example.test");
    writeFileSync(join(dir, "base"), "base");git("add", ".");git("commit", "-m", "base");
    git("checkout", "-b", "feature");writeFileSync(join(dir, "feature"), "original");git("add", ".");git("commit", "-m", "original");const original = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "feature"), "external repair");git("commit", "-am", "external repair");const head = git("rev-parse", "HEAD");
    git("checkout", "main");git("merge", "--no-ff", "feature", "-m", "merge");const target = git("rev-parse", "HEAD");
    const run = (command, args) => {
      if (command === "gh") return JSON.stringify(args[0] === "repo" ? {nameWithOwner:"example/project"} : {...pr, state:"MERGED", headRefOid:head, mergeCommit:{oid:target}, mergedAt:new Date().toISOString()});
      if (args[0] === "ls-remote") return git("ls-remote", "--refs", dir, "refs/heads/main");
      if (args[0] === "fetch") return git("fetch", dir, args[2].startsWith("refs/pull/") ? "feature" : "main");
      return git(...args);
    };
    const input = {...delivery, head:original, validation:"Local checks passed on actual target"};
    const evidence = inspectMergedReconciliation(input, run);
    assert.deepEqual(evidence, {
      head, commit:target, targetHead:target, source:pr.url, checkedAt:evidence.checkedAt,
      checks:"passed", local:"passed", originalIncluded:true, targetIncludesMerge:true, validation:input.validation,
    });
    // A target-only commit was never part of the merged feature.
    assert.throws(() => inspectMergedReconciliation({...input,head:target},run));
    assert.throws(() => inspectMergedReconciliation({...input,validation:""},run));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
