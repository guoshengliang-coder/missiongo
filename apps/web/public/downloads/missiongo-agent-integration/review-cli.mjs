#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_POLICY, ReviewStore, materializeCandidate, reviewGuidance, stableCandidate } from "./review-workflow.mjs";
import { independentReview, reviewerPrompt } from "./review-native.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
export function defaultReviewRoot() { return join(realpathSync(homedir()), ".local/state/missiongo-review"); }
function repositoryId(repo) { return realpathSync(execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
export function enabledReview(repo, root = defaultReviewRoot()) {
  try {
    const config = JSON.parse(readFileSync(join(root, "enabled.json"), "utf8"));
    return config.version === 1 && config.repositories?.some(entry => entry.identity === repositoryId(repo));
  } catch { return false; }
}
export function nativeReviewContext(repo, root = defaultReviewRoot(), identity) {
  if (!enabledReview(repo, root)) return "";
  if (identity && ["codex", "claude_code", "opencode"].includes(identity.agentKind) && typeof identity.sessionRef === "string" && identity.sessionRef.length > 0 && identity.sessionRef.length <= 200) {
    const store = new ReviewStore(root);
    store.transaction("policy-" + digest(identity.agentKind + ":" + identity.sessionRef), () => ({ version: 1, agentKind: identity.agentKind, sessionRef: identity.sessionRef, required: true }));
  }
  const command = "node '" + fileURLToPath(new URL("./review-cli.mjs", import.meta.url)).replaceAll("'", "'\\''") + "'";
  return reviewGuidance(command) + "\n通过 stdin JSON 调用 begin/review/confirm/check/verify/status/cancel。begin 必须携带当前真实会话、用户研发请求锚点、实际模型/供应商、完整 base SHA、requirements、scope、untracked 及必要 checkCommands；查看该 helper 的 help 契约。缺少能力时报告具体缺口，不伪造结果。";
}

export function publicReview(state) {
  const round = state.rounds.at(-1), final = round?.confirmation?.result ? round.confirmation : round;
  return { version: 1, taskId: state.taskId, policyVersion: state.policyVersion, agentKind: state.binding.agentKind, sessionRef: state.binding.sessionRef,
    repository: state.binding.repository, requestId: state.binding.requestId, scopeDigest: state.binding.scopeDigest,
    status: state.status, revision: state.revision, generation: state.generation, round: state.rounds.length, maxRounds: REVIEW_POLICY.rounds,
    candidateDigest: state.candidateDigest, candidateHead: state.candidateHead, checks: state.checks ?? [],
    findings: final?.result?.findings ?? [], reviewLimitations: final?.result?.limitations ?? [],
    limitations: (final?.result?.limitations ?? []).filter(item => typeof item === "string" || item.kind === "blocking" || item.kind === "validation_pending" && state.status !== "passed"), reason: state.reason, proof: state.proof,
    reviewer: final?.receipt ? { sessionRef: final.receipt.sessionRef, model: final.receipt.model, provider: final.receipt.provider, readOnly: final.receipt.readOnly } : null };
}

async function checkCommand(repo, command, signal) {
  if (!command || typeof command.name !== "string" || !Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 100
    || !command.argv.every(value => typeof value === "string" && value.length <= 4000) || !["node", "npm", "npx", "python3", "swift", "cargo", "go", "gradle", "./gradlew"].includes(command.argv[0])) throw new Error("Invalid project validation command");
  return new Promise(resolve => {
    const grouped = process.platform !== "win32";
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let bytes = 0, failed = false, settled = false, stopping = false; const hash = createHash("sha256");
    let escalation;
    const kill = signalName => {
      try { if (grouped && child.pid) process.kill(-child.pid,signalName); else child.kill(signalName); } catch { /* Already exited. */ }
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true; failed = true; kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"),1000);
    };
    const observe = chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) hash.update(chunk); else stop();
    };
    child.stdout.on("data",observe); child.stderr.on("data",observe);
    signal.addEventListener("abort",stop,{once:true}); if (signal.aborted) stop();
    child.once("error",() => { failed = true; stop(); });
    // exit can precede stdout/stderr EOF (including inherited child pipes).
    child.once("close",code => {
      if (settled) return; settled = true;
      clearTimeout(escalation); signal.removeEventListener("abort",stop);
      resolve({name:command.name,method:JSON.stringify(command.argv),result:code===0 && !failed && bytes<=8*1024*1024 ? "passed" : "failed",
        evidence:`exit=${code??"unknown"}; outputBytes=${bytes}; outputSha256=${hash.digest("hex")}${failed?"; execution incomplete":""}`});
    });
  });
}

