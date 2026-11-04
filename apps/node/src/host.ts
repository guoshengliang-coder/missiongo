import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenCodeAdapter } from "./opencode.js";
import { launchPrompt } from "./prompt.js";
import { skillPaths, skillVersion, syncSkill } from "./skills.js";
import { resolveClaudeLaunch } from "./environment.js";
import { probe } from "./process.js";
import { loadConfig, privateDir, readPrivate, safeError, savePrivate } from "./storage.js";
import type { Adapter, Dispatch, HostState, Session, Snapshot } from "./types.js";
import { id, InputRejected } from "./types.js";

export function hostDirectory(root: string, dispatchId: string): string { return join(root, "sessions", id(dispatchId)); }
export function boundedSnapshot(snapshot: Snapshot): Snapshot {
  const messages: Snapshot["messages"] = [];
  let bytes = 0;
  let truncated = false;
  for (const message of [...snapshot.messages].reverse()) {
    const clipped = message.text.length > 100_000 ? { ...message, text: `[早期内容已省略]\n${message.text.slice(-100_000)}` } : message;
    const size = Buffer.byteLength(JSON.stringify(clipped));
    if (messages.length >= 2000 || bytes + size > 8 * 1024 * 1024) { truncated = true; break; }
    if (clipped !== message) truncated = true;
    messages.unshift(clipped); bytes += size;
  }
  return { ...snapshot, messages, ...(truncated ? { error: "镜像历史超出限制，仅同步最近内容；完整记录请在原会话核对。" } : {}) };
}
export function socketPath(root: string, dispatchId: string): string {
  // Linux sockaddr_un is bounded. Keep names short even for long dispatch IDs.
  const path = join(root, `h-${createHash("sha256").update(id(dispatchId)).digest("hex").slice(0, 16)}.sock`);
  if (Buffer.byteLength(path) > 103) throw new Error("Node state path is too long for a Unix socket; set MISSIONGO_NODE_HOME to a shorter private directory");
  return path;
}
export async function hostCall(root: string, dispatchId: string, session?: Session): Promise<Snapshot> {
  const socket = socketPath(root, dispatchId);
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Invalid private host socket");
  return new Promise((resolve, reject) => {
    const client = request({ socketPath: socket, path: "/sync", method: "POST", timeout: 120_000, headers: { "Content-Type": "application/json" } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (part: string) => {
        text += part; if (text.length > 16 * 1024 * 1024) client.destroy(new Error("Oversized host snapshot"));
      });
      response.on("end", () => { try { if (response.statusCode !== 200) throw new Error("Local host rejected request"); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    client.on("timeout", () => client.destroy(new Error("Local host response timed out")));
    client.on("error", reject); client.end(JSON.stringify(session ?? {}));
  });
}
export async function runHost(root: string, dispatchId: string): Promise<void> {
  privateDir(root);
  const directory = hostDirectory(root, dispatchId);
  const statePath = join(directory, "state.json");
  const state = readPrivate<HostState>(statePath);
  if (!state || state.phase !== "starting" || state.pid !== 0) throw new Error("Host launch is already consumed; inspect the original session");
  state.pid = process.pid; savePrivate(statePath, state);
  const job: Dispatch = state.dispatch;
  const config = loadConfig(root);
  const agent = config.agents[job.agentKind];
  if (!agent) throw new Error("Agent is not enabled locally");
  const executable = agent.executable ?? (job.agentKind === "claude_code" ? "claude" : job.agentKind);
  let adapter: Adapter | undefined;
  let launchFinished = false;
  const persist = () => savePrivate(statePath, state);
  const socket = socketPath(root, dispatchId);
  // No deleting stale sockets or reusing hosts with a different native identity.
  if (existsSync(socket)) throw new Error("Host socket already exists");
  let queue = Promise.resolve();
  const decisions = new Set<string>();
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", (part: string) => { body += part; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      queue = queue.then(async () => {
        if (req.method !== "POST" || req.url !== "/sync") { res.writeHead(404).end(); return; }
        try {
          const session = JSON.parse(body) as Session;
          if (!adapter || !launchFinished || state.phase !== "launched") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state.snapshot)); return; }
          if (session.sessionRef && session.sessionRef !== state.sessionRef) throw new Error("Native session identity mismatch");
          if (session.desiredSettings && session.desiredSettings.revision > (state.snapshot.settingsRevision ?? 0)) {
            try {
              if (!adapter.settings) throw new Error("Runtime settings unsupported");
              await adapter.settings(session.desiredSettings); delete state.snapshot.settingsError;
            } catch (error) { state.snapshot.settingsError = safeError(error); }
            state.snapshot.settingsRevision = session.desiredSettings.revision;
          }
          if (session.approvalDecision && !decisions.has(session.approvalDecision.id)) {
            await adapter.decide(session.approvalDecision); decisions.add(session.approvalDecision.id);
          }
          if (session.approvalRetry && !session.command) {
            const retry = session.approvalRetry; const key = id(retry.id);
            state.snapshot.approvalRetryId = key;
            if (retry.status === "queued" && !state.commands[key]) {
              state.commands[key] = { status: "delivering" }; persist();
              try {
                if (!adapter.retryApproval) throw new InputRejected("Native approval retry unsupported");
                await adapter.retryApproval(retry); state.commands[key] = { status: "delivered" };
              } catch (error) { state.commands[key] = { status: error instanceof InputRejected ? "failed" : "delivering", error: safeError(error) }; }
              persist();
            }
            const outcome = state.commands[key];
            if (outcome) {
              state.snapshot.approvalRetryStatus = outcome.status;
              if (outcome.error) state.snapshot.approvalRetryError = outcome.error;
              else delete state.snapshot.approvalRetryError;
            }
            if (retry.status === "delivered" && !(await adapter.snapshot()).turnActive && session.approvalReviewMode && adapter.settings) {
              await adapter.settings({ revision: 0, mode: session.approvalReviewMode }); state.snapshot.approvalRetryStatus = "restored";
            }
          }
          if (session.archiveInSource || session.restoreInSource) {
            try {
              if (!adapter.archive) throw new InputRejected("Source archiving is not supported by this Agent");
              await adapter.archive(session.restoreInSource === true);
              state.snapshot.sourceArchived = !session.restoreInSource;
              if (session.restoreInSource) state.snapshot.sourceRestored = true;
            } catch (error) { state.snapshot.sourceArchiveError = safeError(error); }
          }
          const command = session.command;
          let stopSnapshot: Snapshot | undefined;
          if (command && ["queued", "delivering"].includes(command.status)) {
            const key = id(command.id);
            if (!state.commands[key]) {
              if (Object.keys(state.commands).length >= 10_000) throw new Error("Session command journal is full; start a new explicitly authorized conversation");
              // The server-side delivery reservation is made by the parent before IPC.
              // The local journal is durable BEFORE any native input side effect.
              state.commands[key] = { status: "delivering" }; persist();
              try {
                if (command.attachments?.length) throw new Error("Attachments are not enabled on this node");
                if (command.kind === "interrupt") stopSnapshot = await adapter.stop(command);
                else await adapter.deliver(command);
                if (command.kind === "interrupt" && stopSnapshot) stopSnapshot.stopConfirmed = true;
                state.commands[key] = { status: "delivered", ...(stopSnapshot?.stopConfirmed ? { stopConfirmed: true } : {}) };
              } catch (error) { state.commands[key] = { status: command.kind === "interrupt" ? "failed" : "delivery_unknown", error: safeError(error) }; }
              persist();
            }
            const outcome = state.commands[key]!;
            state.snapshot.commandId = key; state.snapshot.commandStatus = outcome.status;
            if (outcome.stopConfirmed) state.snapshot.stopConfirmed = true;
            else delete state.snapshot.stopConfirmed;
            if (outcome.error) state.snapshot.commandError = outcome.error; else delete state.snapshot.commandError;
          }
          let snapshot: Snapshot;
          try { snapshot = boundedSnapshot(stopSnapshot ?? await adapter.snapshot()); }
          catch (error) {
            if (command?.kind !== "interrupt") throw error;
            snapshot = { status: "unavailable", messages: [], error: safeError(error) };
          }
          if (!snapshot.error) delete state.snapshot.error;
          if (!snapshot.approval) delete state.snapshot.approval;
          state.snapshot = { ...state.snapshot, ...snapshot }; persist();
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state.snapshot));
        } catch (error) { res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: safeError(error) })); }
      }).catch(() => { if (!res.writableEnded) res.writeHead(500).end(); });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); }); });
    const localSkill = job.agentKind === "codex" ? skillVersion(readFileSync(skillPaths("codex")[0]!, "utf8")) : undefined;
    if (job.agentKind === "codex" && !localSkill) throw new Error("Install the current MissionGo Skill before dispatching Codex");
    if (job.agentKind === "claude_code") {
      // Resolve inside the detached host, never serialize secrets into state or mutate the node's environment.
      const launch = await resolveClaudeLaunch(agent);
      await probe(launch.executable, ["--version"], job.repoPath, launch.env);
      const expected = readPrivate<{ agents?: { kind: string; skill?: { expectedVersion?: string } }[] }>(join(root, "status.json"))
        ?.agents?.find((value) => value.kind === "claude_code")?.skill?.expectedVersion;
      await syncSkill("claude_code", config.server!, expected, launch.env);
      adapter = new ClaudeAdapter(job, launch.executable, launch.env);
    } else adapter = job.agentKind === "codex" ? new CodexAdapter(job, executable, localSkill) : new OpenCodeAdapter(job);
    state.sessionRef = await adapter.start(launchPrompt(job));
    if (adapter.initialTurnId) state.initialTurnId = adapter.initialTurnId;
    state.phase = "launched"; state.snapshot = boundedSnapshot(await adapter.snapshot()); launchFinished = true; persist();
  } catch (error) {
    await adapter?.close().catch(() => {});
    state.phase = "failed"; state.launchError = safeError(error);
    state.snapshot = { status: "failed", messages: [], error: state.launchError }; persist(); server.close();
    process.exitCode = 1;
  }
}
