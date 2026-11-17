import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { launch } from "../../node/src/runner.js";
import { hostCall } from "../../node/src/host.js";
import { loadConfig, safeError } from "../../node/src/storage.js";
import type { Kind, Session, Snapshot } from "../../node/src/types.js";

export function bridgeOutput(snapshot:Snapshot,seen:Map<string,string>):string[] {
  const output:string[]=[],current=new Set<string>();
  const emit=(key:string,value:string)=>{
    // Source content may contain terminal escape sequences, including C1 CSI.
    const text=[...value].filter(char=>char === "\n" || char === "\t" || char.charCodeAt(0)>=32 && !(char.charCodeAt(0)>=127 && char.charCodeAt(0)<=159)).join("");
    const digest=createHash("sha256").update(text).digest("hex");current.add(key);
    if(seen.get(key)!==digest){seen.set(key,digest);if(text)output.push(text);}
  };
  for(const message of snapshot.messages)if(message.role !== "user"){
    const parts=[message.text];
    for(const question of message.questions ?? []){
      parts.push(`${question.key ?? question.header ?? question.title}${question.key || question.header ? `: ${question.title}` : ""}`);
      if(question.detail)parts.push(question.detail);
      parts.push(question.withdrawn ? "请求已撤回" : question.answered !== undefined ? `已回答：${question.answered}` : question.options?.join(" / ") ?? "请输入回答");
    }
    emit(`message:${message.sourceId}`,parts.join("\n"));
  }
  if(snapshot.approval){
    const approval=snapshot.approval,parts=[`审批 ${approval.id}（${approval.status}）: ${approval.action}`];
    if(approval.reason)parts.push(approval.reason);
    for(const option of approval.options ?? [])parts.push(`${option.id}: ${option.label ?? option.kind}${option.detail ? `\n${option.detail}`:""}`);
    if(approval.status === "pending" && approval.options?.length)parts.push(`使用 /approve ${approval.id} <${approval.options.map(option=>option.id).join("|")}>`);
    emit(`approval:${approval.id}`,parts.join("\n"));
  }
  if(snapshot.error)emit("status:error",snapshot.error);
  // Snapshots are already bounded; do not retain every ID from a long session.
  for(const key of seen.keys())if(!current.has(key))seen.delete(key);
  return output;
}

/** User-invoked terminal bridge, not a discovery/attachment operation. */
export async function runBridge(root: string, entry: string, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { agent: { type: "string" }, cwd: { type: "string" }, mode: { type: "string" } } });
  if (!values.agent || !["claude_code", "codex", "opencode"].includes(values.agent) || !values.cwd) throw new Error("Use _bridge --agent <claude_code|codex|opencode> --cwd <absolute-repository> [--mode default]");
  const kind = values.agent as Kind;
  if (!loadConfig(root).agents[kind]) throw new Error("请先在此执行环境的客户端中启用该 Agent");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("这是 MissionGo 本地桥接终端。首条输入后才会创建原生会话；/quit 只退出此终端，/stop 停止当前回合。权限请求须按标识明确回答。");
    const prompt = await input.question("首条消息 > ");
    if (!prompt.trim()) return;
    const job = { dispatchId: `bridge-${randomUUID()}`, itemKeys: [], freeSession: true, repoPath: values.cwd, agentKind: kind, mode: values.mode ?? "default", nodeName: hostname() };
    const state = await launch(root, job, entry, { externalPrompt: prompt });
    if (state.phase !== "launched" || !state.sessionRef) throw new Error(state.launchError ?? "桥接启动未确认");
    console.log(`原生会话 ID: ${state.sessionRef}\n在本会话通过 MissionGo MCP 登记此真实 ID 后，可由已启用的节点接入。不会另建派单或占用派单执行名额。`);
    const seen = new Map<string,string>(); let polling = false;
    const display = async () => {
      if (polling) return; polling = true;
      try {
        const snapshot = await hostCall(root, job.dispatchId);
        for(const text of bridgeOutput(snapshot,seen))console.log(text);
      } catch (error) { console.error(safeError(error)); } finally { polling = false; }
    };
    const timer = setInterval(() => void display(), 1000); await display();
    try {
      for await (const text of input) {
        if (text === "/quit") break;
        const session: Session = { id: job.dispatchId, agentKind: kind, sessionRef: state.sessionRef };
        const approval = /^\/approve ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/.exec(text);
        if (approval) session.approvalDecision = { id: approval[1]!, choice: approval[2]! };
        else if (text === "/stop") {
          const snapshot = await hostCall(root, job.dispatchId);
          const turnId = [...snapshot.messages].reverse().find((message) => message.turnId)?.turnId;
          if (!turnId) { console.error("无法确认当前回合标识，未发送停止"); continue; }
          session.command = { id: randomUUID(), kind: "interrupt", turnId, status: "queued", text: "" };
        } else session.command = { id: randomUUID(), status: "queued", text };
        try { await hostCall(root, job.dispatchId, session); } catch (error) { console.error(safeError(error)); }
        await display();
      }
    } finally { clearInterval(timer); }
  } finally { input.close(); }
}
