// Shared by native clients and execution nodes. No network or model work happens
// in a lifecycle hook; a main conversation explicitly enters a development unit.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export const REVIEW_POLICY = Object.freeze({ version: 1, rounds: 3, confirmationsPerRound: 1, attemptsPerRound: 2, timeoutMs: 180_000, validationTimeoutMs: 600_000, maxFiles: 2000, maxBytes: 16 * 1024 * 1024 });
const sha = value => createHash("sha256").update(value).digest("hex");
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0 && value.length <= 16_000;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const terminal = new Set(["passed", "cancelled", "exhausted", "needs_decision", "unsupported"]);
export function inside(root, path) { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep)); }

function plainDirectory(path) {
  for (let p = resolve(path); p !== dirname(p); p = dirname(p)) {
    if (existsSync(p)) assert(lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink(), "Review state must not traverse a symlink");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function atomicReviewFile(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { maxBuffer: REVIEW_POLICY.maxBytes, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
const blockedFile = name => /(^|\/)(\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|credentials(?:\.[^/]*)?)$/i.test(name) && !name.endsWith(".env.example");

/** A consistent, bounded source snapshot. Untracked files are opt-in, not a
 * recursive home/credential scan. The digest includes deletions and modes. */
export function captureCandidate(repo, base, untracked = [], scope = []) {
  repo = realpathSync(repo);
  assert(/^[a-f0-9]{40}$/.test(base), "A frozen full base commit is required");
  git(repo, ["cat-file", "-e", base + "^{commit}"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  assert(Array.isArray(scope) && scope.every(name => nonempty(name) && !isAbsolute(name) && !name.split(/[\\/]/).includes("..")), "Unsafe candidate scope");
  const names = [...new Set([...git(repo, ["ls-tree", "-rz", "--name-only", base]).split("\0").filter(Boolean), ...git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean), ...untracked])]
    .filter(name => name === "AGENTS.md" || name === "docs/design-system.md" && scope.some(prefix => prefix.startsWith("apps/web/src") || /\.(?:css|tsx)$/.test(prefix)) || !scope.length || scope.some(prefix => name === prefix || name.startsWith(prefix.replace(/\/$/, "") + "/"))).toSorted();
  assert(names.length <= REVIEW_POLICY.maxFiles, "Candidate exceeds the file budget");
  let bytes = 0;
  const files = names.map(name => {
    assert(nonempty(name) && !name.includes("\0") && !name.split(/[\\/]/).some(p => p === ".." || p === ".git") && !isAbsolute(name), "Unsafe candidate path");
    assert(!blockedFile(name), "Candidate contains a credential-shaped file; define a narrower safe scope");
    const path = resolve(repo, name);
    assert(inside(repo, path), "Candidate escaped its repository");
    if (!existsSync(path)) return { name, deleted: true };
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && inside(repo, realpathSync(path)), "Candidate must contain regular source files only");
    bytes += stat.size; assert(bytes <= REVIEW_POLICY.maxBytes, "Candidate exceeds the byte budget");
    const data = readFileSync(path);
    return { name, mode: stat.mode & 0o777, sha256: sha(data), data: data.toString("base64") };
  });
  const diff = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--unified=5", base, "--", ...scope]);
  assert(Buffer.byteLength(diff) <= 256_000, "Diff exceeds the review context budget; do not truncate it");
  const changed = git(repo, ["diff", "--name-only", "-z", base, "--"]).split("\0").filter(Boolean);
  const uncovered = changed.filter(name => !files.some(file => file.name === name));
  const fingerprint = files.map(({ data: _data, ...file }) => file);
  return { repository: repo, base, head, files, diff, bytes, uncovered, digest: sha(JSON.stringify([base, scope, fingerprint])) };
}
export function stableCandidate(repo, base, untracked = [], scope = []) {
  const first = captureCandidate(repo, base, untracked, scope), second = captureCandidate(repo, base, untracked, scope);
  assert(first.digest === second.digest, "Candidate changed during capture; retry when writes have stopped");
  return second;
}
export function materializeCandidate(candidate, path) {
  assert(!existsSync(path), "Snapshot already exists; never overwrite another execution");
  plainDirectory(path);
  for (const file of candidate.files) {
    if (file.deleted) continue;
    const target = resolve(path, file.name); assert(inside(path, target), "Snapshot escaped its root");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const data = Buffer.from(file.data, "base64"); assert(sha(data) === file.sha256, "Snapshot content digest mismatch");
    writeFileSync(target, data, { flag: "wx", mode: file.mode & 0o111 ? 0o500 : 0o400 });
  }
  return path;
}

export function validateFindings(value, candidate) {
  assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => ["findings", "limitations"].includes(k)), "Invalid reviewer result");
  assert(Array.isArray(value.findings) && value.findings.length <= 50 && Array.isArray(value.limitations) && value.limitations.length <= 32, "Invalid reviewer result arrays");
  const ids = new Set();
  for (const f of value.findings) {
    assert(f && id(f.id) && !ids.has(f.id), "Finding identity must be unique"); ids.add(f.id);
    assert(["blocking", "advisory"].includes(f.severity) && [f.path, f.trigger, f.expected, f.actual, f.evidence, f.validation].every(nonempty), "A finding requires actionable evidence");
    assert(candidate.files.some(file => file.name === f.path), "Finding references a file outside the frozen candidate");
  }
  assert(value.limitations.every(item => nonempty(item) || item && ["blocking", "validation_pending", "informational"].includes(item.kind) && nonempty(item.detail)), "Invalid limitations");
  return structuredClone(value);
}

/** A unit is bound to a real request; new turns, retries and reconnects cannot
 * reset its round budget. Role results are written by the launcher, not passed
 * as an arbitrary 'approved' flag by a model or MCP caller. */
export class ReviewStore {
  constructor(root) { assert(isAbsolute(root), "Review state root must be absolute"); plainDirectory(root); const stat = lstatSync(root); assert((stat.mode & 0o077) === 0 && (process.getuid?.() === undefined || stat.uid === process.getuid()), "Review state directory must be private and owned by this user"); this.root = root; }
  path(taskId) { assert(id(taskId), "Invalid task identity"); return join(this.root, taskId + ".json"); }
  read(taskId) {
    const path = this.path(taskId); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (process.getuid?.() === undefined || stat.uid === process.getuid()), "Invalid review record");
    const state = JSON.parse(readFileSync(path, "utf8")); assert(state.version === 1 && state.taskId === taskId, "Review record version or identity mismatch"); return state;
  }
  transaction(taskId, work) {
    const lock = this.path(taskId) + ".lock";
    const fd = openSync(lock, "wx", 0o600);
    try { const value = work(); if (value) atomicReviewFile(this.path(taskId), value); return value; }
    finally { closeSync(fd); unlinkSync(lock); }
  }
  begin(input) {
    assert(id(input.taskId) && nonempty(input.sessionRef) && nonempty(input.requestId) && /^[a-f0-9]{64}$/.test(input.scopeDigest), "A task requires its original request and scope");
    assert(["codex", "claude_code", "opencode"].includes(input.agentKind) && nonempty(input.model) && nonempty(input.provider), "Actual agent/model/provider identity is required");
    assert(Array.isArray(input.requiredChecks) && input.requiredChecks.length > 0 && input.requiredChecks.length <= 32 && input.requiredChecks.every(nonempty), "Define the required validation checks");
    const binding = { taskId: input.taskId, agentKind: input.agentKind, sessionRef: input.sessionRef, requestId: input.requestId, scopeDigest: input.scopeDigest,
      repository: realpathSync(input.repository), repositoryUrl: input.repositoryUrl ?? null, base: input.base, model: input.model, provider: input.provider, effort: input.effort ?? null, requiredChecks: [...new Set(input.requiredChecks)],
      scope: input.scope ?? [], untracked: input.untracked ?? [], requirements: input.requirements ?? "", checkCommands: input.checkCommands ?? [] };
    assert(/^[a-f0-9]{40}$/.test(binding.base), "Freeze a full base commit");
    return this.transaction(input.taskId, () => {
      if (existsSync(this.path(input.taskId))) { const old = this.read(input.taskId); assert(JSON.stringify(old.binding) === JSON.stringify(binding), "Task scope changed; do not reuse its identity"); return old; }
      return { version: 1, policyVersion: REVIEW_POLICY.version, taskId: input.taskId, binding, revision: 1, status: "developing", generation: 1, rounds: [], events: [{ revision: 1, type: "began", at: new Date().toISOString() }] };
    });
  }
  update(taskId, revision, type, work) {
    return this.transaction(taskId, () => {
      const state = this.read(taskId); assert(state.revision === revision, "Review record changed; read the original task again");
      work(state); state.revision++; state.events.push({ revision: state.revision, type, at: new Date().toISOString() }); return state;
    });
  }
  start(taskId, revision, candidate, confirmation = false, snapshot) {
    return this.update(taskId, revision, confirmation ? "confirmation_started" : "review_started", state => {
      assert(!terminal.has(state.status) && state.status !== "reviewing", "Task cannot start another reviewer");
      assert(candidate.repository === state.binding.repository && candidate.base === state.binding.base, "Candidate scope mismatch");
      state.generation++;
      const previous = state.rounds.at(-1);
      if (confirmation) {
        assert(previous?.status === "needs_fix" && !previous.confirmation, "A round permits only one focused confirmation");
        previous.confirmation = { candidateDigest: candidate.digest, state: "running", ...(snapshot ? { snapshot } : {}) };
      } else {
        assert(state.rounds.length < REVIEW_POLICY.rounds, "Three-round budget exhausted");
        assert(previous?.status !== "unknown", "Uncertain reviewer must be reconciled, never replaced");
        state.rounds.push({ number: state.rounds.length + 1, candidateDigest: candidate.digest, status: "running", generation: state.generation, ...(snapshot ? { snapshot } : {}) });
      }
      delete state.reason; delete state.proof; state.checks = [];
      state.status = "reviewing"; state.candidateDigest = candidate.digest; state.candidateHead = candidate.head;
    });
  }
  bind(taskId, revision, generation, nativeRef, confirmation = false) {
    return this.update(taskId, revision, "reviewer_bound", state => {
      assert(state.status === "reviewing" && state.generation === generation && nonempty(nativeRef), "Reviewer binding is no longer current");
      const round = state.rounds.at(-1); const target = confirmation ? round.confirmation : round;
      assert(!target.nativeRef || target.nativeRef === nativeRef, "Never replace an uncertain native reviewer"); target.nativeRef = nativeRef;
    });
  }
  receipt(taskId, revision, candidate, receipt, result, confirmation = false) {
    const findings = validateFindings(result, candidate);
    return this.update(taskId, revision, "review_received", state => {
      assert(state.status === "reviewing" && candidate.digest === state.candidateDigest, "Review result no longer matches current execution");
      assert(receipt && nonempty(receipt.sessionRef) && receipt.model === state.binding.model && receipt.provider === state.binding.provider && receipt.readOnly === true && receipt.generation === state.generation, "Reviewer identity or permission evidence is incomplete");
      const round = state.rounds.at(-1); const target = confirmation ? round.confirmation : round;
      assert(target?.candidateDigest === candidate.digest && (target.state === "running" || target.status === "running"), "Late or duplicate review result");
      assert(!target.nativeRef || target.nativeRef === receipt.sessionRef, "Reviewer receipt belongs to another native execution");
      Object.assign(target, { nativeRef: receipt.sessionRef, receipt, result: findings, state: "completed" });
      const unresolved = findings.findings.some(f => f.severity === "blocking") || findings.limitations.some(item => typeof item === "string" || item.kind === "blocking");
      round.status = unresolved ? "needs_fix" : "reviewed";
      state.status = unresolved && state.rounds.length === REVIEW_POLICY.rounds && confirmation ? "exhausted" : unresolved ? "repairing" : "validating";
    });
  }
  fail(taskId, revision, reason) {
    return this.update(taskId, revision, "review_incomplete", state => {
      assert(!terminal.has(state.status) && nonempty(reason), "Cannot fail a completed task");
      state.status = "incomplete"; state.reason = reason;
      if (state.rounds.at(-1)?.status === "running" || state.rounds.at(-1)?.confirmation?.state === "running") state.rounds.at(-1).status = "unknown";
    });
  }
  validate(taskId, revision, candidate, checks) {
    return this.update(taskId, revision, "validation_recorded", state => {
      assert(state.status === "validating" && state.candidateDigest === candidate.digest, "Validation requires a reviewed current candidate");
      assert(Array.isArray(checks) && checks.length <= 32 && checks.every(c => state.binding.requiredChecks.includes(c.name) && ["passed", "failed", "not_run"].includes(c.result) && nonempty(c.method) && nonempty(c.evidence)), "Invalid validation evidence");
      assert(new Set(checks.map(c => c.name)).size === checks.length, "Duplicate validation check");
      state.checks = checks; state.candidateHead = candidate.head;
      state.status = state.binding.requiredChecks.every(name => checks.some(c => c.name === name && c.result === "passed")) ? "passed" : "incomplete";
    });
  }
  cancel(taskId, revision) {
    return this.update(taskId, revision, "cancelled", state => { assert(state.status !== "passed", "Do not rewrite completed review history"); state.generation++; state.status = "cancelled"; });
  }
}

export function reviewGuidance(command = "missiongo-review") {
  return `研发交付审查 v${REVIEW_POLICY.version}：仅对用户明确授权的研发任务执行。研发完成、最终交付前调用 ${command}，按原请求及授权范围建立稳定任务并冻结实际代码；使用当前同类 Agent 的独立只读 reviewer，原会话核实问题、在已有授权内自动补修并执行必要验证。无有效问题可提前结束，最多三轮，每轮至多一次定向复核；计数不因重连、压缩、换入口或补修重置。讨论、查询、等待批准和用户停止不触发。普通问题最终统一报告，新增产品取舍、范围或权限才询问用户。缺少工具、身份、模型、权限或验证证据时如实报告审查未完成，不冒充通过、不改变主会话模型/权限、不自动合并发布；不通过 Stop 或伪造用户消息自动续办。`;
}
