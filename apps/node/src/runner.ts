import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { API, APIError } from "./api.js";
import { directories, loadConfig, privateDir, readPrivate, safeError, savePrivate } from "./storage.js";
import { hostCall, hostDirectory, socketPath } from "./host.js";
import { launchPrompt } from "./prompt.js";
import { probe } from "./process.js";
import { syncSkill } from "./skills.js";
import { OpenCodeAPI } from "./opencode.js";
import { ClaudeEnvironmentCache, resolveClaudeLaunch } from "./environment.js";
import type { Config, Dispatch, HostState, Kind, RepoMapping, Session, Snapshot, AgentConfig } from "./types.js";

declare const NODE_VERSION: string;
export const version = typeof NODE_VERSION === "string" ? NODE_VERSION : "development";
export async function detectAgents(config: Config, expected?: string, resolveClaude = resolveClaudeLaunch) {
  const agents = [];
  for (const [kind, settings] of Object.entries(config.agents) as [Kind, AgentConfig][]) {
    try {
      const launch = kind === "claude_code" ? await resolveClaude(settings) : { executable: settings.executable ?? kind, env: process.env };
      const text = kind === "opencode" ? (await new OpenCodeAPI().call("GET", "/api/info")).version : await probe(launch.executable, ["--version"], undefined, launch.env);
      const skill = await syncSkill(kind, config.server!, expected, launch.env);
      agents.push({ kind, version: String(text).replace(/[^0-9a-zA-Z. _-]/g, "").slice(0, 100), ready: true, skill });
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
    const initial: HostState = { dispatch: job, pid: 0, phase: "starting", sessionName: `${job.nodeName ?? "Linux"}-${job.itemKeys.join(",")}`, commands: {}, snapshot: { status: "active", messages: [] } };
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
        ? { status: "launched", sessionRef: state.sessionRef, sessionName: state.sessionName }
        : { status: "failed", error: state.launchError ?? "Host failed", failureCode: "unknown", failureStage: "host_start" });
      savePrivate(join(directory, "reported.json"), { reportedAt: new Date().toISOString() });
    }
  }
  async function sessions(): Promise<void> {
    await recoverResults();
    const result = await api.call("GET", "/api/v1/node/agent-sessions");
    for (const session of result.sessions as Session[]) {
      if (!session.dispatchId) continue;
      let snapshot: Snapshot;
      try {
        if (session.approvalRetry?.status === "queued") {
          await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, {
            status: "active", messages: [], approvalRetryId: session.approvalRetry.id, approvalRetryStatus: "delivering",
          });
        }
        // Reserve the command on the server BEFORE the detached host can send input.
        if (session.command?.status === "queued") {
          await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, {
            status: "active", messages: [], commandId: session.command.id, commandStatus: "delivering",
          });
        }
        snapshot = await hostCall(root, session.dispatchId, session);
      } catch (error) { snapshot = { status: "unavailable", messages: [], error: safeError(error),
        ...(session.command ? { commandId: session.command.id, commandStatus: "delivery_unknown" } : {}) }; }
      await api.call("POST", `/api/v1/node/agent-sessions/${encodeURIComponent(session.id)}/snapshot`, snapshot);
    }
  }
  try {
    // Establish permitted mappings and expected Skill before advertising readiness.
    const heartbeat = async () => {
      const reply = await api.call("POST", "/api/v1/node/heartbeat", { agents, clientVersion: version, supportsChatAttachments: false, repoCandidates: [] });
      repos = reply.repos ?? [];
      agents = await detectAgents(loadConfig(root), reply.expectedSkillVersion, claudeEnvironment.resolve);
      await api.call("POST", "/api/v1/node/heartbeat", { agents, clientVersion: version, supportsChatAttachments: false, repoCandidates: [] });
      savePrivate(healthPath, { state: "online", checkedAt: new Date().toISOString(), pid: process.pid, agents });
    };
    await heartbeat();
    const loops = [
      retry(heartbeat, 30_000), retry(sessions, 2000),
      retry(async () => {
        const active = await api.call("GET", "/api/v1/node/agent-sessions");
        if (active.sessions.filter((s: Session) => s.occupiesExecutionSlot).length >= 10) return;
        const kinds = agents.filter((a) => a.ready).map((a) => a.kind);
        if (!kinds.length) return;
        const job = await api.call("POST", "/api/v1/node/dispatches/claim-next", { waitMs: 25_000, availableAgentKinds: kinds }) as Dispatch | undefined;
        if (!job) return;
        try {
          if (!repos.some((r) => r.repoPath === job.repoPath) || !loadConfig(root).agents[job.agentKind]) throw new Error("Dispatch repository or Agent is not enabled on this node");
          await launch(root, job, entry); await recoverResults();
        } catch (error) {
          await api.call("POST", `/api/v1/node/dispatches/${encodeURIComponent(job.dispatchId)}/result`, {
            status: "failed", error: safeError(error), failureCode: "unknown", failureStage: "host_start",
          });
        }
      }, 1000),
    ];
    try { await Promise.all(loops); }
    finally { shutdown.abort(); await Promise.allSettled(loops); }
  } finally { savePrivate(healthPath, { state: "stopped", checkedAt: new Date().toISOString() }); }
}
