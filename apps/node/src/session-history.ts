import { findBinding } from "./bindings.js";
import { resolveAgentLaunch } from "./environment.js";
import { hostHistoryCall, readHostHistory } from "./host.js";
import type { ManagedCoordinator } from "./managed.js";
import { OpenCodeAdapter, OpenCodeAPI } from "./opencode.js";
import { loadConfig } from "./storage.js";
import type { Session } from "./types.js";

/** Read only the server-selected identity. Never discover or resume a CLI to obtain history. */
export async function readSessionHistory(root: string, session: Session, cursor: string, managed?: ManagedCoordinator) {
  if (session.managedExecution) {
    if (!managed) throw new Error("Managed history unavailable");
    return managed.historyPage(session, cursor);
  }
  if (session.externalBindingGeneration !== undefined) {
    const config = loadConfig(root);
    const binding = findBinding(root, session.agentKind, session.sessionRef, config.nodeId);
    if (binding) return hostHistoryCall(root, binding.dispatchId, session.sessionRef, cursor);
    const settings = config.agents.opencode;
    if (session.agentKind !== "opencode" || !settings) throw new Error("History source unavailable");
    const launch = await resolveAgentLaunch("opencode", settings);
    const adapter = await OpenCodeAdapter.attach(session.sessionRef, new OpenCodeAPI(settings.serviceRegistration, launch.env));
    return readHostHistory(adapter, session.sessionRef, { sessionRef: session.sessionRef, cursor });
  }
  if (!session.dispatchId) throw new Error("History source unavailable");
  return hostHistoryCall(root, session.dispatchId, session.sessionRef, cursor);
}
