import type { AgentKind } from "@missiongo/domain";

import type { DispatchNode, NodeAgentModel } from "./types";

/** What was chosen; absent model or effort means "as configured on the Mac". */
export interface ModelChoice {
  readonly model?: string;
  readonly effort?: string;
}

/**
 * The models this machine's agent offers (AND-130). `undefined` is a Mac whose
 * client predates model choice: the dialog then offers only the Mac's own
 * configuration instead of a list the server would refuse.
 */
export function agentModels(node: DispatchNode | undefined, agentKind: AgentKind): readonly NodeAgentModel[] | undefined {
  return node?.agents.find((agent) => agent.kind === agentKind)?.models;
}

/** Efforts for the chosen model, or every effort some model offers when none is chosen. */
export function effortOptions(models: readonly NodeAgentModel[] | undefined, modelId: string | undefined): readonly string[] {
  if (!models) return [];
  const model = modelId ? models.find((entry) => entry.id === modelId) : undefined;
  if (model) return model.efforts;
  return [...new Set(models.flatMap((entry) => entry.efforts))];
}

/**
 * Drop whatever the current machine does not offer. Changing the machine or
 * agent, or a saved default naming a model since removed, must fall back to the
 * Mac's own configuration rather than send something the server refuses.
 */
export function reconcileChoice(models: readonly NodeAgentModel[] | undefined, choice: ModelChoice): ModelChoice {
  if (!models) return {};
  const model = choice.model && models.some((entry) => entry.id === choice.model) ? choice.model : undefined;
  const effort = choice.effort && effortOptions(models, model).includes(choice.effort) ? choice.effort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** Every model some machine reports for this agent, for defaults that are not tied to one machine. */
export function modelsAcrossNodes(nodes: readonly DispatchNode[], agentKind: AgentKind): readonly NodeAgentModel[] {
  const byId = new Map<string, NodeAgentModel>();
  for (const node of nodes) {
    for (const model of agentModels(node, agentKind) ?? []) {
      const known = byId.get(model.id);
      byId.set(model.id, known
        ? { ...known, efforts: [...new Set([...known.efforts, ...model.efforts])] }
        : model);
    }
  }
  return [...byId.values()];
}

const EFFORT_LABEL_KEYS = {
  none: "effortNone",
  minimal: "effortMinimal",
  low: "effortLow",
  medium: "effortMedium",
  high: "effortHigh",
  xhigh: "effortXhigh",
  max: "effortMax",
} as const;

/** An effort this build has no wording for is shown as its own name. */
export function effortLabelKey(effort: string): (typeof EFFORT_LABEL_KEYS)[keyof typeof EFFORT_LABEL_KEYS] | null {
  return Object.hasOwn(EFFORT_LABEL_KEYS, effort) ? EFFORT_LABEL_KEYS[effort as keyof typeof EFFORT_LABEL_KEYS] : null;
}
