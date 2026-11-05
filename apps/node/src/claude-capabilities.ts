import type { AgentModeCapability } from "@missiongo/domain";
import { randomUUID } from "node:crypto";
import { JsonProcess } from "./process.js";
import type { Wire } from "./types.js";

export function nativeModeResult(mode: string, response: Wire, model?: string): AgentModeCapability {
  const actual=response.response?.mode;
  return {mode,...(model ? {model} : {}),
    state:response.subtype==="success" && actual===mode ? "available"
      : response.subtype==="error" || typeof actual==="string" ? "unavailable" : "unknown",
    ...(actual===mode ? {} : {reason:response.subtype==="error" ? "native_mode_rejected" : "native_mode_unconfirmed"})};
}

/** Isolated control-only probe. No user/model turn, hooks or arbitrary commands. */
export async function probeClaudeCapabilities(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  const rpc=new JsonProcess(executable,["--safe-mode","--strict-mcp-config","--no-chrome","--output-format","stream-json",
    "--verbose","--input-format","stream-json","--permission-mode","plan"],cwd,env);
  const pending=new Map<string,{resolve:(value:Wire)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const call=(request:Wire):Promise<Wire>=>new Promise((resolve,reject)=>{
    const requestId=randomUUID(); const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error("Native mode probe timed out"));},5000);
    pending.set(requestId,{resolve,reject,timer});rpc.write({type:"control_request",request_id:requestId,request});
  });
  rpc.onEvent=event=>{
    const response=event.type==="control_response" ? event.response : undefined;
    const wait=response && pending.get(response.request_id);
    if(wait){pending.delete(response.request_id);clearTimeout(wait.timer);wait.resolve(response);}
  };
  rpc.onClose=()=>{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error("Native probe closed"));}pending.clear();};
  try {
    const initialized=await call({subtype:"initialize"});
    if(initialized.subtype!=="success") throw new Error("Native probe initialization rejected");
    const models=(initialized.response?.models ?? []).filter((model:Wire)=>typeof model.value==="string" && model.value!=="default")
      .slice(0,14).map((model:Wire)=>({id:model.value as string,label:String(model.displayName ?? model.value),efforts:(model.supportedEffortLevels ?? []) as string[]}));
    const modes:AgentModeCapability[]=[];
    for(const mode of ["default","acceptEdits","bypassPermissions","plan","auto"]) modes.push(nativeModeResult(mode,await call({subtype:"set_permission_mode",mode})));
    for(const model of models){
      const changed=await call({subtype:"set_model",model:model.id});
      if(changed.subtype==="success") modes.push(nativeModeResult("auto",await call({subtype:"set_permission_mode",mode:"auto"}),model.id));
    }
    return {models,modes};
  } finally {rpc.child.kill();}
}