export async function reviewAction(action, input, options = {}) {
  const root = input.stateRoot ?? defaultReviewRoot();
  if (action === "help") return { version: 1, policy: REVIEW_POLICY, actions: {
    enable: "Explicit local opt-in: repository; does not modify native models, permissions or Agent selection.",
    disable: "Explicit local opt-out: repository; stops new review triggers, preserves history and does not cancel unknown executions.",
    begin: "taskId, agentKind, sessionRef, requestId, scopeDigest(optional), repository, base(40 hex), model(actual ID), provider, effort(optional), requirements, scope(relative source paths), untracked(relative paths), checkCommands([{name,argv}]). Requires enabled repository.",
    review: "taskId; creates one independent native reviewer for the current frozen scope. Real findings return to the original implementer.",
    confirm: "taskId; one focused confirmation after this round's repairs, using the same native reviewer.",
    check: "taskId; runs the predefined project validation commands after a clean review, without a shell or arbitrary later command changes.",
    verify: "taskId; rechecks the reviewed source and actual clean Git HEAD before delivery, without another model call.",
    status: "taskId; read-only evidence, never executes a model or restarts work.",
    cancel: "taskId; invalidates the current generation; a running helper observes cancellation and aborts its reviewer.",
  } };
  if (action === "context") return { text: nativeReviewContext(input.repository, root) };
  const store = new ReviewStore(root);
  if (action === "enable" || action === "disable") {
    const repo = realpathSync(input.repository), identity = repositoryId(repo);
    store.transaction("enabled", () => {
      const path = store.path("enabled");
      const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, repositories: [] };
      if (action === "disable") config.repositories = config.repositories.filter(entry => entry.identity !== identity);
      else if (!config.repositories.some(entry => entry.identity === identity)) config.repositories.push({ identity, repository: repo });
      return config;
    });
    return { enabled: action === "enable", repository: repo, policyVersion: 1 };
  }
  if (action === "begin") {
    if (!enabledReview(input.repository, root)) throw new Error("Local review is not enabled for this repository");
    if (!Array.isArray(input.checkCommands) || !input.checkCommands.length || typeof input.requirements !== "string" || !input.requirements.trim()) throw new Error("A task requires acceptance criteria and concrete validation commands");
    let repositoryUrl;
    try {
      const remote = execFileSync("git", ["-C",input.repository,"remote","get-url","origin"], {encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
      const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
      if (match) repositoryUrl = "https://github.com/"+match[1];
    } catch { /* A local-only task can be reviewed, but has no GitHub delivery proof. */ }
    const requestKey = "request-" + digest(JSON.stringify([input.agentKind, input.sessionRef, input.requestId, repositoryId(input.repository)]));
    const indexId = "session-" + digest(input.agentKind + ":" + input.sessionRef);
    let state;
    const ledger = store.transaction(indexId, () => {
      const indexPath = store.path(indexId), previous = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath,"utf8")) : null;
      const current = Array.isArray(previous) ? {version:1,revision:previous.length,taskIds:previous,activeTaskId:previous.at(-1)??null}
        : previous ?? {version:1,revision:0,taskIds:[],activeTaskId:null};
      const binding = store.transaction(requestKey, () => {
        const path = store.path(requestKey), prior = existsSync(path) ? JSON.parse(readFileSync(path,"utf8")) : null;
        state = store.begin({...input,repositoryUrl,taskId:prior?.taskId??input.taskId,
          scopeDigest:input.scopeDigest??digest(JSON.stringify([input.requestId,input.requirements,input.scope??[]])),requiredChecks:input.checkCommands.map(command=>command.name)});
        const legacySequence = current.taskIds.indexOf(state.taskId)+1;
        return {taskId:state.taskId,sequence:prior?.sequence??(prior ? legacySequence : current.revision+1)};
      });
      if (binding.sequence>current.revision) {
        current.revision=binding.sequence; current.activeTaskId=state.taskId;
        current.taskIds=[...current.taskIds.filter(taskId=>taskId!==state.taskId),state.taskId].slice(-32);
      }
      return current;
    });
    return {...publicReview(state),activeTaskId:ledger.activeTaskId,ledgerRevision:ledger.revision};
  }
  let state = store.read(input.taskId);
  if (action === "status") return publicReview(state);
  if (action === "cancel") return publicReview(store.cancel(state.taskId, state.revision));
  if (!enabledReview(state.binding.repository, root)) throw new Error("Review capability has been disabled; no new work started");
  const candidate = () => {
    const value = stableCandidate(state.binding.repository, state.binding.base, state.binding.untracked, state.binding.scope);
    if (value.uncovered.length) throw new Error("Changed files are outside the frozen review scope; review is incomplete");
    return value;
  };
  if (state.status === "passed" && ["review", "confirm", "check", "verify"].includes(action) && candidate().digest !== state.candidateDigest) {
    state = store.update(state.taskId,state.revision,"candidate_invalidated",record => {
      record.generation++; record.status = record.rounds.length >= REVIEW_POLICY.rounds ? "exhausted" : "incomplete";
      record.reason = "Candidate changed after review"; record.checks = []; delete record.proof;
    });
  }
  if (action === "verify") {
    const current = candidate();
    const clean = execFileSync("git", ["-C", state.binding.repository, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim() === "";
    const proof = { checkedAt: new Date().toISOString(), head: current.head, base: current.base, candidateDigest: current.digest, clean,
        valid: state.status === "passed" && current.digest === state.candidateDigest && clean };
    state = store.update(state.taskId, state.revision, "delivery_verified", record => { record.proof = proof; });
    return { ...publicReview(state), status: state.reason === "Candidate changed after review" && state.status !== "exhausted" ? "stale" : state.status };
  }
  if (action === "check") {
    const before = candidate();
    if (state.status !== "validating" || state.candidateDigest !== before.digest) throw new Error("Validation needs the current clean review");
    const controller = new AbortController(); const checks = [];
    const abort = () => controller.abort();
    const signalStop = () => {
      abort(); const latest = store.read(state.taskId);
      if (latest.generation === state.generation && latest.status === "validating") store.cancel(state.taskId,latest.revision);
    };
    process.once("SIGINT", signalStop); process.once("SIGTERM", signalStop);
    const validationSignal = AbortSignal.any([controller.signal,AbortSignal.timeout(REVIEW_POLICY.validationTimeoutMs)]);
    const generation = state.generation;
    const monitor = setInterval(() => { try { const latest = store.read(state.taskId); if (latest.generation !== generation || latest.status !== "validating") abort(); } catch { abort(); } }, 100);
    try {
      for (const command of state.binding.checkCommands) {
        if (validationSignal.aborted) break;
        checks.push(await checkCommand(state.binding.repository, command, validationSignal));
      }
      const latest = store.read(state.taskId);
      if (latest.generation !== generation || latest.status !== "validating") return publicReview(latest);
      const after = candidate();
      if (after.digest !== before.digest || validationSignal.aborted) return publicReview(store.fail(state.taskId, latest.revision, "Candidate changed or validation interrupted"));
      return publicReview(store.validate(state.taskId, latest.revision, after, checks));
    } finally { clearInterval(monitor); process.removeListener("SIGINT", signalStop); process.removeListener("SIGTERM", signalStop); }
  }
  if (action !== "review" && action !== "confirm") throw new Error("Unknown review action");
  const confirmation = action === "confirm"; const previous = state.rounds.at(-1);
  if (["passed", "cancelled", "exhausted", "unsupported", "needs_decision", "reviewing"].includes(state.status)) throw new Error("Task cannot start another review");
  if (confirmation && (!previous?.nativeRef || !previous.snapshot)) throw new Error("The original reviewer cannot be recovered; do not start a replacement confirmation");
  const frozen = candidate(); const snapshot = join(root, state.taskId + "-snapshot-" + (state.generation + 1));
  materializeCandidate(frozen, snapshot);
  state = store.start(state.taskId, state.revision, frozen, confirmation, snapshot);
  const generation = state.generation;
  const controller = new AbortController(); let stopped = false;
  const cancel = () => { stopped = true; controller.abort(); };
  const signalStop = () => {
    cancel(); const latest = store.read(state.taskId);
    if (latest.generation === generation && latest.status === "reviewing") store.cancel(state.taskId,latest.revision);
  };
  process.once("SIGINT", signalStop); process.once("SIGTERM", signalStop);
  const monitor = setInterval(() => { try { const latest = store.read(state.taskId); if (latest.generation !== generation || latest.status !== "reviewing") cancel(); } catch { cancel(); } }, 200);
  try {
    const context = state.binding.requirements + (confirmation ? "\nEarlier findings (verify rather than blindly trust):\n" + JSON.stringify(previous.result) : "");
    const reviewerInput = { task: state, candidate: frozen, snapshot, prompt: reviewerPrompt({ task: state, candidate: frozen, context, confirmation }),
      ...(confirmation ? { resumeRef: previous.nativeRef, previousSnapshot: previous.snapshot } : {}),
      onBound: ref => { const current = store.read(state.taskId); state = store.bind(state.taskId, current.revision, generation, ref, confirmation); } };
    const output = await (options.runReview ?? independentReview)(reviewerInput, controller.signal);
    const latest = store.read(state.taskId);
    if (stopped || latest.generation !== generation || latest.status !== "reviewing") return publicReview(latest);
    if (candidate().digest !== frozen.digest) return publicReview(store.fail(state.taskId, latest.revision, "Candidate changed during independent review"));
    return publicReview(store.receipt(state.taskId, latest.revision, frozen, output.receipt, output.result, confirmation));
  } catch (error) {
    const latest = store.read(state.taskId);
    if (stopped || latest.generation !== generation || latest.status !== "reviewing") return publicReview(latest);
    return publicReview(store.fail(state.taskId, latest.revision, error instanceof Error ? error.message : "Native reviewer failed"));
  } finally { clearInterval(monitor); process.removeListener("SIGINT", signalStop); process.removeListener("SIGTERM", signalStop); }
}

async function main() {
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 512_000) throw new Error("Review request is too large"); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const output = await reviewAction(process.argv[2] ?? "help", input); process.stdout.write(JSON.stringify(output) + "\n");
}
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    await main().catch(error => { process.stderr.write(JSON.stringify({ error: error.message, status: "incomplete" }) + "\n"); process.exitCode = 1; });
  }
} catch { /* Module import does not enable or execute review. */ }
