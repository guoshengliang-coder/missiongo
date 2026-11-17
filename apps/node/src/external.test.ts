import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as host from "./host.js";
import { API } from "./api.js";
import { saveBinding, findBinding } from "./bindings.js";
import { loadConfig, saveConfig } from "./storage.js";
import { synchronizeExternal } from "./external.js";
import { OpenCodeAdapter, type OpenCodeAPI } from "./opencode.js";
const roots: string[] = [];
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-external-"))); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("binds exact Agent, native identity and node and excludes managed sessions from external attachment", () => {
  const root = temporary(); saveBinding(root, { kind: "codex", sessionRef: "native", nodeId: "node-1", dispatchId: "dispatch" });
  expect(findBinding(root, "codex", "native", "node-1")?.dispatchId).toBe("dispatch");
  expect(findBinding(root, "codex", "native", "node-2")).toBeUndefined();
  expect(findBinding(root, "claude_code", "native", "node-1")).toBeUndefined();
  saveBinding(root, { kind: "codex", sessionRef: "native", nodeId: "node-1", dispatchId: "dispatch", managed: true });
  expect(findBinding(root, "codex", "native", "node-1")).toBeUndefined();
});
it.each(["codex", "claude_code"] as const)("does not discover, start or restore an unbridged %s native id", async (agentKind) => {
  const root = temporary(); saveConfig(root, { ...loadConfig(root), nodeId: "node-1", agents: { [agentKind]: {} } });
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(synchronizeExternal(root, { id: "session", agentKind, sessionRef: "foreign-native" }, new API("https://missiongo.example.com", "fixture"), new AbortController().signal)).rejects.toThrow("不会自动启动");
  expect(fetch).not.toHaveBeenCalled();
});
it("attaches OpenCode using a read of the exact registered session and refuses a different id", async () => {
  const call = vi.fn(async () => ({ data: { id: "native" } }));
  await OpenCodeAdapter.attach("native", { call } as unknown as OpenCodeAPI);
  expect(call).toHaveBeenCalledExactlyOnceWith("GET", "/api/session/native");
  await expect(OpenCodeAdapter.attach("foreign", { call } as unknown as OpenCodeAPI)).rejects.toThrow("identity");
});
it.each([["是", true], ["否", false], ["Yes", true], ["No", false]])("encodes Web boolean answer %s as its native boolean", async (text, expected) => {
  const call = vi.fn(async (method: string, path: string) => {
    if (path.endsWith("/form") && method === "GET") return { data: [{ id: "form", fields: [{ key: "confirm", title: "Confirm", type: "boolean", required: true }] }] };
    if (path.endsWith("/permission")) return { data: [] };
    return { data: { id: "native" } };
  });
  const adapter = await OpenCodeAdapter.attach("native", { call } as unknown as OpenCodeAPI);
  await adapter.deliver({ id: "reply", text: String(text), status: "queued" });
  expect(call).toHaveBeenLastCalledWith("POST", "/api/session/native/form/form/reply", { answer: { confirm: expected } });
  await expect(adapter.deliver({ id: "invalid", text: "not an answer", status: "queued" })).rejects.toThrow("Invalid boolean");
});

it("uses a lightweight read for source permissions, denies Web text grants and still allows stopping",async()=>{
  const root=temporary();saveConfig(root,{...loadConfig(root),nodeId:"node",agents:{codex:{}}});saveBinding(root,{kind:"codex",sessionRef:"native",nodeId:"node",dispatchId:"host"});
  const inspect=vi.spyOn(host,"inspectHost").mockResolvedValue({status:"active",messages:[],externalPermissionProtocol:1,approval:{id:"permission",kind:"native",status:"pending"} as never});
  const deliver=vi.spyOn(host,"hostCall").mockResolvedValue({status:"idle",messages:[],stopConfirmed:true});
  const session={id:"external",sessionRef:"native",agentKind:"codex" as const,command:{id:"input",status:"queued",text:"yes"}};
  await expect(synchronizeExternal(root,session,new API("https://missiongo.example.com"),new AbortController().signal,"control")).rejects.toThrow("Web");expect(deliver).not.toHaveBeenCalled();
  await synchronizeExternal(root,{...session,command:{...session.command,kind:"interrupt",turnId:"turn"}},new API("https://missiongo.example.com"),new AbortController().signal,"control");
  expect(inspect).toHaveBeenCalledTimes(2);expect(deliver).toHaveBeenCalledExactlyOnceWith(root,"host",expect.objectContaining({command:expect.objectContaining({kind:"interrupt"})}),"control");
});

it("requires the atomic source-permission protocol before forwarding external text",async()=>{
  const root=temporary();saveConfig(root,{...loadConfig(root),nodeId:"node",agents:{claude_code:{}}});saveBinding(root,{kind:"claude_code",sessionRef:"native",nodeId:"node",dispatchId:"host"});
  const inspect=vi.spyOn(host,"inspectHost").mockResolvedValue({status:"idle",messages:[]});const deliver=vi.spyOn(host,"hostCall").mockResolvedValue({status:"idle",messages:[]});
  const session={id:"external",sessionRef:"native",agentKind:"claude_code" as const,command:{id:"input",status:"queued",text:"yes"}};
  await expect(synchronizeExternal(root,session,new API("https://missiongo.example.com"),new AbortController().signal,"control")).rejects.toThrow("需更新");expect(deliver).not.toHaveBeenCalled();
  inspect.mockResolvedValue({status:"idle",messages:[],externalPermissionProtocol:1});
  await synchronizeExternal(root,session,new API("https://missiongo.example.com"),new AbortController().signal,"control");
  expect(deliver).toHaveBeenCalledWith(root,"host",expect.objectContaining({terminalPermissionsOnly:true}),"control");
});
