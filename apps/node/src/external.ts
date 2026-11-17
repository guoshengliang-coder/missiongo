import { join } from "node:path";
import { API } from "./api.js";
import { findBinding, nativeKey } from "./bindings.js";
import { boundedSnapshot, hostCall, inspectHost } from "./host.js";
import { resolveAgentLaunch } from "./environment.js";
import { prepareAttachments } from "./attachments.js";
import { OpenCodeAPI, OpenCodeAdapter } from "./opencode.js";
import { loadConfig, readPrivate, savePrivate, safeError } from "./storage.js";
import { InputRejected, type Session, type Snapshot, type Config } from "./types.js";

interface Journal { commands: Record<string, { status: string; error?: string; stopConfirmed?: boolean }>; settingsRevision?: number; settingsError?: string }

/** Only server-selected native identities. A missing bridge is unavailable;
 * never enumerate agent history, start a CLI or restore a foreign session.
 */
export async function synchronizeExternal(root: string, session: Session, api: API, signal: AbortSignal, lane: "combined" | "observation" | "control" = "combined"): Promise<Snapshot> {
  const config: Config = loadConfig(root); const settings = config.agents[session.agentKind];
  if (!settings) throw new InputRejected("This Agent integration is not enabled locally");
  const binding = findBinding(root, session.agentKind, session.sessionRef, config.nodeId);
  const probe: Session = { id: session.id, sessionRef: session.sessionRef, agentKind: session.agentKind };
  if (binding) {
    if (session.externalAutoConnect || lane === "observation") return hostCall(root, binding.dispatchId, probe, "observation");
    const observed = await inspectHost(root,binding.dispatchId,probe);
    if (session.agentKind !== "opencode" && (session.approvalDecision || session.approvalRetry)) throw new InputRejected("请在原桥接终端确认权限");
    if (session.agentKind !== "opencode" && session.command && session.command.kind !== "interrupt" && observed.externalPermissionProtocol !== 1) throw new InputRejected("桥接宿主需更新后才能安全接收 Web 回答；请先在原终端回复");
    // A user-owned bridge keeps its native permission decisions in the source
    // terminal. A normal Web text message must not turn into a tool grant.
    if (session.command && session.command.kind !== "interrupt" && session.agentKind !== "opencode" && (observed.approval?.status === "pending"
      || observed.messages.some((message) => message.questions?.some((question) => question.key?.startsWith("授权请求 "))))) {
      throw new InputRejected("请在原桥接终端按请求标识确认权限，Web 文字不能代替工具授权");
    }
    const prepared = session.command ? { ...session, command: await prepareAttachments(root, session.id, session.command, api) } : session;
    return hostCall(root, binding.dispatchId, { ...prepared, terminalPermissionsOnly: session.agentKind !== "opencode" }, lane);
  }
  if (session.agentKind !== "opencode") throw new InputRejected("原生会话未接入此执行环境的桥接宿主；请在来源端使用本机桥接入口，不会自动启动或恢复其他会话");
  const launch = await resolveAgentLaunch("opencode", settings);
  const adapter = await OpenCodeAdapter.attach(session.sessionRef, new OpenCodeAPI(settings.serviceRegistration, launch.env));
  if (session.externalAutoConnect || lane === "observation") return boundedSnapshot(await adapter.snapshot());
  const path = join(root, "external-journals", `${nativeKey(session.agentKind, session.id)}.json`);
  const journal = readPrivate<Journal>(path) ?? { commands: {} };
  const snapshot = lane === "control" ? await adapter.controlSnapshot() : await adapter.snapshot();
  if (session.archiveInSource) snapshot.sourceArchiveError = "OpenCode 共享服务未提供可核实的来源归档操作，请在来源端处理";
  if (session.restoreInSource) snapshot.sourceRestored = true;
  if (session.desiredSettings && session.desiredSettings.revision > (journal.settingsRevision ?? 0)) {
    journal.settingsRevision = session.desiredSettings.revision;
    journal.settingsError = "Settings delivery is unconfirmed"; savePrivate(path, journal);
    try { await adapter.settings(session.desiredSettings); delete journal.settingsError; } catch (error) { journal.settingsError = safeError(error); }
    savePrivate(path, journal);
  }
  const command = session.command;
  if (command && ["queued", "delivering"].includes(command.status)) {
    if (!journal.commands[command.id]) {
      if (Object.keys(journal.commands).length >= 10_000) throw new InputRejected("External delivery journal is full");
      journal.commands[command.id] = { status: "delivery_unknown" }; savePrivate(path, journal);
      try {
        const prepared = await prepareAttachments(root, session.id, command, api);
        if (command.kind === "interrupt") {
          const stopped = await adapter.stop(prepared); Object.assign(snapshot, stopped);
          journal.commands[command.id] = { status: "delivered", stopConfirmed: true };
        } else { await adapter.deliver(prepared, { controlOnly: journal.settingsError !== undefined }); journal.commands[command.id] = { status: "delivered" }; }
      } catch (error) {
        journal.commands[command.id] = { status: error instanceof InputRejected || command.kind === "interrupt" ? "failed" : "delivery_unknown", error: safeError(error) };
      }
      savePrivate(path, journal);
    }
    const outcome = journal.commands[command.id]!;
    snapshot.commandId = command.id; snapshot.commandStatus = outcome.status;
    if (outcome.error) snapshot.commandError = outcome.error;
    if (outcome.stopConfirmed) snapshot.stopConfirmed = true;
  }
  if (journal.settingsRevision !== undefined) snapshot.settingsRevision = journal.settingsRevision;
  if (journal.settingsError) snapshot.settingsError = journal.settingsError;
  return boundedSnapshot(snapshot);
}
