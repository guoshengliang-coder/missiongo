import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewStore, stableCandidate, materializeCandidate, reviewGuidance } from "../apps/web/public/downloads/missiongo-agent-integration/review-workflow.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "missiongo-review-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]); writeFileSync(join(root, "code.js"), "export const count = 1;\n"); git(["add", "code.js"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
  const base = git(["rev-parse", "HEAD"]);
  const store = new ReviewStore(join(root, "state"));
  const input = { taskId: "task-1", sessionRef: "native-session-1", requestId: "human-message-1", scopeDigest: "a".repeat(64), agentKind: "codex", repository: root, base, model: "fixture-model", provider: "fixture-provider", requiredChecks: ["behavior"] };
  const candidate = () => stableCandidate(root, base);
  const receipt = state => ({ sessionRef: "reviewer-" + state.rounds.length, model: input.model, provider: input.provider, readOnly: true, generation: state.generation });
  const good = { findings: [], limitations: [] };
  const bad = { findings: [{ id: "F1", severity: "blocking", path: "code.js", trigger: "empty input", expected: "zero", actual: "throws", evidence: "missing guard", validation: "empty-input test" }], limitations: [] };
  return { root, store, input, candidate, receipt, good, bad };
}

test("one clean independent review can pass only with required validation on that exact candidate", t => {
  const f = fixture(t); let s = f.store.begin(f.input); const c = f.candidate();
  s = f.store.start(s.taskId, s.revision, c); s = f.store.receipt(s.taskId, s.revision, c, f.receipt(s), f.good);
  assert.equal(s.status, "validating");
  assert.throws(() => f.store.validate(s.taskId, s.revision, { ...c, digest: "changed" }, []), /current candidate/);
  s = f.store.validate(s.taskId, s.revision, c, [{ name: "behavior", result: "passed", method: "node test", evidence: "exit 0; expected behavior observed" }]);
  assert.equal(s.status, "passed"); assert.equal(s.rounds.length, 1);
  assert.throws(() => f.store.start(s.taskId, s.revision, c), /cannot start/);
});

test("three rounds include at most one confirmation each; unresolved third-round repairs never become success", t => {
  const f = fixture(t); let s = f.store.begin(f.input);
  for (let round = 1; round <= 3; round++) {
    let c = f.candidate(); s = f.store.start(s.taskId, s.revision, c);
    s = f.store.receipt(s.taskId, s.revision, c, f.receipt(s), f.bad);
    writeFileSync(join(f.root, "code.js"), `export const count = ${round + 1};\n`); c = f.candidate();
    s = f.store.start(s.taskId, s.revision, c, true);
    s = f.store.receipt(s.taskId, s.revision, c, f.receipt(s), f.bad, true);
    assert.throws(() => f.store.start(s.taskId, s.revision, c, true));
  }
  assert.equal(s.status, "exhausted"); assert.equal(s.rounds.length, 3);
  assert.throws(() => f.store.start(s.taskId, s.revision, f.candidate()));
  assert.equal(f.store.begin(f.input).rounds.length, 3);
});

test("scope changes and duplicate or late results cannot reset or overwrite review history", t => {
  const f = fixture(t); let s = f.store.begin(f.input); const c = f.candidate();
  assert.throws(() => f.store.begin({ ...f.input, requestId: "different-human-message" }), /scope changed/);
  s = f.store.start(s.taskId, s.revision, c); const oldRevision = s.revision; const oldReceipt = f.receipt(s);
  s = f.store.cancel(s.taskId, s.revision);
  assert.throws(() => f.store.receipt(s.taskId, oldRevision, c, oldReceipt, f.good), /changed/);
  assert.throws(() => f.store.receipt(s.taskId, s.revision, c, oldReceipt, f.good), /no longer matches/);
  assert.equal(f.store.read(s.taskId).status, "cancelled");
});

test("an uncertain reviewer is preserved across restart and cannot be replaced by a duplicate", t => {
  const f = fixture(t); let s = f.store.begin(f.input); const c = f.candidate();
  s = f.store.start(s.taskId, s.revision, c); s = f.store.fail(s.taskId, s.revision, "connection lost after native launch");
  const reopened = new ReviewStore(join(f.root, "state"));
  assert.equal(reopened.read(s.taskId).rounds[0].status, "unknown");
  assert.throws(() => reopened.start(s.taskId, s.revision, c), /Uncertain/);
});

test("an interrupted focused confirmation also preserves its unknown native execution", t => {
  const f=fixture(t);let s=f.store.begin(f.input);const c=f.candidate();
  s=f.store.start(s.taskId,s.revision,c);s=f.store.receipt(s.taskId,s.revision,c,f.receipt(s),f.bad);
  s=f.store.start(s.taskId,s.revision,c,true);s=f.store.fail(s.taskId,s.revision,"Confirmation response lost");
  assert.equal(s.rounds[0].status,"unknown");
  assert.throws(()=>f.store.start(s.taskId,s.revision,c),/Uncertain/);
  assert.throws(()=>f.store.start(s.taskId,s.revision,c,true),/only one/);
});

test("unsupported model, permission, scope and limited review evidence cannot pass", t => {
  const f = fixture(t); let s = f.store.begin(f.input); const c = f.candidate(); s = f.store.start(s.taskId, s.revision, c);
  for (const receipt of [{ ...f.receipt(s), model: "fallback" }, { ...f.receipt(s), readOnly: false }]) {
    assert.throws(() => f.store.receipt(s.taskId, s.revision, c, receipt, f.good), /identity or permission/);
  }
  assert.throws(() => f.store.receipt(s.taskId, s.revision, c, f.receipt(s), { ...f.bad, findings: [{ ...f.bad.findings[0], path: "../outside.js" }] }), /outside/);
  s = f.store.receipt(s.taskId, s.revision, c, f.receipt(s), { findings: [], limitations: ["acceptance criterion could not be checked"] });
  assert.equal(s.status, "repairing");
  assert.throws(() => f.store.validate(s.taskId, s.revision, c, []), /reviewed current/);
});

test("frozen source includes staged, unstaged, explicitly selected untracked and deletions without changing the checkout", t => {
  const f = fixture(t); const before = f.candidate();
  writeFileSync(join(f.root, "code.js"), "export const count = 2;\n");
  writeFileSync(join(f.root, "new.js"), "export const newFeature = true;\n");
  const c = stableCandidate(f.root, f.input.base, ["new.js"]);
  assert.notEqual(c.digest, before.digest); assert.equal(c.files.length, 2);
  const snapshot = join(f.root, "snapshot"); materializeCandidate(c, snapshot);
  assert.match(readFileSync(join(snapshot, "new.js"), "utf8"), /newFeature/);
  assert.match(readFileSync(join(f.root, "code.js"), "utf8"), /count = 2/);
  assert.throws(() => materializeCandidate(c, snapshot), /already exists/);
  rmSync(join(f.root, "code.js")); assert.equal(f.candidate().files[0].deleted, true);
});

test("credential files, traversal and symlink escapes are rejected before snapshot publication", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, ".env"), "SYNTHETIC=not-a-real-secret");
  assert.throws(() => stableCandidate(f.root, f.input.base, [".env"]), /credential/);
  assert.throws(() => stableCandidate(f.root, f.input.base, ["../outside"]), /Unsafe/);
  symlinkSync(join(f.root, ".env"), join(f.root, "link.js"));
  assert.throws(() => stableCandidate(f.root, f.input.base, ["link.js"]), /regular source files/);
});

test("shared guidance forbids synthetic human continuation, permission changes and review on ordinary discussion", () => {
  const text = reviewGuidance(); assert.match(text, /最多三轮/); assert.match(text, /原会话/);
  assert.match(text, /讨论、查询、等待批准和用户停止不触发/); assert.match(text, /不通过 Stop 或伪造用户消息自动续办/);
});
