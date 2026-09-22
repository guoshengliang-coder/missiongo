import { isSupportedDispatchMode, type AgentKind } from "@missiongo/domain";

import { conflict, invalidInput } from "./errors.js";

/**
 * One model a Mac's agent offers, as that Mac reported it (AND-130). Codex
 * lists them over app-server `model/list`; Claude Code in its `initialize`
 * response. MissionGo keeps no list of its own: a model name only means
 * something to the agent that will run it.
 */
export interface NodeAgentModel {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly isDefault?: boolean;
}

/** A session's mode, model and effort. Absent model or effort: the Mac's own configuration. */
export interface AgentRunSettings {
  readonly mode?: string;
  readonly model?: string;
  readonly effort?: string;
}

const MAX_MODELS = 100;
const MAX_EFFORTS = 20;
const MAX_NAME_LENGTH = 200;

function boundedName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidInput(`${field} must be a non-empty string.`);
  const text = value.trim();
  if (text.length > MAX_NAME_LENGTH) throw invalidInput(`${field} must be ${MAX_NAME_LENGTH} characters or fewer.`);
  return text;
}

/**
 * The `models` a heartbeat carries for one agent. `undefined` is an older
 * client that cannot choose models or change a running session; an empty list
 * is a current client whose agent could not list any right now.
 */
export function parseAgentModels(value: unknown): readonly NodeAgentModel[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidInput("models must be an array.");
  if (value.length > MAX_MODELS) throw invalidInput(`An agent may report at most ${MAX_MODELS} models.`);
  const seen = new Set<string>();
  return value.flatMap((entry): NodeAgentModel[] => {
    if (!entry || typeof entry !== "object") throw invalidInput("Each model must be an object.");
    const model = entry as Record<string, unknown>;
    const id = boundedName(model.id, "model id");
    if (seen.has(id)) return [];
    seen.add(id);
    const efforts = model.efforts === undefined ? [] : model.efforts;
    if (!Array.isArray(efforts) || efforts.length > MAX_EFFORTS) {
      throw invalidInput(`model efforts must be an array of at most ${MAX_EFFORTS} names.`);
    }
    return [{
      id,
      label: model.label === undefined ? id : boundedName(model.label, "model label"),
      efforts: [...new Set(efforts.map((effort) => boundedName(effort, "effort")))],
      ...(model.defaultEffort !== undefined && model.defaultEffort !== null
        ? { defaultEffort: boundedName(model.defaultEffort, "defaultEffort") }
        : {}),
      ...(model.isDefault === true ? { isDefault: true } : {}),
    }];
  });
}

/** Optional request field: absent or null means "not chosen". */
export function optionalName(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  return boundedName(value, field);
}

/**
 * Check a model and effort against what the machine said its agent offers.
 * Choosing neither is always allowed -- the agent then runs as configured on
 * that Mac. An effort without a model must be one some model offers.
 */
export function requireOfferedModel(
  agentKind: AgentKind,
  models: readonly NodeAgentModel[] | undefined,
  settings: AgentRunSettings,
): void {
  if (settings.mode !== undefined && !isSupportedDispatchMode(agentKind, settings.mode)) {
    throw invalidInput(`Unsupported mode for this agent: ${settings.mode}.`);
  }
  if (settings.model === undefined && settings.effort === undefined) return;
  if (models === undefined) {
    throw conflict(
      "node_upgrade_required",
      "This Mac's MissionGo client cannot choose a model or effort yet; update it first.",
    );
  }
  const model = settings.model === undefined ? undefined : models.find((entry) => entry.id === settings.model);
  if (settings.model !== undefined && !model) {
    throw invalidInput(`This Mac's agent does not offer the model ${settings.model}.`);
  }
  if (settings.effort === undefined) return;
  const efforts = model ? model.efforts : [...new Set(models.flatMap((entry) => entry.efforts))];
  if (!efforts.includes(settings.effort)) {
    throw invalidInput(`Effort ${settings.effort} is not offered${model ? ` by ${model.id}` : ""}.`);
  }
}
