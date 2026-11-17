import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { API, APIError } from "./api.js";
import { hostCall, hostDirectory, hostHistoryCall } from "./host.js";
import { loadConfig, privateDir, readPrivate, savePrivate } from "./storage.js";
import { probe } from "./process.js";
import { worktreePath } from "./prompt.js";
import { id, type HostState, type Session, type Snapshot, type Wire } from "./types.js";
import { validateManagedJob, type ManagedJob, type ManagedReceipt, type ManagedIntent } from "./managed-policy.js";

interface Observation { sequence: number; generation: number; state: "bound" | "running" | "waiting" | "unknown"; sessionRef?: string; resolvedModel?: string }
export interface ManagedEntry { job: ManagedJob; phase: string; nextSequence: number; receipt?: ManagedReceipt; pending?: Observation; terminal?: Wire }
const sameBinding = (a: ManagedIntent, b: ManagedIntent) => a.id === b.id && a.stageId === b.stageId && a.generation === b.generation
  && JSON.stringify(Object.entries(a.binding).sort()) === JSON.stringify(Object.entries(b.binding).sort());
function sourceSession(entry: ManagedEntry): Session {
  const intent = entry.job.intent;
  return { id: intent.sessionId ?? intent.id, agentKind: "codex", sessionRef: entry.receipt!.sessionRef,
    managedExecution: { id: intent.id, stageId: intent.stageId, runId: intent.binding.runId, generation: intent.generation, role: intent.binding.role, state: intent.state, stopRequested: intent.stopRequested } };
}
export class ManagedCoordinator {
  private busy = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private root: string, private entrypoint: string, private api: API) {}
  private path(intentId: string) { return join(this.root, "managed-journal", `${id(intentId)}.json`); }
  private save(entry: ManagedEntry) { savePrivate(this.path(entry.job.intent.id), entry); }
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  private report(entry: ManagedEntry, state: Observation["state"]) {
    entry.pending = { sequence: entry.nextSequence, generation: entry.job.intent.generation, state,
      ...(entry.receipt ? { sessionRef: entry.receipt.sessionRef, resolvedModel: entry.receipt.resolvedModel } : {}) };
    this.save(entry);
  }
  async flush(entry: ManagedEntry): Promise<void> {
    const pending = entry.pending; if (!pending) return;
    const response = await this.api.call("POST", `/api/v1/node/managed-execution/${encodeURIComponent(entry.job.intent.id)}/report`, pending);
    if (!response.accepted) throw new Error("Managed observation was not accepted");
    if (response.terminal) {
      const terminal = response.terminal;
      if (terminal.state !== "terminal" || terminal.intentId !== entry.job.intent.id || terminal.generation !== pending.generation
        || terminal.sequence !== pending.sequence || terminal.sessionRef !== entry.receipt?.sessionRef || terminal.resolvedModel !== entry.receipt?.resolvedModel) throw new Error("Managed terminal receipt binding differed");
      entry.terminal = terminal; entry.phase = "terminal";
    }
    entry.nextSequence = pending.sequence + 1; delete entry.pending; this.save(entry);
  }
  private async permit(entry: ManagedEntry): Promise<ManagedIntent> {
    const response = await this.api.call("POST", `/api/v1/node/managed-execution/${encodeURIComponent(entry.job.intent.id)}/permit`, { generation: entry.job.intent.generation });
    if (!response.mayStart || !sameBinding(response.intent, entry.job.intent) || response.intent.stopRequested) throw new Error("Managed permission changed or is no longer available");
    return response.intent;
  }
  async process(job: ManagedJob, signal: AbortSignal): Promise<void> {
    return this.serialize(job.intent.id, () => this.processOne(job, signal));
  }
  private async processOne(job: ManagedJob, signal: AbortSignal): Promise<void> {
    validateManagedJob(job);
    if (this.busy.has(job.intent.id)) return;
    this.busy.add(job.intent.id);
    try {
      const current = readPrivate<ManagedEntry>(this.path(job.intent.id));
      if (current) {
        if (!sameBinding(current.job.intent, job.intent)) throw new Error("Managed journal identity changed");
        await this.flush(current);
        if (["launching", "turnPermitPending", "turnStarting"].includes(current.phase)) { current.phase = "unknown"; this.report(current, "unknown"); await this.flush(current); }
        if (current.receipt && current.phase !== "terminal" && (job.intent.stopRequested || !job.enabled || !loadConfig(this.root).managedExecutionEnabled)) {
          const session = sourceSession(current); session.managedExecution!.stopRequested = true;
          await this.synchronizeOne(session, signal); return;
        }
        if (current.phase === "bound" && job.enabled && !job.intent.stopRequested) await this.firstTurn(current, signal);
        return;
      }
      if (!job.intent.ownershipHeld || job.intent.sessionId || job.intent.state === "terminal") return;
      if (["starting", "bound", "turn_starting", "unknown"].includes(job.intent.state)) {
        const uncertain: ManagedEntry = { job, phase: "unknown", nextSequence: 1 }; this.report(uncertain, "unknown"); await this.flush(uncertain); return;
      }
      const config = loadConfig(this.root);
      if (!job.enabled || !config.managedExecutionEnabled || !config.agents.codex || config.nodeId !== job.intent.binding.nodeId
        || job.intent.stopRequested || !["requested", "acknowledged"].includes(job.intent.state)) return;
      const mappings = await this.api.call("GET", "/api/v1/node/me");
      if (!mappings.repos?.some((repo: Wire) => repo.repoPath === job.repoPath)) throw new Error("Managed repository is not registered on this node");
      const claimed = await this.api.call("POST", `/api/v1/node/managed-execution/${encodeURIComponent(job.intent.id)}/claim`, { generation: job.intent.generation });
      if (!sameBinding(claimed, job.intent)) throw new Error("Managed claim binding differed");
      const entry: ManagedEntry = { job, phase: "launching", nextSequence: 1 };
      const permitted = await this.permit(entry); this.save(entry);
      try {
        if (await probe("git", ["rev-parse", "--verify", `${job.intent.binding.inputCommit}^{commit}`], job.repoPath) !== job.intent.binding.inputCommit) throw new Error("Managed input commit unavailable");
        const dispatchId = `managed-${job.intent.id}`;
        const dispatch = { dispatchId, itemKeys: [], freeSession: true, repoPath: job.repoPath, agentKind: "codex" as const, mode: "default" };
        const cwd = worktreePath(dispatch);
        if (existsSync(cwd)) throw new Error("Managed directory already exists; reconciliation required");
        await probe("git", ["worktree", "add", "--detach", cwd, job.intent.binding.inputCommit], job.repoPath);
        const directory = hostDirectory(this.root, dispatchId); privateDir(directory);
        const hostPath = join(directory, "state.json");
        const host: HostState = { dispatch: { ...dispatch, repoPath: cwd }, managedJob: { ...job, repoPath: cwd, intent: permitted }, pid: 0,
          phase: "starting", commands: {}, snapshot: { status: "active", messages: [] }, sessionName: `Managed ${job.intent.binding.role} ${job.intent.id}`,
          ...(process.platform === "win32" ? { ipcToken: randomBytes(32).toString("hex") } : {}) };
        savePrivate(hostPath, host);
        const child = spawn(process.execPath, [this.entrypoint, "_host", dispatchId], { detached: true, stdio: "ignore", env: { ...process.env, MISSIONGO_NODE_HOME: this.root } });
        child.on("error", () => {}); child.unref();
        for (let n = 0; n < 120; n++) {
          const state = readPrivate<HostState>(hostPath)!;
          if (state.phase === "launched" && state.managedReceipt) { entry.receipt = state.managedReceipt; break; }
          if (state.phase === "failed") break;
          await delay(100, undefined, { signal });
        }
      } catch { /* Launch permission was consumed; never launch a replacement. */ }
      entry.phase = entry.receipt ? "bound" : "unknown"; this.report(entry, entry.receipt ? "bound" : "unknown"); await this.flush(entry);
      if (entry.phase === "bound") await this.firstTurn(entry, signal);
    } finally { this.busy.delete(job.intent.id); }
  }
  private async firstTurn(entry: ManagedEntry, signal: AbortSignal): Promise<void> {
    if (!entry.receipt || !loadConfig(this.root).managedExecutionEnabled) return;
    entry.phase = "turnPermitPending"; this.save(entry);
    await this.permit(entry); entry.phase = "turnStarting"; this.save(entry);
    try { await hostCall(this.root, `managed-${entry.job.intent.id}`, sourceSession(entry), signal, "managed-start"); entry.phase = "running"; }
    catch { entry.phase = "unknown"; }
    this.report(entry, entry.phase === "running" ? "running" : "unknown"); await this.flush(entry);
  }
  async synchronize(session: Session, signal: AbortSignal, observationOnly = false): Promise<Snapshot> {
    if (!session.managedExecution) throw new Error("Missing managed session binding");
    if (observationOnly) return this.synchronizeOne(session, signal, true);
    return this.serialize(session.managedExecution.id, () => this.synchronizeOne(session, signal));
  }
  private async synchronizeOne(session: Session, signal: AbortSignal, observationOnly = false): Promise<Snapshot> {
    const entry = this.sourceEntry(session);
    const binding = session.managedExecution!;
    if (observationOnly) return hostCall(this.root, `managed-${binding.id}`, sourceSession(entry), "observation");
    const stop = binding.stopRequested || !loadConfig(this.root).managedExecutionEnabled;
    const input = stop ? sourceSession(entry) : { ...session };
    const observed = stop ? await hostCall(this.root, `managed-${binding.id}`, input, signal, "managed-stop") : await hostCall(this.root, `managed-${binding.id}`, input, "control");
    if (["running", "unknown"].includes(entry.phase) || stop && entry.phase !== "terminal") {
      await this.flush(entry);
      if (entry.phase !== "terminal") { this.report(entry, observed.status === "active" ? "running" : observed.status === "idle" ? "waiting" : "unknown"); await this.flush(entry); }
    }
    return observed;
  }
  private sourceEntry(session: Session): ManagedEntry {
    const binding = session.managedExecution; if (!binding) throw new Error("Missing managed session binding");
    const entry = readPrivate<ManagedEntry>(this.path(binding.id));
    if (!entry?.receipt || entry.receipt.sessionRef !== session.sessionRef || entry.job.intent.generation !== binding.generation
      || entry.job.intent.stageId !== binding.stageId || entry.job.intent.binding.runId !== binding.runId || entry.job.intent.binding.role !== binding.role) throw new Error("Managed source identity unavailable; no runtime resumed");
    if (session.agentKind !== "codex" || entry.job.intent.binding.nodeId !== loadConfig(this.root).nodeId) throw new Error("Managed source node differed");
    return entry;
  }
  async historyPage(session: Session, cursor: string) {
    this.sourceEntry(session);
    return hostHistoryCall(this.root, `managed-${session.managedExecution!.id}`, session.sessionRef, cursor);
  }
  async poll(signal: AbortSignal): Promise<void> {
    const directory = join(this.root, "managed-journal");
    if (existsSync(directory)) for (const filename of readdirSync(directory).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))) {
      await this.serialize(filename.slice(0, -5), async () => { const entry = readPrivate<ManagedEntry>(join(directory, filename)); if (entry?.pending) await this.flush(entry); });
    }
    if (!loadConfig(this.root).managedExecutionEnabled && !existsSync(directory)) return;
    let reply: Wire;
    try { reply = await this.api.call("GET", "/api/v1/node/managed-execution"); } catch (error) { if (error instanceof APIError && error.status === 404) return; throw error; }
    for (const stop of reply.stops ?? []) {
      await this.serialize(id(stop.id), async () => {
        const entry = readPrivate<ManagedEntry>(this.path(stop.id));
        if (!entry?.receipt || entry.phase === "terminal" || entry.job.intent.generation !== stop.generation) return;
        const session = sourceSession(entry); session.managedExecution!.stopRequested = true;
        await this.synchronizeOne(session, signal);
      });
    }
    for (const job of reply.jobs ?? []) await this.process({ ...job, enabled: job.enabled && loadConfig(this.root).managedExecutionEnabled === true }, signal);
  }
}
