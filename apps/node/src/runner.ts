import { SessionWorkQueue, SessionUploadGate, SnapshotReports, SnapshotHealth, ControlReports, hasControlWork, observationSession } from "./session-work.js";
import { sessionName } from "./session-name.js";
import { probeClaudeCapabilities } from "./claude-capabilities.js";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { completeImageArtifacts } from "./artifacts.js";
import { API, APIError } from "./api.js";
import { directories, loadConfig, privateDir, readPrivate, safeError, savePrivate } from "./storage.js";
import { hostCall, hostHistoryCall, hostDirectory, socketPath } from "./host.js";
import { launchPrompt } from "./prompt.js";
import { probe } from "./process.js";
import { syncSkill } from "./skills.js";
import { OpenCodeAPI } from "./opencode.js";
import { ClaudeEnvironmentCache, resolveClaudeLaunch } from "./environment.js";
import type { Config, Dispatch, HostState, Kind, RepoMapping, Session, Snapshot, AgentConfig } from "./types.js";

declare const NODE_VERSION: string;
interface WireHistoryJob { id: string; sessionId: string; sessionRef: string; agentKind: string; cursor: string }
export const version = typeof NODE_VERSION === "string" ? NODE_VERSION : "development";
export async function detectAgents(config: Config, expected?: string, resolveClaude = resolveClaudeLaunch) {
  const agents = [];
  for (const [kind, settings] of Object.entries(config.agents) as [Kind, AgentConfig][]) {
    try {
      const launch = kind === "claude_code" ? await resolveClaude(settings) : { executable: settings.executable ?? kind, env: process.env };
      const text = kind === "opencode" ? (await new OpenCodeAPI().call("GET", "/api/info")).version : await probe(launch.executable, ["--version"], undefined, launch.env);
      const skill = await syncSkill(kind, config.server!, expected, launch.env);
      const native=kind==="claude_code" ? await probeClaudeCapabilities(launch.executable,process.cwd(),launch.env).catch(()=>undefined) : undefined;
      agents.push({ ...native, planApprovalProtocol:1, kind, version: String(text).replace(/[^0-9a-zA-Z. _-]/g, "").slice(0, 100), ready: true, skill });
    } catch (error) { agents.push({ kind, ready: false, unavailableReason: safeError(error) }); }
  }
  return agents;
}
export async function verifyRepo(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Repository path must be absolute");
  const canonical = realpathSync(path);
  const top = await probe("git", ["rev-parse", "--show-toplevel"], canonical);
  if (realpathSync(top) !== canonical) throw new Error("Map the repository root, not a subdirectory");
  return canonical;
}
export async function launch(root: string, job: Dispatch, entry: string): Promise<HostState> {
  launchPrompt(job);
  socketPath(root, job.dispatchId);
  job.repoPath = await verifyRepo(job.repoPath);
  const directory = hostDirectory(root, job.dispatchId); privateDir(directory);
  const path = join(directory, "state.json");
  if (!existsSync(path)) {
    const initial: HostState = { dispatch: job, pid: 0, phase: "starting", sessionName: sessionName(job), commands: {}, snapshot: { status: "active", messages: [] } };
    savePrivate(path, initial);
    // Detached host survives parent/systemd restarts. There is never an automatic second launch.
    const child = spawn(process.execPath, [entry, "_host", job.dispatchId], { detached: true, stdio: "ignore", env: { ...process.env, MISSIONGO_NODE_HOME: root } });
    child.on("error", () => {}); child.unref();
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = readPrivate<HostState>(path)!;
    if (state.phase !== "starting") return state;
    await delay(1000);
  }
  throw new Error("Host launch is unconfirmed; inspect the original session before retrying");
}
export async function runNode(root: string, entry: string, signal: AbortSignal, log: (text: string) => void = console.log): Promise<void> {
  const shutdown = new AbortController();
  signal = AbortSignal.any([signal, shutdown.signal]);
  const config = loadConfig(root);
  if (!config.server || !config.token) throw new Error("Run login first");
  const api = new API(config.server, config.token, signal);
  const healthPath = join(root, "status.json");
  let repos: RepoMapping[] = [];
  let agents: Awaited<ReturnType<typeof detectAgents>> = [];
  const claudeEnvironment = new ClaudeEnvironmentCache();
  const pause = (ms: number) => delay(ms, undefined, { signal });
  const retry = async (work: () => Promise<void>, ms: number) => {
    while (!signal.aborted) {
      try { await work(); }
      catch (error) {
        if (signal.aborted) return;
        log(safeError(error));
        savePrivate(healthPath, { state: error instanceof APIError && error.status === 401 ? "credential_revoked" : "degraded", checkedAt: new Date().toISOString() });
        if (error instanceof APIError && [401, 403].includes(error.status)) throw error;
      }
      await pause(ms).catch(() => {});
    }
  };
  async function recoverResults(): Promise<void> {
    for (const key of directories(join(root, "sessions"))) {
      const directory = hostDirectory(root, key);
      const state = readPrivate<HostState>(join(directory, "state.json"));
      if (!state || state.phase === "starting" || readPrivate(join(directory, "reported.json"))) continue;
      await api.call("POST", `/api/v1/node/dispatches/${encodeURIComponent(key)}/result`, state.phase === "launched"
        ? { status: "launched", sessionRef: state.sessionRef, sessionName: state.sessionName, initialTurnId: state.initialTurnId }
        : { status: "failed", error: state.launchError ?? "Host failed", failureCode: "unknown", failureStage: "host_start" });
      savePrivate(join(directory, "reported.json"), { reportedAt: new Date().toISOString() });
    }
  }
  let separated = false;
  let controlCursor: string | undefined;
  let taskError: unknown;
  const failedTask = (error: unknown) => {
    if (signal.aborted) return;
    log(safeError(error));
    savePrivate(healthPath, {state: error instanceof APIError && [401,403].includes(error.status) ? "credential_revoked" : "degraded", checkedAt:new Date().toISOString()});
    if (error instanceof APIError && [401,403].includes(error.status)) { taskError = error; shutdown.abort(); }
  };
  const mirrors = new SessionWorkQueue(failedTask);
  const controls = new SessionWorkQueue(failedTask);
  const stops = new SessionWorkQueue(failedTask);
  const uploads = new SessionUploadGate();
  const reported = new SnapshotReports();
  const health = new SnapshotHealth();
  const epochs = new Map<string, number>();
  const controlling = new Map<string, number>();
  const controlReports = new ControlReports();
  const submitControl = (session: Session) => (session.command?.kind === "interrupt" ? stops : controls)
    .submit(session.id, () => synchronize(session, "control"));
  async function synchronize(session: Session, lane: "combined" | "observation" | "control"): Promise<void> {
    if (!session.dispatchId || signal.aborted) return;
    const epoch = epochs.get(session.id) ?? 0;
    const control = lane === "control";
    if (lane === "observation" && controlling.has(session.id)) return;
    if (control) { epochs.set(session.id, epoch + 1); controlling.set(session.id, (controlling.get(session.id) ?? 0) + 1); }
    const post = (snapshot: Snapshot) => uploads.run(session.id, async () => {
      if (control) snapshot = controlReports.record(session.id, epoch + 1, snapshot);
      if (lane === "observation" && (controlling.has(session.id) || epoch !== (epochs.get(session.id) ?? 0))) return;
      const key = session.id + ":" + lane;
      const hash = reported.fingerprint(snapshot);
      if (lane !== "control" && !reported.needed(key, hash)) return;
      try { await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, snapshot); reported.confirm(key, hash); }
      catch (error) { reported.failed(key); throw error; }
    });
    try {
      let snapshot: Snapshot;
      try {
        // Complete the server reservation before handing an input to the
        // detached host. A lost reservation response never starts input.
        if (session.approvalRetry?.status === "queued") {
          await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, {
            status: "active", messages: [], approvalRetryId: session.approvalRetry.id, approvalRetryStatus: "delivering",
          });
        }
        if (session.command?.status === "queued") {
          await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, {
            status: "active", messages: [], commandId: session.command.id, commandStatus: "delivering",
          });
        }
        snapshot = await hostCall(root, session.dispatchId, session, lane);
      } catch (error) {
        if (error instanceof APIError) throw error;
        snapshot = {status: "unavailable", messages: [], error: safeError(error),
          ...(session.command ? {commandId: session.command.id, commandStatus: session.command.kind === "interrupt" ? "failed" : "delivery_unknown",
            commandError: session.command.kind === "interrupt" ? "停止尚未确认：节点未取得执行结果，请核实来源后重试。" : safeError(error)} : {})};
      }
      await post(lane === "control" ? snapshot : health.observe(session.id, snapshot));
    } finally {
      if (control) { const remaining = (controlling.get(session.id) ?? 1) - 1;
        if (remaining) controlling.set(session.id, remaining); else controlling.delete(session.id); }
    }
  }
  async function sessions(): Promise<void> {
    const result = await api.call("GET", "/api/v1/node/agent-sessions");
    for (const session of result.sessions as Session[]) {
      if (!session.dispatchId) continue;
      const observed = separated ? observationSession(session) : session;
      mirrors.submit(session.id, () => synchronize(observed, separated ? "observation" : "combined"));
    }
  }
  async function controlChanges(): Promise<void> {
    if (!separated) return;
    const change = await api.controlChanges(controlCursor);
    if (change) controlCursor = change.cursor;
    const sessions: Session[] = (await api.call("GET", "/api/v1/node/agent-sessions")).sessions;
    for (const session of sessions) if (hasControlWork(session)) submitControl(session);
    // An old server or rolling downgrade needs the legacy cadence, not a spin.
    if (!change) await pause(2000);
  }
  async function history(): Promise<void> {
    let jobs: WireHistoryJob[];
    try { jobs = (await api.call("GET", "/api/v1/node/agent-history")).jobs; }
    catch (error) { if (error instanceof APIError && error.status === 404) return; throw error; }
    if (!jobs.length) return;
    const available: Session[] = (await api.call("GET", "/api/v1/node/agent-sessions")).sessions;
    for (const job of jobs) {
      let page;
      try {
        const source = available.find(session => session.id === job.sessionId && session.sessionRef === job.sessionRef
          && ["codex","opencode","claude_code"].includes(session.agentKind) && session.agentKind === job.agentKind);
        if (!source?.dispatchId) throw new Error("History source unavailable");
        page = await hostHistoryCall(root, source.dispatchId, source.sessionRef, job.cursor);
      } catch { page = { messages: [], error: "node_unavailable" }; }
      await api.call("POST", `/api/v1/node/agent-history/${encodeURIComponent(job.id)}`, page);
    }
  }
  try {
    // Establish permitted mappings and expected Skill before advertising readiness.
    const heartbeat = async () => {
      const reply = await api.call("POST", "/api/v1/node/heartbeat", { agents, clientVersion: version, supportsChatAttachments: false, supportsFreeSessions: true, repoCandidates: [] });
      repos = reply.repos ?? [];
      agents = await detectAgents(loadConfig(root), reply.expectedSkillVersion, claudeEnvironment.resolve);
      await api.call("POST", "/api/v1/node/heartbeat", { agents, clientVersion: version, supportsChatAttachments: false, supportsFreeSessions: true, repoCandidates: [] });
      savePrivate(healthPath, { state: "online", checkedAt: new Date().toISOString(), pid: process.pid, agents });
    };
    await heartbeat();
    const initial = await api.controlChanges(undefined, 0);
    separated = initial !== undefined; controlCursor = initial?.cursor;
    if (separated) {
      const initialSessions: Session[] = (await api.call("GET", "/api/v1/node/agent-sessions")).sessions;
      for (const session of initialSessions) if (hasControlWork(session)) submitControl(session);
    }
    const loops = [
      retry(heartbeat, 30_000), retry(recoverResults, 1000), retry(sessions, 2000),
      ...(separated ? [retry(controlChanges, 0)] : []), retry(history, 2000), retry(() => completeImageArtifacts(root, api), 2000),
      retry(async () => {
        const active = await api.call("GET", "/api/v1/node/agent-sessions");
        if (active.sessions.filter((s: Session) => s.occupiesExecutionSlot).length >= 10) return;
        const kinds = agents.filter((a) => a.ready).map((a) => a.kind);
        if (!kinds.length) return;
        const job = await api.call("POST", "/api/v1/node/dispatches/claim-next", { waitMs: 25_000, availableAgentKinds: kinds }) as Dispatch | undefined;
        if (!job) return;
        try {
          if (!repos.some((r) => r.repoPath === job.repoPath) || !loadConfig(root).agents[job.agentKind]) throw new Error("Dispatch repository or Agent is not enabled on this node");
          const permit = await api.call("POST", `/api/v1/node/dispatches/${encodeURIComponent(job.dispatchId)}/permit-start`, {});
          if (!permit.allowed) return;
          await launch(root, job, entry); await recoverResults();
        } catch (error) {
          await api.call("POST", `/api/v1/node/dispatches/${encodeURIComponent(job.dispatchId)}/result`, {
            status: "failed", error: safeError(error), failureCode: "unknown", failureStage: "host_start",
          });
        }
      }, 1000),
    ];
    try { await Promise.all(loops); }
    finally { shutdown.abort(); await Promise.allSettled(loops); await Promise.all([mirrors.finish(), controls.finish(), stops.finish()]); }
    if (taskError) throw taskError;
  } finally { savePrivate(healthPath, { state: "stopped", checkedAt: new Date().toISOString() }); }
}
