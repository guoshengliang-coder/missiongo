import { expect, it } from "vitest";
import { agentProbeKey, modelOptions } from "./models.js";

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

it("keeps valid models when neighboring records and effort catalogs are malformed",()=>{
  for(const kind of ["codex","claude_code","opencode"] as const){
    const entries=[null,false,{model:"native",value:"native",modelID:"native",providerID:"gateway",capabilities:{tools:true},supportedEffortLevels:"wrong",variants:{},supportedReasoningEfforts:[null,{reasoningEffort:"high"}]}];
    expect(modelOptions(kind,kind === "claude_code" ? {models:entries}:{data:entries})).toMatchObject([{id:kind === "opencode" ? "gateway/native":"native",efforts:kind === "codex" ? ["high"]:[]}]);
  }
});

it("keys probe caches by resolved launch identity without retaining environment secrets",()=>{
  const settings={executable:"/fixture/agent"};
  const launch={executable:settings.executable,env:{PATH:"/fixture/bin",PROVIDER_TOKEN:"synthetic-secret"}};
  const key=agentProbeKey("codex",settings,launch);
  expect(key).toMatch(/^[a-f0-9]{64}$/);expect(key).not.toContain("synthetic-secret");
  expect(agentProbeKey("codex",settings,{...launch,env:{PROVIDER_TOKEN:"synthetic-secret",PATH:"/fixture/bin"}})).toBe(key);
  expect(agentProbeKey("codex",settings,{...launch,env:{...launch.env,PROVIDER_TOKEN:"rotated-synthetic"}})).not.toBe(key);
});
