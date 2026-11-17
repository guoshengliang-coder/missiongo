import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "./host.js";
import { readSessionHistory } from "./session-history.js";
import { saveBinding } from "./bindings.js";
import { loadConfig, saveConfig } from "./storage.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { Session } from "./types.js";
const roots: string[] = [];
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"mg-history-"))); roots.push(root);
  saveConfig(root,{...loadConfig(root),nodeId:"node",agents:{codex:{},opencode:{}}});
  return root;
}
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("routes bridged history to the exact native binding without synchronizing inputs",async()=>{
  const root=fixture();saveBinding(root,{kind:"codex",sessionRef:"native",nodeId:"node",dispatchId:"original"});
  const history=vi.spyOn(host,"hostHistoryCall").mockResolvedValue({messages:[]});
  const sync=vi.spyOn(host,"hostCall");
  const session:Session={id:"external",agentKind:"codex",sessionRef:"native",externalBindingGeneration:3,command:{id:"queued",text:"never send",status:"queued"}};
  await readSessionHistory(root,session,"cursor");
  expect(history).toHaveBeenCalledExactlyOnceWith(root,"original","native","cursor");expect(sync).not.toHaveBeenCalled();
  await expect(readSessionHistory(root,{...session,sessionRef:"foreign"},"cursor")).rejects.toThrow("unavailable");
  expect(history).toHaveBeenCalledOnce();
});
it("reads OpenCode history using only an exact session attachment",async()=>{
  const root=fixture();const historyPage=vi.fn(async()=>({messages:[]}));
  const attach=vi.spyOn(OpenCodeAdapter,"attach").mockResolvedValue({historyPage} as unknown as OpenCodeAdapter);
  await readSessionHistory(root,{id:"external",agentKind:"opencode",sessionRef:"selected",externalBindingGeneration:4},"cursor");
  expect(attach.mock.calls[0]?.[0]).toBe("selected");expect(historyPage).toHaveBeenCalledExactlyOnceWith("cursor");
});
