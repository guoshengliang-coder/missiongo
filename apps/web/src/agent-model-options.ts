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
 *
 * An agent can report the same model more than once -- a Claude Code endpoint
 * lists a model per context variant, and an initialize answer repeats entries
 * (AND-200). The picker is a list of choices, not a log, so the same id is
 * folded into one option and the efforts are merged rather than shown twice.
 */
export function agentModels(node: DispatchNode | undefined, agentKind: AgentKind): readonly NodeAgentModel[] | undefined {
  const models = node?.agents.find((agent) => agent.kind === agentKind)?.models;
  if (!models) return undefined;
  const byId = new Map<string, NodeAgentModel>();
  for (const model of models) {
    const known = byId.get(model.id);
    byId.set(model.id, known
      ? { ...known, efforts: [...new Set([...known.efforts, ...model.efforts])] }
      : model);
  }
  return [...byId.values()];
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

/** One slice of the model list: a vendor's models, or the ones with no vendor said. */
export interface ModelGroup {
  readonly provider: string | null;
  readonly models: readonly NodeAgentModel[];
}

/**
 * Models grouped by the vendor the agent listed them under (AND-189: OpenCode
 * reports one group per provider). Ungrouped agents -- Claude Code, Codex --
 * get a single group with `provider: null`, so a picker renders one
 * `<optgroup>` or one flat list by the same code.
 */
export function groupModelsByProvider(models: readonly NodeAgentModel[]): readonly ModelGroup[] {
  const groups: ModelGroup[] = [];
  const index = new Map<string, ModelGroup>();
  for (const model of models) {
    const provider = model.provider ?? null;
    const key = provider ?? "";
    const found = index.get(key);
    if (found) {
      index.set(key, { provider, models: [...found.models, model] });
    } else {
      const group = { provider, models: [model] };
      index.set(key, group);
      groups.push(group);
    }
  }
  // The map only tracks grouping; the array is rebuilt so later additions to a
  // group replace it in place rather than appending a second group.
  return groups.map((group) => index.get(group.provider ?? "") ?? group);
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
