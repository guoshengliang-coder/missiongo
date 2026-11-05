import { agentModeCapability, DISPATCH_MODES_BY_AGENT, normalizeAgentMode, type AgentKind, type AgentModeCapability } from "@missiongo/domain";
import { dispatchModeLabelKey } from "./dispatch-eligibility";
import type { MessageKey } from "./i18n";

export function modeChoices(kind: AgentKind, current: string, capabilities?: readonly AgentModeCapability[], model?: string) {
  current=normalizeAgentMode(kind,current);
  const modes: readonly string[] = DISPATCH_MODES_BY_AGENT[kind];
  const values = current && !modes.includes(current) ? [current,...modes] : modes;
  return values.map(value => ({value, labelKey:dispatchModeLabelKey(kind,value),
    ...(!modes.includes(normalizeAgentMode(kind,value)) ? {state:"unavailable" as const,reason:"unsupported_mode"}
      : agentModeCapability(kind,value,capabilities,model))}));
}
export function modeProblem(kind: AgentKind, mode: string, capabilities?: readonly AgentModeCapability[], model?: string): MessageKey | undefined {
  if (!mode) return "dispatchModeChoose";
  const choice=modeChoices(kind,mode,capabilities,model).find(entry=>entry.value===mode);
  return choice?.state === "unknown" ? "dispatchModeUnknown" : choice?.state !== "available" ? "dispatchModeUnavailable" : undefined;
}

export function modeReasonKey(choice: {state:string;reason?:string}): MessageKey {
  return choice.reason==="managed_workspace_required" ? "dispatchModeManagedWorkspace" : choice.state==="unknown" ? "dispatchModeUnknown" : "dispatchModeUnavailable";
}
