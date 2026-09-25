import { describe, expect, it } from "vitest";

import { agentModels, effortLabelKey, effortOptions, modelsAcrossNodes, reconcileChoice } from "./agent-model-options";
import type { DispatchNode } from "./types";

const models = [
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"] },
  { id: "gpt-5.5-mini", label: "GPT-5.5 mini", efforts: ["low"] },
];

function node(id: string, agentModelsList?: typeof models): DispatchNode {
  return {
    id, name: id, deviceName: id, repos: [], repoCandidates: [], online: true, createdAt: "",
    agents: [{ kind: "codex", ...(agentModelsList ? { models: agentModelsList } : {}) }],
  };
}

describe("Model and effort choices (AND-130)", () => {
  it("offers nothing to choose on a Mac that did not report models", () => {
    expect(agentModels(node("old"), "codex")).toBeUndefined();
    expect(effortOptions(undefined, undefined)).toEqual([]);
    expect(reconcileChoice(undefined, { model: "gpt-5.5", effort: "high" })).toEqual({});
  });

  it("narrows efforts to the chosen model and widens them without one", () => {
    expect(effortOptions(models, "gpt-5.5-mini")).toEqual(["low"]);
    expect(effortOptions(models, undefined)).toEqual(["low", "medium", "high"]);
  });

  it("falls back to the Mac's own configuration for what is no longer offered", () => {
    expect(reconcileChoice(models, { model: "gpt-5.5", effort: "high" })).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(reconcileChoice(models, { model: "gpt-5.5-mini", effort: "high" })).toEqual({ model: "gpt-5.5-mini" });
    expect(reconcileChoice(models, { model: "retired", effort: "medium" })).toEqual({ effort: "medium" });
  });

  it("merges the models every Mac reports for defaults", () => {
    const merged = modelsAcrossNodes([
      node("a", [models[1]!]),
      node("b", [{ ...models[1]!, efforts: ["medium"] }, models[0]!]),
      node("old"),
    ], "codex");
    expect(merged.map((model) => [model.id, model.efforts])).toEqual([
      ["gpt-5.5-mini", ["low", "medium"]],
      ["gpt-5.5", ["low", "medium", "high"]],
    ]);
  });

  it("folds a model one Mac reports more than once into one option (AND-200)", () => {
    const repeated = agentModels(node("a", [
      models[0]!,
      { ...models[0]!, efforts: ["xhigh"] },
      models[1]!,
      models[0]!,
    ]), "codex");
    expect(repeated?.map((model) => [model.id, model.efforts])).toEqual([
      ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.5-mini", ["low"]],
    ]);
    // A Mac that reported no list at all is still the older client.
    expect(agentModels(node("old"), "codex")).toBeUndefined();
  });

  it("names known efforts and leaves others as they are", () => {
    expect(effortLabelKey("xhigh")).toBe("effortXhigh");
    expect(effortLabelKey("turbo")).toBeNull();
  });
});
