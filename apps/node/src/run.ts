import { setTimeout as delay } from "node:timers/promises";

import type { AgentAdapter } from "./agents/types.js";
import { detectRepoCandidates as detectLocalRepoCandidates, type RepoCandidate } from "./repo-candidates.js";
import {
  type DetectedAgent,
  type DispatchReport,
  type DispatchRequest,
  NodeApiClient,
  NodeAuthError,
} from "./client.js";

/**
 * The daemon loop: check in, ask for work, start a session, say what happened.
 *
 * Both loops keep running through failures. A developer machine sleeps, changes
 * network and loses VPN routes all day long; a daemon that exits on the first
 * failed request would be down long before anyone noticed, and the console would
 * only show the machine as offline hours later.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
// How long the server is asked to hold a poll open. Work is handed over the
// moment it is queued; this only bounds how long an idle connection lives.
export const CLAIM_WAIT_MS = 25_000;
// Only used between polls that came back empty or failed, so a server answering
// instantly cannot spin this loop. Short on purpose: it is the one window in
// which the machine is not listening, and a dispatch created inside it waits
// this long — measured at 813ms of the delay when this was a full second.
export const CLAIM_INTERVAL_MS = 250;

// Detection spawns a process, which is wasteful every 30 seconds, but a CLI
// upgrade should still show up in the console without restarting the daemon.
const AGENT_DETECT_TTL_MS = 5 * 60_000;

// The server marked the dispatch as delivered before we got it, so a result
// that never arrives leaves it delivered forever. Worth a few retries.
const RESULT_REPORT_ATTEMPTS = 5;
const RESULT_RETRY_DELAY_MS = 3_000;

export type Logger = (message: string) => void;

export type RunOptions = {
  client: NodeApiClient;
  adapters: readonly AgentAdapter[];
  log?: Logger;
  /** Injectable so a test can describe this machine's checkouts without one. */
  detectRepoCandidates?: () => readonly RepoCandidate[];
  /** Aborting stops both loops and resolves `runLoop`. */
  signal?: AbortSignal;
};

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted while waiting; the loop condition handles it.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAgentDetector(adapters: readonly AgentAdapter[]): () => Promise<DetectedAgent[]> {
  let cached: DetectedAgent[] | undefined;
  let cachedAt = 0;
  return async () => {
    if (cached && Date.now() - cachedAt < AGENT_DETECT_TTL_MS) return cached;
    const detected: DetectedAgent[] = [];
    for (const adapter of adapters) {
      // One adapter failing to detect must not hide the others.
      try {
        const result = await adapter.detect();
        if (result) detected.push({ kind: adapter.kind, version: result.version });
      } catch {
        // Not installed, or not answering: it is simply not reported.
      }
    }
    cached = detected;
    cachedAt = Date.now();
    return detected;
  };
}

/**
 * Start one dispatch. Every failure path ends in a report rather than a throw:
 * a dispatch nobody reports on is stuck in `delivered`, which reads in the
 * console as "the machine took it and is working on it".
 */
export async function launchDispatch(
  request: DispatchRequest,
  adapters: readonly AgentAdapter[],
  log: Logger,
): Promise<DispatchReport> {
  const adapter = adapters.find((candidate) => candidate.kind === request.agentKind);
  if (!adapter) {
    return { status: "failed", error: `本机没有 ${request.agentKind} 的适配器。` };
  }
  log(`派单 ${request.dispatchId}：${request.itemKeys.join("、")}（${request.agentKind}/${request.mode}）于 ${request.repoPath}`);
  try {
    const launched = await adapter.launch({
      dispatchId: request.dispatchId,
      itemKeys: request.itemKeys,
      repoPath: request.repoPath,
      mode: request.mode,
    });
    log(`会话「${launched.sessionName}」已启动，日志 ${launched.logPath}`);
    if (launched.sessionUrl) {
      log(`会话地址 ${launched.sessionUrl}`);
      return { status: "launched", sessionName: launched.sessionName, sessionUrl: launched.sessionUrl };
    }
    // Started, but no URL in time. Still launched: the session exists and can be
    // found in claude.ai/code by name, and reporting failed would be wrong.
    log("等待超时，日志里还没有出现会话地址。");
    return { status: "launched", sessionName: launched.sessionName };
  } catch (error) {
    const reason = describe(error);
    log(`派单 ${request.dispatchId} 启动失败：${reason}`);
    return { status: "failed", error: reason };
  }
}

async function reportWithRetry(
  client: NodeApiClient,
  dispatchId: string,
  report: DispatchReport,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= RESULT_REPORT_ATTEMPTS; attempt += 1) {
    try {
      await client.reportResult(dispatchId, report);
      return;
    } catch (error) {
      if (error instanceof NodeAuthError) throw error;
      log(`回报派单 ${dispatchId} 的结果失败（第 ${attempt} 次）：${describe(error)}`);
      if (attempt === RESULT_REPORT_ATTEMPTS) return;
      await sleep(RESULT_RETRY_DELAY_MS, signal);
      if (signal.aborted) return;
    }
  }
}

export async function runLoop(options: RunOptions): Promise<void> {
  const detectCandidates = options.detectRepoCandidates ?? detectLocalRepoCandidates;
  const log = options.log ?? ((message: string) => { console.log(message); });
  const detectAgents = createAgentDetector(options.adapters);
  const stop = new AbortController();
  const abort = (): void => { stop.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) stop.abort();

  // A revoked token is the one failure that never fixes itself; it stops both
  // loops and surfaces to the caller so the process can exit non-zero.
  let fatal: Error | undefined;
  const handle = (error: unknown, what: string): void => {
    if (error instanceof NodeAuthError) {
      fatal = error;
      stop.abort();
      return;
    }
    log(`${what}：${describe(error)}`);
  };

  let lastRepos = "";
  const heartbeatLoop = async (): Promise<void> => {
    while (!stop.signal.aborted) {
      try {
        const agents = await detectAgents();
        // Re-read every beat rather than caching: a repository the operator
        // just opened for the first time should appear in the console's list
        // without restarting the daemon.
        const repoCandidates = detectCandidates();
        const { repos } = await options.client.heartbeat(agents, repoCandidates);
        // The mapping is configured in the console, so printing it when it
        // changes is the only confirmation on this machine that a product
        // actually points at a local repository.
        const fingerprint = JSON.stringify(repos);
        if (fingerprint !== lastRepos) {
          lastRepos = fingerprint;
          const summary = repos.map((repo) => `${repo.productKey} → ${repo.repoPath}`).join("，");
          log(`仓库映射：${summary || "（尚未配置）"}`);
        }
      } catch (error) {
        handle(error, "上报心跳出错");
      }
      await sleep(HEARTBEAT_INTERVAL_MS, stop.signal);
    }
  };

  const claimLoop = async (): Promise<void> => {
    while (!stop.signal.aborted) {
      try {
        const request = await options.client.claimNext(CLAIM_WAIT_MS);
        if (request) {
          const report = await launchDispatch(request, options.adapters, log);
          await reportWithRetry(options.client, request.dispatchId, report, log, stop.signal);
        }
      } catch (error) {
        handle(error, "拉取派单出错");
      }
      await sleep(CLAIM_INTERVAL_MS, stop.signal);
    }
  };

  await Promise.all([heartbeatLoop(), claimLoop()]);
  if (fatal) throw fatal;
}
