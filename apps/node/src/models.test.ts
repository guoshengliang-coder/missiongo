import { expect, it } from "vitest";
import { modelOptions } from "./models.js";

it("keeps provider-qualified model identities and excludes unavailable tool models", () => {
  expect(modelOptions("opencode", { data: [
    { providerID: "local", modelID: "shared", name: "Local", capabilities: { tools: true }, variants: [{ id: "high" }] },
    { providerID: "cloud", modelID: "shared", capabilities: { tools: true } },
    { providerID: "cloud", modelID: "image-only", capabilities: { tools: false } },
  ] }).map((model) => model.id)).toEqual(["local/shared", "cloud/shared"]);
});
it("uses native catalog efforts and preserves defaults without synthesizing models", () => {
  expect(modelOptions("codex", { data: [{ id: "catalog-id", model: "native-model", displayName: "Native", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }, { model: "hidden", hidden: true }] })).toEqual([
    { id: "native-model", label: "Native", isDefault: true, defaultEffort: "medium", efforts: ["medium", "high"] },
  ]);
  expect(modelOptions("claude_code", { models: [{ value: "default" }, { value: "gateway-model", displayName: "Gateway", supportedEffortLevels: ["low", "low", "high"] }] })).toEqual([{ id: "gateway-model", label: "Gateway", efforts: ["low", "high"] }]);
});
